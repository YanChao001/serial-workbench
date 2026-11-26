use crate::{
    args, call, host_options, host_target, operation_target, output, query, save_context,
    send_with_raw, validate_context,
};
use serde::{Deserialize, Serialize};
use serial_workbench_client::{
    ConnectOptions, HostClient, RawConnection, adjacent_host_executable,
};
use serial_workbench_core::*;
use serial_workbench_ipc::{profile_has_running_host, startup_config};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::{ExitCode, Stdio},
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    time::{Instant, sleep, timeout, timeout_at},
};

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_LIMIT: usize = 8 * serial_workbench_ipc::frame::MAX_FRAME_BYTES;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    Attach,
    Offline,
}

impl Mode {
    pub(crate) fn parse(value: &str) -> HostResult<Self> {
        match value {
            "attach" => Ok(Self::Attach),
            "offline" => Ok(Self::Offline),
            _ => Err(invalid("Run mode must be attach or offline")),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Definition {
    schema_version: u8,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Step {
    Query {
        action_id: Id,
        target: StepTarget,
        params: JsonObject,
    },
    Invoke {
        action_id: Id,
        target: StepTarget,
        params: JsonObject,
        request_id: RequestId,
        expected_revision: Option<U64>,
        lease_id: Option<Id>,
        execution_mode: Option<ExecutionMode>,
    },
}

impl Step {
    fn target(&self) -> &StepTarget {
        match self {
            Self::Query { target, .. } | Self::Invoke { target, .. } => target,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StepTarget {
    Exact(Target),
    Host(LocalHostTarget),
    Opened(OpenedTarget),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalHostTarget {
    kind: HostKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum HostKind {
    Host,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenedTarget {
    opened_by: usize,
}

impl StepTarget {
    fn resolve(&self, client: &HostClient, steps: &[StepReport]) -> HostResult<Target> {
        match self {
            Self::Exact(target) => Ok(target.clone()),
            Self::Host(LocalHostTarget {
                kind: HostKind::Host,
            }) => Ok(host_target(client)),
            Self::Opened(reference) => {
                let result = steps
                    .get(reference.opened_by)
                    .and_then(|step| step.operation.as_ref())
                    .and_then(|operation| operation.result.as_ref());
                let Some(ActionResult::Opened(opened)) = result else {
                    return Err(invalid("Referenced step did not open a session"));
                };
                Ok(Target {
                    host_id: client.attachment().host_id.clone(),
                    kind: ResourceKind::try_from("session").expect("session kind"),
                    id: opened.session_id.clone(),
                    session_id: Some(opened.session_id.clone()),
                    session_epoch: Some(opened.session_epoch),
                })
            }
        }
    }
}

pub(crate) struct Options {
    mode: Mode,
    timeout: Duration,
    steps: Vec<Step>,
    context_out: Option<PathBuf>,
    saved: Option<AttachResult>,
}

impl Options {
    pub(crate) fn new(
        mode: Mode,
        timeout_ms: u64,
        definition: Definition,
        context_out: Option<PathBuf>,
        saved: Option<AttachResult>,
    ) -> HostResult<Self> {
        if definition.schema_version != 1 || !(1..=64).contains(&definition.steps.len()) {
            return Err(invalid("Batch requires schemaVersion 1 and 1 to 64 steps"));
        }
        if context_out.is_some() && saved.is_some() {
            return Err(invalid(
                "Use either --context-out or --request-context-json",
            ));
        }
        let mut ids = BTreeSet::new();
        for (index, step) in definition.steps.iter().enumerate() {
            if let StepTarget::Opened(reference) = step.target()
                && (reference.opened_by >= index
                    || !matches!(definition.steps[reference.opened_by], Step::Invoke { .. }))
            {
                return Err(invalid("openedBy must reference an earlier invoke step"));
            }
            if let Step::Invoke {
                request_id,
                action_id,
                ..
            } = step
            {
                if action_id.as_str() == "host.shutdown" {
                    return Err(invalid("Use host stop outside a batch"));
                }
                if !ids.insert(request_id.as_str()) {
                    return Err(invalid("Duplicate invoke requestId in batch"));
                }
                if saved.is_none() && context_out.is_none() {
                    return Err(invalid("Invoke steps require a saved request context"));
                }
            }
        }
        Ok(Self {
            mode,
            timeout: Duration::from_millis(timeout_ms),
            steps: definition.steps,
            context_out,
            saved,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum StepState {
    QueryPending,
    AdmissionUnknown,
    Rejected,
    Accepted,
    Terminal,
    Completed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepReport {
    index: usize,
    action_id: Id,
    state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<Operation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<RpcResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u8,
    mode: Mode,
    ok: bool,
    steps: Vec<StepReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation: Option<RpcReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offline_host_exit: Option<OfflineExit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offline_host_error: Option<HostError>,
}

impl Report {
    fn new(mode: Mode) -> Self {
        Self {
            schema_version: 1,
            mode,
            ok: false,
            steps: Vec::new(),
            error: None,
            cancellation: None,
            offline_host_exit: None,
            offline_host_error: None,
        }
    }

    fn record_step_payload(&mut self) -> HostResult<()> {
        let size = serde_json::to_vec(self)
            .map_err(|_| HostError::new("OUTPUT_UNAVAILABLE", "Cannot encode batch report"))?
            .len();
        if size <= OUTPUT_LIMIT {
            return Ok(());
        }
        let step = self.steps.last_mut().expect("step receiving a result");
        step.operation = None;
        step.result = None;
        Err(HostError::new(
            "BATCH_OUTPUT_LIMIT",
            "Batch report exceeds its output budget",
        ))
    }

    fn record_operation(&mut self, operation: Operation) -> HostResult<()> {
        let step = self.steps.last_mut().expect("step receiving an operation");
        step.state = if operation.state.is_terminal() {
            StepState::Terminal
        } else {
            StepState::Accepted
        };
        step.operation_id = Some(operation.operation_id.clone());
        step.operation = Some(operation);
        self.record_step_payload()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum OfflineExit {
    Graceful,
    Failed,
    Forced,
    Unconfirmed,
}

#[derive(Default)]
struct Execution {
    client: Option<HostClient>,
    owned: Option<Child>,
}

pub(crate) async fn run(
    profile: Option<PathBuf>,
    route: Option<LanRoute>,
    options: Options,
) -> ExitCode {
    let deadline = Instant::now() + options.timeout;
    let mut execution = Execution::default();
    let mut report = Report::new(options.mode);
    let outcome = tokio::select! {
        biased;
        signal = stop_signal() => {
            match signal {
                Ok(()) => Err(HostError::new("BATCH_CANCELLED", "Batch cancelled by the caller")),
                Err(_) => Err(HostError::new("HOST_UNAVAILABLE", "Cannot listen for batch cancellation")),
            }
        }
        result = timeout_at(deadline, execute(profile, route, options, &mut execution, &mut report, deadline)) => {
            result.unwrap_or_else(|_| Err(deadline_error()))
        }
    };
    if outcome
        .as_ref()
        .is_err_and(|error| error.code == "BATCH_CANCELLED")
    {
        request_cancel(execution.client.as_ref(), &mut report).await;
    }
    if let Some(child) = execution.owned.take() {
        drop(execution.client.take());
        let (state, error) = stop_owned(child).await;
        report.offline_host_exit = Some(state);
        report.offline_host_error = error.clone();
        report.error = outcome.err().or(error);
    } else {
        report.error = outcome.err();
    }
    report.ok = report.error.is_none();
    let mut code = 0;
    if let Some(error) = &report.error {
        eprintln!("{error}");
        code = output::exit_code(error);
    }
    if let Err(error) = output::json(&report) {
        eprintln!("{error}");
        code = output::exit_code(&error);
    }
    ExitCode::from(code)
}

async fn execute(
    profile: Option<PathBuf>,
    route: Option<LanRoute>,
    options: Options,
    execution: &mut Execution,
    report: &mut Report,
    deadline: Instant,
) -> HostResult<()> {
    let config = startup_config::resolve(profile)?;
    startup_config::init_stderr_logging(config.log_filter())?;
    startup_config::log_startup_configuration(&config.snapshot());
    let host = host_options(config.profile(), route);
    let client = match options.mode {
        Mode::Attach => HostClient::connect(host).await?,
        Mode::Offline => {
            let profile = host.clone();
            tokio::task::spawn_blocking(move || {
                if profile_has_running_host(&profile.profile)? {
                    return Err(HostError::new(
                        "HOST_BUSY",
                        "Offline mode requires a stopped profile",
                    ));
                }
                HostClient::validate_start_profile(&profile)
            })
            .await
            .map_err(|_| start_failed())??;
            execution.owned = Some(start_owned(&host)?);
            timeout(
                Duration::from_secs(10),
                connect_owned(host, execution.owned.as_mut().expect("owned process")),
            )
            .await
            .map_err(|_| {
                HostError::new(
                    "HOST_START_TIMEOUT",
                    "Offline Host did not complete authenticated startup",
                )
            })??
        }
    };
    execution.client = Some(client);
    let client = execution.client.as_ref().expect("attached client");
    for step in &options.steps {
        if let StepTarget::Exact(target) = step.target()
            && target.host_id != client.attachment().host_id
        {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Batch target belongs to another Host",
            ));
        }
    }
    if let Some(path) = &options.context_out {
        save_context(path, client.attachment())?;
    }
    let context = options
        .saved
        .as_ref()
        .unwrap_or_else(|| client.attachment());
    validate_context(client, context, false)?;
    let mut raw = None;
    for (index, step) in options.steps.into_iter().enumerate() {
        if Instant::now() >= deadline {
            return Err(deadline_error());
        }
        run_step(client, &mut raw, context, report, index, step).await?;
        // Re-poll the CLI's control signal before the next step acquires an operation.
        tokio::task::yield_now().await;
    }
    Ok(())
}

async fn run_step(
    client: &HostClient,
    raw: &mut Option<RawConnection>,
    context: &AttachResult,
    report: &mut Report,
    index: usize,
    step: Step,
) -> HostResult<()> {
    let target = step.target().resolve(client, &report.steps)?;
    let (action_id, request_id, request) = match step {
        Step::Query {
            action_id, params, ..
        } => {
            let request = RpcRequest::Query(query(client, action_id.clone(), target, params));
            (action_id, None, request)
        }
        Step::Invoke {
            action_id,
            params,
            request_id,
            expected_revision,
            lease_id,
            execution_mode,
            ..
        } => {
            let mut message = call(
                client,
                action_id.clone(),
                target,
                params,
                args::InvokeOptions {
                    request_id: request_id.clone(),
                    expected_revision,
                    lease_id,
                    execution_mode,
                },
            );
            message.request_context = context.request_context.clone();
            (action_id, Some(request_id), RpcRequest::Invoke(message))
        }
    };
    let expected_request = request_id.clone();
    let invokes = expected_request.is_some();
    report.steps.push(StepReport {
        index,
        action_id,
        request_id,
        operation_id: None,
        operation: None,
        result: None,
        state: if invokes {
            StepState::AdmissionUnknown
        } else {
            StepState::QueryPending
        },
    });
    let reply = send_with_raw(client, raw, request).await?;
    let step = report.steps.last_mut().expect("submitted step");
    match reply {
        RpcReply::Failure { error, .. } => {
            step.state = StepState::Rejected;
            Err(error)
        }
        RpcReply::Success { result, .. } if !invokes => {
            step.state = StepState::Completed;
            step.result = Some(*result);
            report.record_step_payload()
        }
        RpcReply::Success { result, .. } => {
            let RpcResult::Operation(result) = *result else {
                return Err(invalid_reply());
            };
            let mut operation = result.operation;
            let expected_request = expected_request.as_ref().expect("invoke request id");
            if !matches_origin(client, &operation, expected_request) {
                return Err(invalid_reply());
            }
            loop {
                let state = operation.state;
                let terminal = state.is_terminal();
                let id = operation.operation_id.clone();
                report.record_operation(operation)?;
                if terminal {
                    let step = report
                        .steps
                        .last()
                        .and_then(|step| step.operation.as_ref())
                        .expect("stored terminal operation");
                    return outcome(step.state, step.result.as_ref(), step.error.as_ref());
                }
                sleep(POLL_INTERVAL).await;
                operation = fetch_operation(client, id, expected_request).await?;
            }
        }
    }
}

async fn fetch_operation(
    client: &HostClient,
    id: Id,
    request_id: &RequestId,
) -> HostResult<Operation> {
    let request = RpcRequest::OperationGet(query(
        client,
        crate::id("operation.get"),
        operation_target(client, id.clone()),
        args::object(OperationGetParams::ById {
            operation_id: id.clone(),
            request_context: None,
        })?,
    ));
    match client.request(request).await? {
        RpcReply::Failure { error, .. } => Err(error),
        RpcReply::Success { result, .. } => match *result {
            RpcResult::Operation(operation)
                if operation.operation.operation_id == id
                    && matches_origin(client, &operation.operation, request_id) =>
            {
                Ok(operation.operation)
            }
            _ => Err(invalid_reply()),
        },
    }
}

fn matches_origin(client: &HostClient, operation: &Operation, request: &RequestId) -> bool {
    let host = client.attachment();
    operation.execution_host_id == host.host_id
        && operation.actor_id == host.actor_id
        && &operation.request_id == request
}

fn outcome(
    state: OperationState,
    result: Option<&ActionResult>,
    error: Option<&HostError>,
) -> HostResult<()> {
    let unknown = || HostError::new("BATCH_UNCONFIRMED", "Operation outcome was not confirmed");
    let partial = || {
        HostError::new(
            "BATCH_PARTIAL",
            "Operation accepted only part of the requested output",
        )
    };
    match state {
        OperationState::Cancelled => {
            return Err(HostError::new("BATCH_CANCELLED", "Operation was cancelled"));
        }
        OperationState::Unknown | OperationState::Interrupted => return Err(unknown()),
        _ => {}
    }
    match result {
        Some(ActionResult::Tx(receipt)) if receipt.outcome == TxOutcome::Unknown => {
            return Err(unknown());
        }
        Some(ActionResult::Tx(receipt)) if receipt.outcome == TxOutcome::Partial => {
            return Err(partial());
        }
        Some(ActionResult::Tx(receipt)) if receipt.outcome == TxOutcome::Rejected => {
            return Err(receipt
                .backend_error
                .as_ref()
                .or(error)
                .cloned()
                .unwrap_or_else(|| {
                    HostError::new("BATCH_OPERATION_FAILED", "Write was rejected")
                }));
        }
        Some(ActionResult::FileTransfer(transfer)) if transfer.unknown.get() != 0 => {
            return Err(unknown());
        }
        Some(ActionResult::FileTransfer(transfer))
            if transfer.accepted < transfer.requested
                && (transfer.accepted.get() != 0 || state == OperationState::Succeeded) =>
        {
            return Err(partial());
        }
        _ => {}
    }
    if state == OperationState::Succeeded {
        Ok(())
    } else {
        Err(error
            .cloned()
            .unwrap_or_else(|| HostError::new("BATCH_OPERATION_FAILED", "Operation failed")))
    }
}

async fn request_cancel(client: Option<&HostClient>, report: &mut Report) {
    let Some(client) = client else { return };
    let Some(step) = report.steps.last() else {
        return;
    };
    let Some(id) = &step.operation_id else { return };
    if !matches!(step.state, StepState::Accepted) {
        return;
    }
    let Ok(params) = args::object(OperationCancelParams {
        reason: CancelReason::User,
    }) else {
        return;
    };
    let request = RpcRequest::OperationCancel(call(
        client,
        crate::id("operation.cancel"),
        operation_target(client, id.clone()),
        params,
        args::InvokeOptions::new(args::new_request_id()),
    ));
    report.cancellation = match timeout(Duration::from_secs(2), client.request(request)).await {
        Ok(Ok(reply)) => Some(reply),
        Ok(Err(error)) => Some(RpcReply::Failure { ok: False, error }),
        Err(_) => Some(RpcReply::Failure {
            ok: False,
            error: HostError::new(
                "BATCH_UNCONFIRMED",
                "Cancellation admission was not confirmed",
            ),
        }),
    };
}

fn start_owned(options: &ConnectOptions) -> HostResult<Child> {
    let executable = options
        .expected_host_executable
        .clone()
        .map_or_else(adjacent_host_executable, Ok)?;
    let mut command = Command::new(executable);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A terminal signal to the CLI must not shut down its Host before cancellation is recorded.
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .arg("--profile")
        .arg(&options.profile)
        .arg("--owned-run-stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            HostError::new(
                "HOST_START_FAILED",
                "Cannot start the adjacent offline Host",
            )
        })
}

async fn connect_owned(options: ConnectOptions, child: &mut Child) -> HostResult<HostClient> {
    let pid = child.id().ok_or_else(start_failed)?;
    loop {
        if child.try_wait().map_err(|_| start_failed())?.is_some() {
            return Err(start_failed());
        }
        match HostClient::connect(options.clone()).await {
            Ok(client)
                if client.local_process_id() == pid
                    && child.try_wait().map_err(|_| start_failed())?.is_none() =>
            {
                return Ok(client);
            }
            Ok(_) => {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Another Host acquired the offline profile",
                ));
            }
            Err(error) if matches!(error.code.as_str(), "STORAGE_UNAVAILABLE" | "HOST_BUSY") => {}
            Err(error) => return Err(error),
        }
        sleep(POLL_INTERVAL).await;
    }
}

async fn stop_owned(mut child: Child) -> (OfflineExit, Option<HostError>) {
    drop(child.stdin.take());
    match timeout(CLEANUP_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => (OfflineExit::Graceful, None),
        Ok(Ok(_)) => (
            OfflineExit::Failed,
            Some(HostError::new(
                "HOST_UNAVAILABLE",
                "Offline Host exited unsuccessfully",
            )),
        ),
        Ok(Err(_)) => (
            OfflineExit::Unconfirmed,
            Some(HostError::new(
                "HOST_UNAVAILABLE",
                "Cannot confirm offline Host exit",
            )),
        ),
        Err(_) => {
            let killed = child.start_kill().is_ok();
            let state = match timeout(CLEANUP_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) if killed => OfflineExit::Forced,
                Ok(Ok(status)) if status.success() => OfflineExit::Graceful,
                Ok(Ok(_)) => OfflineExit::Failed,
                _ => OfflineExit::Unconfirmed,
            };
            (
                state,
                Some(HostError::new(
                    "HOST_STOP_TIMEOUT",
                    "Offline Host exceeded the graceful shutdown limit",
                )),
            )
        }
    }
}

#[cfg(unix)]
async fn stop_signal() -> std::io::Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        signal = tokio::signal::ctrl_c() => signal,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn stop_signal() -> std::io::Result<()> {
    tokio::signal::ctrl_c().await
}

fn deadline_error() -> HostError {
    HostError::new("BATCH_DEADLINE_EXCEEDED", "Batch deadline elapsed")
}

fn invalid(message: &str) -> HostError {
    HostError::new("INVALID_ARGUMENT", message)
}

fn invalid_reply() -> HostError {
    HostError::new(
        "HOST_UNAVAILABLE",
        "Host returned an unexpected batch response",
    )
}

fn start_failed() -> HostError {
    HostError::new(
        "HOST_START_FAILED",
        "Offline Host exited before authenticated attachment",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_incomplete_transmission_is_never_batch_success() {
        let receipt = |outcome| {
            ActionResult::Tx(TxReceipt {
                operation_id: crate::id("write-operation"),
                session_id: crate::id("session"),
                session_epoch: 1.into(),
                outcome,
                bytes_base64: Bytes::try_from("YQ==").unwrap(),
                byte_start: 0.into(),
                byte_end: 1.into(),
                accepted_ranges: vec![],
                unknown_ranges: vec![],
                peer_acknowledged: False,
                backend_error: None,
            })
        };
        for (state, tx, code, exit) in [
            (
                OperationState::Succeeded,
                TxOutcome::Partial,
                "BATCH_PARTIAL",
                6,
            ),
            (
                OperationState::Succeeded,
                TxOutcome::Unknown,
                "BATCH_UNCONFIRMED",
                7,
            ),
            (
                OperationState::Cancelled,
                TxOutcome::Partial,
                "BATCH_CANCELLED",
                130,
            ),
            (
                OperationState::Interrupted,
                TxOutcome::Accepted,
                "BATCH_UNCONFIRMED",
                7,
            ),
        ] {
            let error = outcome(state, Some(&receipt(tx)), None).unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(output::exit_code(&error), exit);
        }
    }
}
