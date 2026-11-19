use super::{
    client::*,
    evidence::write_json,
    node_package,
    process::{Result, checked},
    scenarios::tx,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::{Value, json};
use serial_workbench_client::{HostClient, RawConnection};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const PACKAGE: &str = "example.t06";
const ACTION: &str = "example.t06.parse";
const STOP: &[u8] = b"SWB-T06-STOP";

#[derive(Debug, PartialEq)]
pub(super) struct Inputs {
    pub runtime: PathBuf,
    pub parser: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParserResult {
    bytes: U64,
    sha256: Digest,
    published: U64,
}

pub(super) struct Parser {
    operation: Operation,
    target: Target,
    reader: HostClient,
    raw: RawConnection,
    slow_owner: HostClient,
    slow: RawConnection,
    last: u64,
    byte_end: u64,
    slow_after: u64,
    archive_sha256: Digest,
    configuration_sha256: Digest,
    file: std::fs::File,
}

pub(super) async fn install(
    user: &HostClient,
    control: &HostClient,
    script: &Path,
    log_dir: &Path,
) -> Result<Digest> {
    let mut backend = Vec::new();
    checked(
        checked(std::fs::File::open(script))?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut backend),
    )?;
    if backend.is_empty() || backend.len() > 1024 * 1024 {
        return Err("Invalid compiled T06 parser size".into());
    }
    let mut files = node_package::payloads();
    let mut manifest = node_package::manifest();
    manifest["id"] = json!(PACKAGE);
    manifest["displayName"] = json!("T06 parser load fixture");
    manifest["description"] = json!("Derives byte counts for a sourced RX range");
    manifest["permissions"]["hostApi"] =
        json!([{"permissions":["content.read"],"targetKinds":["session"]}]);
    let mut spec = BuiltinAction::HostShutdown.spec().clone();
    spec.action_id = id(ACTION);
    spec.target_kinds = vec![checked(ResourceKind::try_from("session"))?];
    spec.permissions = vec!["content.read".into()];
    spec.cancellation = Cancellation::Cooperative;
    spec.state_scopes.clear();
    spec.event_types.clear();
    spec.reveal_target = checked(serde_json::from_value(json!({"pageId":"workbench"})))?;
    spec.input_schema = checked(serde_json::from_value(
        json!({"type":"object","additionalProperties":false}),
    ))?;
    spec.output_schema = checked(serde_json::from_value(json!({
        "type":"object","properties":{
            "bytes":{"type":"string","pattern":"^[0-9]+$"},
            "published":{"type":"string","pattern":"^[0-9]+$"},
            "sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}
        },"required":["bytes","published","sha256"],"additionalProperties":false
    })))?;
    manifest["contributes"]["actions"] = json!([spec]);
    files.insert(
        "manifest.json".into(),
        checked(serde_json::to_vec(&manifest))?,
    );
    files.insert("dist/main.mjs".into(), backend);
    let archive = node_package::archive(&node_package::with_metadata(files, true));
    let local_digest = format!("{:x}", Sha256::digest(&archive));
    let path = log_dir.join("T06-parser.zip");
    let mut output = checked(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path),
    )?;
    checked(output.write_all(&archive))?;
    checked(output.sync_all())?;
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    change(control,"node.sources.approveKey",0,json!({
        "source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":format!("{:x}",Sha256::digest(key))
    })).await?;
    action(control,"auth.authorize",&host_target(control),json!({
        "clientId":user.attachment().client_id,"permissions":["plugins.manage"],"targets":[host_target(user)]
    })).await?;
    let registered = action(
        control,
        "file.register",
        &host_target(control),
        json!({
            "path":path.to_str().ok_or("Parser archive path is not UTF-8")?,"purpose":"read_file"
        }),
    )
    .await?;
    let Some(ActionResult::FileMetadata(file)) = registered.result else {
        return Err("Parser archive was not registered".into());
    };
    let installed = change(user,"node.packages.install",0,json!({
        "archiveRef":file.file_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}
    })).await?;
    let Some(ActionResult::NodePackageInstalled(result)) = installed.result else {
        return Err("Parser package was not installed".into());
    };
    let archive_sha256 = result.package.archive_sha256;
    if archive_sha256.as_str() != local_digest {
        return Err("Installed parser archive digest differs".into());
    }
    change(
        control,
        "node.packages.confirmExecutionTrust",
        1,
        json!({"id":PACKAGE,"archiveSha256":archive_sha256}),
    )
    .await?;
    change(
        user,
        "node.packages.setEnabled",
        2,
        json!({"id":PACKAGE,"archiveSha256":archive_sha256,"enabled":true}),
    )
    .await?;
    Ok(archive_sha256)
}

async fn change(client: &HostClient, id: &str, revision: u64, params: Value) -> Result<Operation> {
    let mut command = call(client, id, &host_target(client), params)?;
    command.expected_revision = Some(revision.into());
    let accepted = dispatch(client, command).await?;
    let done = settled(client, &accepted, false).await?;
    if done.state != OperationState::Succeeded {
        return Err(format!("{} failed: {:?}", done.action_id, done.error));
    }
    Ok(done)
}

async fn dispatch(client: &HostClient, command: Call) -> Result<Operation> {
    let RpcResult::Operation(accepted) =
        success(checked(client.request(RpcRequest::Invoke(command)).await)?)?
    else {
        return Err("Expected Node action acceptance".into());
    };
    Ok(accepted.operation)
}

impl Parser {
    pub(super) async fn start(
        user: &HostClient,
        profile: &Path,
        target: &Target,
        archive_sha256: Digest,
        log_dir: &Path,
    ) -> Result<Self> {
        let mut command = call(user, "host.shutdown", &host_target(user), json!({}))?;
        command.action_id = id(ACTION);
        command.target = target.clone();
        command.reveal_target = checked(serde_json::from_value(
            json!({"pageId":"workbench","sessionId":target.id}),
        ))?;
        command.execution_mode = Some(ExecutionMode::Independent);
        let initial = dispatch(user, command).await?;
        checked(
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let current = operation(user, &initial).await?;
                    if current.state.is_terminal() {
                        return Err(format!("Parser ended before input: {current:?}"));
                    }
                    if current.state == OperationState::Running && current.progress.is_some() {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await,
        )??;
        let reader = connect(profile, "scenario-user", ClientKind::Desktop).await?;
        let raw = checked(reader.connect_raw().await)?;
        let slow_owner = connect(profile, "scenario-user", ClientKind::Desktop).await?;
        let slow = checked(slow_owner.connect_raw().await)?;
        // Raw 附接依附其控制连接。将第二个控制连接与 reader 一起保活。
        let file = checked(
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(log_dir.join("T06-derived.jsonl")),
        )?;
        Ok(Self {
            operation: initial,
            target: target.clone(),
            reader,
            raw,
            slow,
            slow_owner,
            last: 0,
            byte_end: 0,
            slow_after: 0,
            archive_sha256,
            configuration_sha256: checked(Digest::try_from(
                format!("{:x}", Sha256::digest(b"{}")).as_str(),
            ))?,
            file,
        })
    }

    pub(super) async fn collect(&mut self) -> Result<()> {
        loop {
            let page = match self.page(&self.reader, &self.raw, self.last).await {
                Err(error) if self.last == 0 && error.code == "NOT_FOUND" => return Ok(()),
                other => checked(other)?,
            };
            if page.operation_id != self.operation.operation_id
                || page.instance_epoch != self.reader.attachment().instance_epoch
            {
                return Err("Derived page refers to another Operation or Host instance".into());
            }
            for sample in page.samples {
                let [source] = sample.provenance.sources.as_slice() else {
                    return Err("Unexpected source count".into());
                };
                let end = source
                    .byte_end
                    .map(U64::get)
                    .ok_or("Derived sample has no ending offset")?;
                if sample.position.get() != self.last + 1
                    || source.host_id != self.target.host_id
                    || source.session_id != self.target.id
                    || Some(source.session_epoch) != self.target.session_epoch
                    || source.direction != Some(Direction::Rx)
                    || source.byte_start.map(U64::get) != Some(self.byte_end)
                    || end <= self.byte_end
                    || sample.provenance.parser_id.as_str() != ACTION
                    || sample.provenance.parser_version != "1.0.0"
                    || sample.provenance.configuration_digest != self.configuration_sha256
                    || sample.provenance.unit.as_deref() != Some("bytes")
                    || sample.provenance.quality
                        != [DerivedQuality::Complete, DerivedQuality::Transformed]
                    || checked(serde_json::to_value(&sample.value))? != json!(end - self.byte_end)
                {
                    return Err(format!(
                        "Invalid provenance or count at sample {}",
                        sample.position
                    ));
                }
                self.last = sample.position.get();
                self.byte_end = end;
                checked(serde_json::to_writer(&mut self.file, &sample))?;
                checked(self.file.write_all(b"\n"))?;
            }
            if page.next_position.get() != self.last {
                return Err("Derived page cursor differs from last sample".into());
            }
            if !page.has_more {
                break;
            }
        }
        if self.slow_after == 0 && self.last > 0 {
            let initial = checked(self.page(&self.slow_owner, &self.slow, 0).await)?;
            self.slow_after = initial.next_position.get();
        }
        Ok(())
    }

    async fn page(
        &self,
        client: &HostClient,
        raw: &RawConnection,
        after: u64,
    ) -> HostResult<DerivedReadResult> {
        let query = query(
            client,
            "stream.derivedRead",
            &self.target,
            json!({
                "operationId":self.operation.operation_id,"after":after.to_string(),
                "maxSamples":"32","maxBytes":"65536"
            }),
        )
        .map_err(|message| HostError::new("HARNESS_QUERY", message))?;
        match raw.request(RpcRequest::Query(query)).await? {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Query(QueryResult::StreamDerivedRead(page)) => Ok(page),
                _ => Err(HostError::new("HARNESS_QUERY", "Expected derived page")),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }

    pub(super) async fn stop(
        mut self,
        user: &HostClient,
        generated: u64,
        sha256: &str,
        log_dir: &Path,
    ) -> Result<Value> {
        tx(user, &self.target, STOP).await?;
        let terminal = settled(user, &self.operation, false).await?;
        if terminal.state != OperationState::Succeeded {
            return Err(format!("Parser did not settle: {terminal:?}"));
        }
        let Some(ActionResult::Reference(reference)) = &terminal.result else {
            return Err("Parser result is not a controlled file reference".into());
        };
        let file = match raw_ask(
            &self.reader,
            &self.raw,
            "file.read",
            &reference_target(&reference.result_ref),
            json!({
                "fileRef":reference.result_ref,"offset":"0","maxBytes":"16384"
            }),
        )
        .await?
        {
            QueryResult::FileRead(content) if content.at_end => content,
            other => return Err(format!("Expected complete parser result, got {other:?}")),
        };
        let parsed: ParserResult = checked(serde_json::from_slice(&checked(
            STANDARD.decode(file.bytes_base64.as_str()),
        )?))?;
        self.collect().await?;
        if parsed.bytes.get() != generated
            || parsed.sha256.as_str() != sha256
            || parsed.published.get() != self.last
            || self.byte_end != generated
            || self.last <= 64
            || self.slow_after == 0
        {
            return Err("Raw producer, parser digest, and derived reader accounting differ".into());
        }
        let expired = match self
            .page(&self.slow_owner, &self.slow, self.slow_after)
            .await
        {
            Err(error) if error.code == "CURSOR_EXPIRED" => error,
            other => return Err(format!("Held derived reader did not expire: {other:?}")),
        };
        let details = checked(serde_json::to_value(expired.details))?;
        let oldest: U64 = checked(serde_json::from_value(details["oldestPosition"].clone()))?;
        if oldest.get() <= self.slow_after + 1 {
            return Err("Expired cursor did not report a real gap".into());
        }
        let resumed = checked(
            self.page(&self.slow_owner, &self.slow, oldest.get() - 1)
                .await,
        )?;
        if resumed.samples.first().map(|sample| sample.position) != Some(oldest) {
            return Err("Slow derived reader did not resume at oldest position".into());
        }
        checked(self.file.sync_all())?;
        let result = json!({
            "parserId":ACTION,"archiveSha256":self.archive_sha256,"operationId":terminal.operation_id,
            "bytes":generated,"sha256":parsed.sha256,"samplesPublished":self.last,"samplesRead":self.last,
            "slowAfter":self.slow_after,"oldestPosition":oldest,"slowReaderError":"CURSOR_EXPIRED",
            "resumedAt":resumed.samples[0].position,
            "archive":"T06-parser.zip","samples":"T06-derived.jsonl"
        });
        write_json(&log_dir.join("T06-parser-result.json"), &result)?;
        Ok(result)
    }
}
