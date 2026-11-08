use super::{
    client::*,
    containment::rss,
    evidence::{Case, percentile, write_json},
    process::{Processes, Result, checked},
    scenarios::*,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serial_workbench_client::HostClient;
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    io::Write,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

struct Fast {
    bytes: u64,
    hash: String,
    next: u64,
}
pub(super) async fn run(
    case: &mut Case,
    processes: &mut Processes,
    profile: &Path,
    host_index: usize,
    user: &HostClient,
    control: &HostClient,
) -> Result<Value> {
    let session = open(user, "harness:producer").await?;
    let fast = Arc::new(connect(profile, "scenario-user", ClientKind::Desktop).await?);
    let fast_raw = checked(fast.connect_raw().await)?;
    let observed = Arc::new(AtomicU64::new(0));
    let finish = Arc::new(AtomicBool::new(false));
    let observer = observed.clone();
    let done = finish.clone();
    let fast_target = session.clone();
    let fast_task = tokio::spawn(async move {
        let mut next = 1;
        let mut bytes = 0;
        let mut hash = Sha256::new();
        loop {
            let result=raw_ask(&fast,&fast_raw,"stream.read",&fast_target,json!({"sessionId":fast_target.id,"sessionEpoch":fast_target.session_epoch,"startEventSeq":next.to_string(),"maxEvents":"100","maxBytes":"262144"})).await?;
            let QueryResult::StreamRead(read) = result else {
                return Err("Fast reader missing stream.read result".into());
            };
            for event in &read.events {
                if event.event_seq.get() != next {
                    return Err(format!("Fast source event continuity lost at {next}"));
                }
                next += 1;
                match &event.payload {
                    RawPayload::Rx(rx) => {
                        let block = checked(STANDARD.decode(rx.bytes_base64.as_str()))?;
                        if rx.byte_start.get() != bytes
                            || rx.byte_end.get() != bytes + block.len() as u64
                        {
                            return Err("Fast RX byte offsets are discontinuous".into());
                        }
                        for (index, byte) in block.iter().enumerate() {
                            if *byte != ((bytes + index as u64) % 251) as u8 {
                                return Err(
                                    "Fast independent deterministic byte/hash input mismatch"
                                        .into(),
                                );
                            }
                        }
                        bytes += block.len() as u64;
                        hash.update(&block);
                        observer.store(bytes, Ordering::SeqCst);
                    }
                    RawPayload::Gap(gap) => return Err(format!("Fast source lost data: {gap:?}")),
                    _ => {}
                }
            }
            if done.load(Ordering::SeqCst) && !read.has_more {
                break;
            }
            if !read.has_more {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        Ok::<_, String>(Fast {
            bytes,
            hash: format!("{:x}", hash.finalize()),
            next,
        })
    });
    // The slow reader withholds credit for the measured interval, so its actual
    // bounded Host queue must overflow independently of the fast reader/capture.
    let slow = checked(user.connect_raw().await)?;
    let QueryResult::StreamCursor(mut cursor) =
        raw_ask(user, &slow, "stream.cursor", &session, json!({})).await?
    else {
        return Err("Slow cursor missing".into());
    };
    cursor.cursor.position = 0.into();
    let QueryResult::StreamSubscribe(subscription)=raw_ask(user,&slow,"stream.subscribe",&session,json!({"scopeId":cursor.cursor.scope_id,"after":cursor.cursor,"queueBytes":"131072","initialCreditBytes":"0","overflowPolicy":"drop_with_gap"})).await? else{return Err("Slow subscription missing".into());};
    let mut slow_ack = cursor.cursor.clone();
    let mut slow_grant = 0_u64;
    let mut slow_bytes = 0_u64;
    let mut slow_batches = Vec::new();
    let mut gaps = Vec::new();
    let destination = register(control, &processes.log_dir.join("T06-capture")).await?;
    let (capture_owner, capture) = start_capture(user, &session, &destination).await?;
    let started = Instant::now();
    let mut samples = Vec::new();
    let mut raw_samples = checked(
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(processes.log_dir.join("T06-samples.jsonl")),
    )?;
    case.artifact("T06-samples.jsonl");
    let mut peaks = [0_u64; 3];
    let pid = processes.children[host_index].record.pid;
    let mut sample = |metrics: HostMetrics, elapsed: f64, latency: f64| -> Result<()> {
        if metrics.process_id.get() != u64::from(pid)
            || metrics.host_id != user.attachment().host_id
            || metrics.instance_epoch != user.attachment().instance_epoch
        {
            return Err("host.metrics identity does not match the owned Host process".into());
        }
        for (index, budget) in [&metrics.source, &metrics.reader, &metrics.capture_queue]
            .iter()
            .enumerate()
        {
            if budget.used_bytes > budget.peak_bytes || budget.peak_bytes > budget.limit_bytes {
                return Err("Host memory budget exceeded or metric ordering invalid".into());
            }
            peaks[index] = peaks[index].max(budget.peak_bytes.get());
        }
        let host_rss = rss(pid)?;
        let client_rss = rss(std::process::id())?;
        let value = json!({"elapsedSeconds":elapsed,"processTreeRssBytes":host_rss+client_rss,"sourceQueueBytes":metrics.source.used_bytes.get(),"readerQueueBytes":metrics.reader.used_bytes.get(),"captureQueueBytes":metrics.capture_queue.used_bytes.get(),"controlLatencyMs":latency,"bytesObserved":observed.load(Ordering::SeqCst),"ownedProcesses":[{"pid":pid,"role":"Host","rssBytes":host_rss},{"pid":std::process::id(),"role":"actual Rust clients","rssBytes":client_rss}],"hostMetrics":metrics});
        checked(raw_samples.write_all(&checked(serde_json::to_vec(&value))?))?;
        checked(raw_samples.write_all(b"\n"))?;
        samples.push(value);
        Ok(())
    };
    for second in 0..=600_u64 {
        tokio::time::sleep_until(tokio::time::Instant::from_std(
            started + Duration::from_secs(second),
        ))
        .await;
        let sent = Instant::now();
        let metric = ask(user, "host.metrics", &host_target(user), json!({})).await?;
        let latency = sent.elapsed().as_secs_f64() * 1000.;
        let QueryResult::HostMetrics(metric) = metric else {
            return Err("host.metrics has no real telemetry response".into());
        };
        sample(metric, started.elapsed().as_secs_f64(), latency)?;
        if fast_task.is_finished() {
            return Err("Fast reader ended before the 600-second workload".into());
        }
        if second > 0 && second % 10 == 0 {
            // Acknowledge the last actual batch without increasing the cumulative
            // grant, then refill exactly one 4KiB window using the Host's actual
            // acknowledged byte counter. This obeys cumulative credit semantics.
            let QueryResult::StreamCredit(credit)=raw_ask(user,&slow,"stream.credit",&session,json!({"subscriptionId":subscription.subscription_id,"ackCursor":slow_ack,"grantedBytesTotal":slow_grant.to_string()})).await? else{return Err("Slow reader ACK result missing".into());};
            slow_grant = credit.acknowledged_bytes_total.get() + 4096;
            raw_ask(user,&slow,"stream.credit",&session,json!({"subscriptionId":subscription.subscription_id,"ackCursor":slow_ack,"grantedBytesTotal":slow_grant.to_string()})).await?;
            let frame = checked(checked(
                tokio::time::timeout(Duration::from_secs(1), slow.next_event()).await,
            )?)?
            .ok_or("Slow reader ended without gap evidence")?;
            let IpcMessage::RawBatch { batch } = frame.body else {
                return Err("Slow reader returned a non-batch event".into());
            };
            for item in &batch.items {
                match item {
                    StreamItem::ReaderGap { gap } => gaps.push(gap.clone()),
                    StreamItem::Source { event } => {
                        slow_bytes += rx(std::slice::from_ref(event.as_ref()))?.len() as u64
                    }
                }
            }
            slow_ack = batch.cursor.clone();
            slow_batches.push(*batch);
        }
    }
    checked(std::fs::write(
        processes.log_dir.join("producer-stop"),
        b"stop independent generation",
    ))?;
    let stopped = processes.log_dir.join("producer-stopped.json");
    checked(
        tokio::time::timeout(Duration::from_secs(2), async {
            while !stopped.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await,
    )?;
    let produced: Value = checked(serde_json::from_slice(&checked(std::fs::read(stopped))?))?;
    let generated = produced["generated"]
        .as_u64()
        .ok_or("Producer missing generated counter")?;
    checked(
        tokio::time::timeout(Duration::from_secs(2), async {
            while observed.load(Ordering::SeqCst) < generated {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await,
    )?;
    let sent = Instant::now();
    let QueryResult::HostMetrics(metric) =
        ask(user, "host.metrics", &host_target(user), json!({})).await?
    else {
        return Err("Final metrics absent".into());
    };
    sample(
        metric,
        started.elapsed().as_secs_f64(),
        sent.elapsed().as_secs_f64() * 1000.,
    )?;
    let elapsed = started.elapsed().as_secs_f64();
    write_json(&processes.log_dir.join("T06-samples.json"), &samples)?;
    case.artifact("T06-samples.json");
    let finalized = stop_capture(user, &capture).await?;
    let captured_owner = settled(user, &capture_owner, false).await?;
    action(user, "session.close", &session, json!({})).await?;
    finish.store(true, Ordering::SeqCst);
    let fast = checked(checked(
        tokio::time::timeout(Duration::from_secs(5), fast_task).await,
    )?)??;
    let probe: Value = checked(serde_json::from_slice(&checked(std::fs::read(
        processes.log_dir.join("producer-probe.json"),
    ))?))?;
    write_json(
        &processes.log_dir.join("T06-slow-batches.json"),
        &slow_batches,
    )?;
    case.artifact("T06-slow-batches.json");
    case.check("slow_reader_isolated",!gaps.is_empty()&&fast.bytes==generated&&slow_bytes<fast.bytes&&!slow_batches.is_empty(),json!({"policy":"drop_with_gap","readCadenceSeconds":10,"creditWindowBytes":4096,"slowQueueBytes":131072,"batchCount":slow_batches.len(),"slowBytesObserved":slow_bytes,"fastObserved":fast.bytes,"hostPeaks":peaks,"gaps":gaps}))?;
    let latencies: Vec<f64> = samples
        .iter()
        .map(|s| s["controlLatencyMs"].as_f64().expect("own numeric sample"))
        .collect();
    let responsive = elapsed >= 600.
        && samples.len() >= 601
        && samples.windows(2).all(|p| {
            let a = p[0]["elapsedSeconds"].as_f64().expect("sample");
            let b = p[1]["elapsedSeconds"].as_f64().expect("sample");
            b > a && b - a <= 3.
        });
    case.check("control_responsive",responsive,json!({"configuredSeconds":600,"elapsedSeconds":elapsed,"completedQueries":latencies.len(),"method":"monotonic send-to-response; no unspecified performance cutoff","p50Ms":percentile(&latencies,0.5),"p95Ms":percentile(&latencies,0.95),"p99Ms":percentile(&latencies,0.99)}))?;
    let scan = checked(serial_workbench_host::capture::verify::verify_directory(
        &processes.log_dir.join("T06-capture"),
    ))?;
    // Independent production-format replay checks each captured RX byte against
    // its original producer offset; the capture starts after session creation.
    let mut replay = checked(serial_workbench_host::capture::replay::ReplayReader::open(
        &processes.log_dir.join("T06-capture"),
        ReplayMode::Fastest,
    ))?;
    let mut capture_bytes = 0;
    let mut capture_hash = Sha256::new();
    let mut next_offset = None;
    loop {
        let read = checked(replay.read(100, 0))?;
        for item in read.records {
            if let ReplayRecord::Inline { record } = item
                && let CaptureEntry::Event(event) = record.entry
                && let RawPayload::Rx(rx) = event.payload
            {
                let bytes = checked(STANDARD.decode(rx.bytes_base64.as_str()))?;
                if next_offset.is_some_and(|next| next != rx.byte_start.get()) {
                    return Err("Capture RX prefix has a byte gap".into());
                }
                for (i, b) in bytes.iter().enumerate() {
                    if *b != ((rx.byte_start.get() + i as u64) % 251) as u8 {
                        return Err("Independent capture hash input mismatch".into());
                    }
                }
                next_offset = Some(rx.byte_end.get());
                capture_bytes += bytes.len() as u64;
                capture_hash.update(bytes);
            }
        }
        if read.at_end {
            break;
        }
    }
    case.check("loss_accounted",probe["producer"]["generated"].as_u64()==Some(fast.bytes)&&probe["producer"]["delivered"].as_u64()==Some(fast.bytes)&&probe["producer"]["dropped"].as_u64()==Some(0)&&probe["producer"]["pending"].as_u64()==Some(0)&&produced["generatedSha256"].as_str()==Some(fast.hash.as_str())&&scan.report.container_complete&&scan.report.source_continuous&&capture_bytes>0&&next_offset==Some(fast.bytes),json!({"independentProducer":probe,"fast":{"bytes":fast.bytes,"sha256":fast.hash,"nextEventSeq":fast.next},"capture":{"bytes":capture_bytes,"sha256":format!("{:x}",capture_hash.finalize()),"lastSourceOffset":next_offset,"verification":scan.report,"finalized":finalized,"owner":captured_owner},"slowGaps":gaps}))?;
    case.artifact("producer-probe.json");
    case.artifact("T06-capture/manifest.json");
    Ok(
        json!({"durationSeconds":600,"elapsedSeconds":elapsed,"sampleCount":samples.len(),"samples":"T06-samples.json","sources":{"rss":"OS RSS for the owned Host PID and actual Rust client process; Host self-reported host.metrics RSS retained in every sample","queues":"production host.metrics source/reader/captureQueue memory budget owners","controlLatency":"Rust client Instant send-to-response host.metrics; milliseconds; nearest-rank percentiles"},"processTreeRssBytesPeak":samples.iter().map(|s|s["processTreeRssBytes"].as_u64().expect("sample")).max(),"sourceQueueBytesPeak":peaks[0],"readerQueueBytesPeak":peaks[1],"captureQueueBytesPeak":peaks[2],"bytesProduced":generated,"bytesObserved":fast.bytes,"controlLatencyMs":{"p50":percentile(&latencies,0.5),"p95":percentile(&latencies,0.95),"p99":percentile(&latencies,0.99)}}),
    )
}
