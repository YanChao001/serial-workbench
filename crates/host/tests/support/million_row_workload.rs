use super::*;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    time::{sleep, timeout},
};

const FULL_ARCHIVE: u64 = 1_000_000;
const LINE_BYTES: u64 = 11;
const BURST: u64 = 256;
const PHASE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Input {
    produced: AtomicU64,
    released: AtomicU64,
    last_emitted: Mutex<Option<(u64, Instant)>>,
}
impl Input {
    fn read(&self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        assert!(limit >= LINE_BYTES as usize);
        let next = self.produced.load(Ordering::Relaxed) + 1;
        if next > self.released.load(Ordering::Acquire) {
            std::thread::sleep(wait.min(Duration::from_millis(2)));
            return Ok(ReadBlock {
                bytes: Arc::from([]),
                message: None,
            });
        }
        let text = format!("SWB{next:07}\n");
        assert_eq!(text.len(), LINE_BYTES as usize);
        if next == self.released.load(Ordering::Acquire) {
            *self.last_emitted.lock().unwrap() = Some((next, Instant::now()));
        }
        self.produced.store(next, Ordering::Release);
        Ok(ReadBlock {
            bytes: Arc::from(text.into_bytes()),
            message: Some(MessageFragment {
                message_id: id(&format!("line-{next}")),
                fragment_offset: 0.into(),
                message_length: LINE_BYTES.into(),
                message_type: "line".into(),
            }),
        })
    }
}

struct Browser {
    child: Child,
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
}
impl Browser {
    fn start(repository: &Path, output: &Path) -> Self {
        let mut child = tokio::process::Command::new("node")
            .arg(repository.join("e2e/paired-browser-million-rows.mjs"))
            .arg(output)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            output,
        }
    }

    async fn send(&mut self, value: Value) {
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn receive(&mut self, expected: &str, limit: Duration) -> Value {
        let line = timeout(limit, self.output.next_line())
            .await
            .unwrap_or_else(|_| panic!("Timed out waiting for browser {expected}"))
            .unwrap()
            .unwrap_or_else(|| panic!("Browser exited before {expected}"));
        let reply: Value = serde_json::from_str(&line).expect("Browser evidence message");
        assert_eq!(reply["stage"], expected, "{reply}");
        reply
    }
}

struct Capture {
    owner: Operation,
    reference: ObjectRef,
    destination: ObjectRef,
    path: PathBuf,
    first_line: u64,
}
impl Capture {
    async fn start(host: &Fixture, session: &Target, name: &str, first_line: u64) -> Self {
        let target = host.register(name).await;
        let (owner, reference) = host.start(&host.user, session, &target).await;
        Self {
            owner,
            reference,
            destination: target,
            path: host.dir.path().join(name),
            first_line,
        }
    }

    async fn status(&self, host: &Fixture) -> CaptureStatusResult {
        let query = host.query(
            &host.user,
            "capture.status",
            host.reference_target(&self.reference),
            json!({"captureRef":self.reference}),
        );
        let RpcResult::Query(QueryResult::CaptureStatus(status)) =
            success(host.user.request(RpcRequest::Query(query)).await.unwrap())
        else {
            panic!("Expected current capture watermarks");
        };
        if status.summary.state != CaptureState::Recording {
            let owner = host
                .store
                .get(&host.operator, &self.owner.operation_id)
                .unwrap();
            panic!(
                "Expected a recording capture: {status:?}, terminal error: {:?}",
                owner.error
            );
        }
        status
    }

    async fn stop(self, host: &Fixture, last_line: u64) -> CaptureStatusResult {
        let stop = host
            .invoke(
                &host.user,
                "capture.stop",
                host.reference_target(&self.reference),
                json!({"captureRef":self.reference}),
            )
            .await;
        let stop = host.wait_with_timeout(&stop, false, PHASE_TIMEOUT).await;
        assert_eq!(stop.state, OperationState::Succeeded, "{:?}", stop.error);
        let owner = host
            .wait_with_timeout(&self.owner, false, PHASE_TIMEOUT)
            .await;
        assert_eq!(owner.state, OperationState::Succeeded, "{:?}", owner.error);
        let Some(ActionResult::CaptureStatus(status)) = owner.result else {
            panic!("Expected sealed capture receipt");
        };
        let expected = last_line - self.first_line + 1;
        assert_eq!(status.summary.state, CaptureState::Complete);
        assert!(status.summary.container_complete && status.summary.source_continuous);
        assert_eq!(status.summary.watermarks.verified.get(), expected);
        status
    }
}

struct BurstTiming {
    emitted: Instant,
    written_us: u64,
    synced_us: Option<u64>,
}

async fn write_burst(
    host: &Fixture,
    capture: &Capture,
    input: &Input,
    last_line: u64,
    observe_sync: bool,
) -> BurstTiming {
    let expected = last_line - capture.first_line + 1;
    input.released.store(last_line, Ordering::Release);
    timeout(QUERY_TIMEOUT, async {
        let mut written = None;
        loop {
            let watermarks = capture.status(host).await.summary.watermarks;
            if watermarks.written.get() >= expected {
                assert_eq!(watermarks.written.get(), expected);
                let (ordinal, emitted) = input.last_emitted.lock().unwrap().unwrap();
                assert_eq!(ordinal, last_line);
                let elapsed = emitted.elapsed().as_micros() as u64;
                let written_us = *written.get_or_insert(elapsed);
                if !observe_sync || watermarks.synced.get() >= expected {
                    return BurstTiming {
                        emitted,
                        written_us,
                        synced_us: observe_sync.then_some(elapsed),
                    };
                }
            }
            sleep(Duration::from_millis(8)).await;
        }
    })
    .await
    .expect("Expected live written and sampled durable watermarks")
}

struct RawSearchMeasurement {
    started: Instant,
    matched: Instant,
    hit: ReplaySearchHit,
    pages: u64,
}

async fn search_during_scroll(host: &Fixture, target: &Target, line: u64) -> RawSearchMeasurement {
    let raw = host.user.connect_raw().await.unwrap();
    let text = format!("SWB{line:07}");
    let search_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    let encoded = STANDARD.encode(&text);
    let mut command = ReplaySearchCommand::Start {
        search_id: search_id.clone(),
        bytes_base64: Bytes::try_from(encoded.as_str()).unwrap(),
        direction: Some(Direction::Rx),
    };
    let started = Instant::now();
    let mut pages: u64 = 0;
    let mut scanned = 0;
    let hit = loop {
        let request = host.query(
            &host.user,
            "replay.search",
            target.clone(),
            json!({
                "sessionId":target.session_id,
                "sessionEpoch":target.session_epoch,
                "command":command,
            }),
        );
        let RpcResult::Query(QueryResult::ReplaySearch(ReplaySearchResult::Page {
            result, ..
        })) = success(raw.request(RpcRequest::Query(request)).await.unwrap())
        else {
            panic!("Expected Raw search page");
        };
        pages += 1;
        if let [hit] = result.hits.as_slice() {
            assert_eq!(hit.first_record.get(), line);
            assert_eq!(hit.last_record.get(), line);
            assert_eq!(hit.byte_start.get(), (line - 1) * LINE_BYTES);
            assert_eq!(
                hit.byte_end.get(),
                (line - 1) * LINE_BYTES + text.len() as u64
            );
            break hit.clone();
        }
        assert!(result.hits.is_empty() && !result.complete);
        assert!(result.scanned_records.get() > scanned);
        scanned = result.scanned_records.get();
        command = ReplaySearchCommand::Next {
            search_id: search_id.clone(),
            page: PositiveU64::try_from(U64::from(pages + 1)).unwrap(),
        };
    };
    let matched = Instant::now();
    raw.close().await.unwrap();
    RawSearchMeasurement {
        started,
        matched,
        hit,
        pages,
    }
}

async fn metrics(host: &Fixture) -> HostMetrics {
    let query = host.query(&host.control, "host.metrics", host.host(), json!({}));
    let RpcResult::Query(QueryResult::HostMetrics(metrics)) = success(
        host.control
            .request(RpcRequest::Query(query))
            .await
            .unwrap(),
    ) else {
        panic!("Expected live Host metrics");
    };
    metrics
}

#[tokio::test]
#[ignore = "Requires built web assets, headless Chromium and SWB_MILLION_ROWS_OUTPUT"]
async fn paired_browser_million_rows_search_scroll_and_record_together() {
    let output = PathBuf::from(
        std::env::var_os("SWB_MILLION_ROWS_OUTPUT").expect("Benchmark evidence directory"),
    );
    std::fs::create_dir_all(&output).unwrap();
    let records = std::env::var("SWB_MILLION_ROWS_PILOT")
        .map(|value| {
            let records = value.parse::<u64>().unwrap();
            assert!((512..FULL_ARCHIVE).contains(&records));
            records
        })
        .unwrap_or(FULL_ARCHIVE);
    let clock = Arc::new(support::ManualClock(AtomicU64::new(0)));
    let input = Arc::new(Input::default());
    let producer = input.clone();
    let probe = Arc::new(support::Probe {
        read_source: Some(Box::new(move |limit, wait| producer.read(limit, wait))),
        ..support::Probe::default()
    });
    let host =
        Fixture::with_device(false, None, Some(support::scripted_opener(probe, clock))).await;
    use futures_util::FutureExt;
    let check = std::panic::AssertUnwindSafe(run(&host, &input, &output, records))
        .catch_unwind()
        .await;
    host.finish().await;
    if let Err(failure) = check {
        std::panic::resume_unwind(failure);
    }
}

async fn run(host: &Fixture, input: &Input, output: &Path, records: u64) {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let assets = repository
        .join("dist-web")
        .canonicalize()
        .expect("Build dist-web");
    let settings = serial_workbench_host::settings::SettingsService::new(host.store.clone());
    let current = settings.read().unwrap();
    settings
        .save(
            current.revision,
            SharedSettings {
                language: Language::En,
                ..current.value
            },
        )
        .unwrap();

    let device = host.target("device", "virtual:echo");
    let opened = host
        .action(
            &host.user,
            "device.open",
            device,
            json!({
                "configuration":SerialConfiguration::default()
            }),
        )
        .await;
    let Some(ActionResult::Opened(session)) = &opened.result else {
        panic!(
            "Expected scripted transport on the visible device: {:?}",
            opened.error
        );
    };
    let mut session_target = host.target("session", session.session_id.as_str());
    session_target.session_id = Some(session.session_id.clone());
    session_target.session_epoch = Some(session.session_epoch);

    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(
        host.control
            .request(RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
                assets_dir: assets.to_str().unwrap().into(),
                mode: BrowserAccessMode::Operate,
            }))
            .await
            .unwrap(),
    )
    else {
        panic!("Expected browser pairing");
    };
    host.auth
        .authorize(
            &host.operator,
            AuthorizeParams {
                client_id: entry.client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "workspace.modify".into(),
                ],
                targets: vec![host.host()],
                expires_at: None,
            },
        )
        .unwrap();

    let mut browser = Browser::start(&repository, output);
    browser
        .send(json!({
            "kind":"pair",
            "url":entry.url,
            "pairingCode":entry.pairing_code,
            "liveOperationId":opened.operation_id,
            "records":records,
            "lineBytes": LINE_BYTES
        }))
        .await;
    browser.receive("live-ready", QUERY_TIMEOUT).await;

    let archive = Capture::start(host, &session_target, "million-archive.swbc", 1).await;
    let archive_path = archive.path.clone();
    eprintln!("live capture started; archive target has {records} lines");
    let mut written = Vec::new();
    let mut durable = Vec::new();
    let mut live_display = Vec::new();
    let mut resource_samples = vec![metrics(host).await];
    let live_started = Instant::now();
    let mut next_sample = 1;
    let mut last = 0;
    while last < records {
        last = (last + BURST).min(records);
        if last >= next_sample || last == records {
            browser
                .send(json!({"kind":"live-sample","line":last}))
                .await;
            let view = async {
                let answer = browser.receive("live-visible", QUERY_TIMEOUT).await;
                assert_eq!(answer["line"], last);
                Instant::now()
            };
            let (timing, visible) =
                tokio::join!(write_burst(host, &archive, input, last, true), view);
            written.push(timing.written_us);
            durable.push(timing.synced_us.unwrap());
            live_display.push(visible.duration_since(timing.emitted).as_micros() as u64);
            resource_samples.push(metrics(host).await);
            eprintln!("observed line {last}/{records}");
            next_sample = last + (records / 20).max(1);
        } else {
            written.push(
                write_burst(host, &archive, input, last, false)
                    .await
                    .written_us,
            );
        }
    }
    let live_ms = live_started.elapsed().as_millis() as u64;
    let archive_authority = host.reference_target(&archive.destination);
    let sealed = archive.stop(host, records).await;
    host.auth
        .authorize(
            &host.operator,
            AuthorizeParams {
                client_id: entry.client_id.clone(),
                permissions: vec!["metadata.read".into(), "content.read".into()],
                targets: vec![archive_authority],
                expires_at: None,
            },
        )
        .unwrap();
    eprintln!("live archive sealed; opening replay");
    let accepted = host
        .invoke(
            &host.user,
            "replay.open",
            host.reference_target(&sealed.capture_ref),
            json!({
                "captureRef":sealed.capture_ref,"mode":"fastest"
            }),
        )
        .await;
    let replay = host
        .wait_with_timeout(&accepted, false, PHASE_TIMEOUT)
        .await;
    let Some(ActionResult::Opened(replayed)) = &replay.result else {
        panic!("Expected sealed replay: {:?}", replay.error);
    };
    let mut replay_target = host.target("session", replayed.session_id.as_str());
    replay_target.session_id = Some(replayed.session_id.clone());
    replay_target.session_epoch = Some(replayed.session_epoch);

    let concurrent = Capture::start(
        host,
        &session_target,
        "concurrent-recording.swbc",
        records + 1,
    )
    .await;
    let concurrent_path = concurrent.path.clone();
    let done = AtomicBool::new(false);
    let browser_task = async {
        browser
            .send(json!({"kind":"archive","operationId":replay.operation_id}))
            .await;
        let mut ranges = Vec::new();
        for stage in ["scroll", "search"] {
            let started = format!("{stage}-start");
            browser.receive(&started, PHASE_TIMEOUT).await;
            eprintln!("browser {stage} started during capture");
            let before = concurrent.status(host).await.summary.watermarks.written;
            let started_at = Instant::now();
            browser.send(json!({"kind":"continue","stage":stage})).await;
            let browser_finished = async {
                let reply = browser
                    .receive(&format!("{stage}-done"), PHASE_TIMEOUT)
                    .await;
                let finished_at = Instant::now();
                let after = concurrent.status(host).await.summary.watermarks.written;
                assert!(
                    after > before,
                    "Recorder did not advance during browser {stage}"
                );
                (reply, after, finished_at)
            };
            let raw_search = async {
                if stage == "scroll" {
                    let line = (records / 4).max(17);
                    Some(search_during_scroll(host, &replay_target, line).await)
                } else {
                    None
                }
            };
            let ((reply, after, finished_at), raw_search) =
                tokio::join!(browser_finished, raw_search);
            let search = raw_search.map(|measured| {
                assert!(measured.started < finished_at && measured.matched > started_at);
                json!({
                    "hit": measured.hit,
                    "pages": measured.pages,
                    "queryStartedAfterStageUs": measured.started.duration_since(started_at).as_micros() as u64,
                    "matchedAfterStageUs": measured.matched.duration_since(started_at).as_micros() as u64,
                })
            });
            ranges.push(json!({
                "stage":stage,
                "writtenBefore":before,
                "writtenAfter":after,
                "browserStageUs":finished_at.duration_since(started_at).as_micros() as u64,
                "rawSearch":search,
                "browser":reply,
            }));
        }
        done.store(true, Ordering::Release);
        ranges
    };
    let recorder_task = async {
        let mut last = records;
        let mut samples = Vec::new();
        while !done.load(Ordering::Acquire) {
            last += 64;
            assert!(
                last - records <= 300_000,
                "Concurrent fixture exceeded its capture quota"
            );
            let sampled = (last - records).is_multiple_of(1024);
            let timing = write_burst(host, &concurrent, input, last, sampled).await;
            written.push(timing.written_us);
            if let Some(elapsed) = timing.synced_us {
                durable.push(elapsed);
            }
            if (last - records).is_multiple_of(1024) {
                samples.push(metrics(host).await);
            }
            sleep(Duration::from_millis(160)).await;
        }
        (last, samples)
    };
    let (overlap, (last, samples)) = tokio::join!(browser_task, recorder_task);
    resource_samples.extend(samples);
    resource_samples.push(metrics(host).await);
    let concurrent_sealed = concurrent.stop(host, last).await;
    browser.send(json!({"kind":"finish"})).await;
    browser.receive("closed", QUERY_TIMEOUT).await;
    assert!(
        timeout(QUERY_TIMEOUT, browser.child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );

    let evidence = json!({
        "archiveRecords": records,
        "concurrentRecords": last - records,
        "source": session_target,
        "sealed": sealed,
        "concurrentSealed": concurrent_sealed,
        "liveCaptureMs": live_ms,
        "liveDisplayUs": live_display,
        "writtenBurstTailUs": written,
        "syncedBurstTailUs": durable,
        "hostMetrics": resource_samples,
        "overlap": overlap,
    });
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.join("host-receipt.json"))
        .unwrap();
    writeln!(file, "{}", serde_json::to_string_pretty(&evidence).unwrap()).unwrap();

    for (name, capture, first, last) in [
        ("archive", archive_path, 1, records),
        ("concurrent", concurrent_path, records + 1, last),
    ] {
        let status = timeout(
            PHASE_TIMEOUT,
            tokio::process::Command::new("node")
                .arg(repository.join("scripts/test-million-row-readback.mjs"))
                .arg(capture)
                .arg(first.to_string())
                .arg(last.to_string())
                .arg(output.join(format!("{name}-readback.json")))
                .kill_on_drop(true)
                .status(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(status.success(), "Independent readback {name}: {status}");
    }
}
