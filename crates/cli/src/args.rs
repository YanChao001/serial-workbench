use serial_workbench_core::*;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
};

pub const HELP: &str = "Usage: serial-workbench-cli <command> [--profile <directory>] [--json]

Commands:
  catalog
  context --out <file>
  query <actionId> --target-json <file> --params-json <file>
  invoke <actionId> --target-json <file> --params-json <file> --request-id <uuid> --request-context-json <file>
    [--expected-revision <u64>] [--lease-id <id>] [--execution-mode interactive|independent]
  operation get <id>
  operation get --request-id <uuid> --request-context-json <file>
  operation cancel <id> [--request-id <uuid>]
  authorize --params-json <file> [--request-id <uuid>]
  revoke --params-json <file> [--request-id <uuid>]
  host stop [--request-id <uuid>]

All results are JSON. Authorize/revoke accept the Core AuthorizeParams/RevokeParams JSON.
Only authorize, revoke, and host stop use local user-control credentials.
Host stop waits for the attached Host instance to end; another instance may start.
When the profile lock is free, host stop reports alreadyStopped without starting a Host.
Invoke returns the accepted Operation without waiting or retrying; use operation get.
Context saves the Host-issued AttachResult as a new UTF-8 JSON file; it never overwrites.
Reuse the same context file and request Id for retries. Old/expired contexts are not refreshed.
After restart, use operation get with the original request Id and context file to find prior work.
Exiting this CLI does not cancel an Operation. Use operation cancel explicitly.
Exit codes: 0 success, 1 other failure, 2 invalid input/unsupported action,
3 authentication/permission, 4 conflict/stale state, 5 unavailable/busy/timeout.
Use --help to show this help.";

pub struct Args {
    pub profile: Option<PathBuf>,
    pub command: Command,
}
pub enum Command {
    Catalog,
    Context {
        out: PathBuf,
    },
    Query {
        action_id: Id,
        target: Target,
        params: JsonObject,
    },
    Invoke {
        action_id: Id,
        target: Target,
        params: JsonObject,
        context: Box<AttachResult>,
        options: InvokeOptions,
    },
    OperationGet(Id),
    OperationGetByRequest {
        request_id: RequestId,
        context: Box<AttachResult>,
    },
    OperationCancel {
        id: Id,
        request_id: RequestId,
    },
    UserControl {
        action: UserControl,
        params: JsonObject,
        request_id: RequestId,
    },
    HostStop {
        request_id: RequestId,
    },
}
pub enum UserControl {
    Authorize,
    Revoke,
}
impl UserControl {
    pub fn action_id(&self) -> &'static str {
        match self {
            Self::Authorize => "auth.authorize",
            Self::Revoke => "auth.revoke",
        }
    }
}
pub struct InvokeOptions {
    pub request_id: RequestId,
    pub expected_revision: Option<U64>,
    pub lease_id: Option<Id>,
    pub execution_mode: Option<ExecutionMode>,
}
impl InvokeOptions {
    pub fn new(request_id: RequestId) -> Self {
        Self {
            request_id,
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        }
    }
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> HostResult<Option<Args>> {
    let mut words = Vec::new();
    let mut options = BTreeMap::new();
    let mut json = false;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--help" | "-h") => return Ok(None),
            Some("--json") if !json => json = true,
            Some(key) if key.starts_with('-') => {
                if ![
                    "--profile",
                    "--out",
                    "--target-json",
                    "--params-json",
                    "--request-id",
                    "--request-context-json",
                    "--expected-revision",
                    "--lease-id",
                    "--execution-mode",
                ]
                .contains(&key)
                {
                    return Err(invalid("Unknown or repeated option; use --help"));
                }
                let value = arguments
                    .next()
                    .ok_or_else(|| invalid("Option requires a value"))?;
                if value.to_str().is_some_and(|value| value.starts_with("--"))
                    || options.insert(key.to_owned(), value).is_some()
                {
                    return Err(invalid("Missing option value or duplicate option"));
                }
            }
            _ => words.push(
                argument
                    .into_string()
                    .map_err(|_| invalid("Command names must be UTF-8"))?,
            ),
        }
    }
    let profile = options.remove("--profile").map(PathBuf::from);
    let command = match words
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["catalog"] => {
            allowed(&options, &[])?;
            Command::Catalog
        }
        ["context"] => {
            allowed(&options, &["--out"])?;
            Command::Context {
                out: options
                    .remove("--out")
                    .ok_or_else(|| invalid("Missing --out"))?
                    .into(),
            }
        }
        ["query", action] => {
            allowed(&options, &["--target-json", "--params-json"])?;
            Command::Query {
                action_id: Id::try_from(*action)?,
                target: file(&mut options, "--target-json")?,
                params: file(&mut options, "--params-json")?,
            }
        }
        ["invoke", action] => {
            allowed(
                &options,
                &[
                    "--target-json",
                    "--params-json",
                    "--request-id",
                    "--request-context-json",
                    "--expected-revision",
                    "--lease-id",
                    "--execution-mode",
                ],
            )?;
            let request_id =
                RequestId::try_from(required_text(&mut options, "--request-id")?.as_str())?;
            let expected_revision = text(&mut options, "--expected-revision")?
                .map(|v| U64::try_from(v.as_str()))
                .transpose()?;
            let lease_id = text(&mut options, "--lease-id")?
                .map(|v| Id::try_from(v.as_str()))
                .transpose()?;
            let execution_mode = text(&mut options, "--execution-mode")?
                .map(|v| {
                    serde_json::from_value(serde_json::Value::String(v))
                        .map_err(|_| invalid("Invalid execution mode"))
                })
                .transpose()?;
            Command::Invoke {
                action_id: Id::try_from(*action)?,
                target: file(&mut options, "--target-json")?,
                params: file(&mut options, "--params-json")?,
                context: Box::new(file(&mut options, "--request-context-json")?),
                options: InvokeOptions {
                    request_id,
                    expected_revision,
                    lease_id,
                    execution_mode,
                },
            }
        }
        ["operation", "get", id] => {
            allowed(&options, &[])?;
            Command::OperationGet(Id::try_from(*id)?)
        }
        ["operation", "get"] => {
            allowed(&options, &["--request-id", "--request-context-json"])?;
            Command::OperationGetByRequest {
                request_id: RequestId::try_from(
                    required_text(&mut options, "--request-id")?.as_str(),
                )?,
                context: Box::new(file(&mut options, "--request-context-json")?),
            }
        }
        ["operation", "cancel", id] => {
            allowed(&options, &["--request-id"])?;
            Command::OperationCancel {
                id: Id::try_from(*id)?,
                request_id: request_id(&mut options)?,
            }
        }
        [action @ ("authorize" | "revoke")] => {
            allowed(&options, &["--params-json", "--request-id"])?;
            let (action, params) = if *action == "authorize" {
                let params: AuthorizeParams = file(&mut options, "--params-json")?;
                (UserControl::Authorize, object(params)?)
            } else {
                let params: RevokeParams = file(&mut options, "--params-json")?;
                (UserControl::Revoke, object(params)?)
            };
            Command::UserControl {
                action,
                params,
                request_id: request_id(&mut options)?,
            }
        }
        ["host", "stop"] => {
            allowed(&options, &["--request-id"])?;
            Command::HostStop {
                request_id: request_id(&mut options)?,
            }
        }
        _ => return Err(invalid("Invalid command or missing argument; use --help")),
    };
    Ok(Some(Args { profile, command }))
}
fn allowed(options: &BTreeMap<String, OsString>, allowed: &[&str]) -> HostResult<()> {
    if options.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("Option is not valid for this command"));
    }
    Ok(())
}
fn text(options: &mut BTreeMap<String, OsString>, key: &str) -> HostResult<Option<String>> {
    options
        .remove(key)
        .map(|v| {
            v.into_string()
                .map_err(|_| invalid("Option value must be UTF-8"))
        })
        .transpose()
}
fn required_text(options: &mut BTreeMap<String, OsString>, key: &str) -> HostResult<String> {
    text(options, key)?.ok_or_else(|| invalid(format!("Missing {key}")))
}
fn file<T: serde::de::DeserializeOwned>(
    options: &mut BTreeMap<String, OsString>,
    key: &str,
) -> HostResult<T> {
    let path = options
        .remove(key)
        .ok_or_else(|| invalid(format!("Missing {key}")))?;
    let mut bytes = Vec::new();
    std::fs::File::open(Path::new(&path))
        .and_then(|file| {
            file.take(serial_workbench_ipc::frame::MAX_FRAME_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|_| invalid(format!("Cannot read {key} file")))?;
    if bytes.len() > serial_workbench_ipc::frame::MAX_FRAME_BYTES {
        return Err(invalid(format!("{key} file exceeds the IPC frame budget")));
    }
    serde_json::from_slice(&bytes).map_err(|error| invalid(format!("Invalid {key} JSON: {error}")))
}
pub fn object(value: impl serde::Serialize) -> HostResult<JsonObject> {
    serde_json::from_value(
        serde_json::to_value(value).map_err(|_| invalid("Cannot encode parameters"))?,
    )
    .map_err(|_| invalid("Parameters must be a JSON object"))
}
fn request_id(options: &mut BTreeMap<String, OsString>) -> HostResult<RequestId> {
    text(options, "--request-id")?
        .map(|v| RequestId::try_from(v.as_str()))
        .unwrap_or_else(|| Ok(new_request_id()))
}
pub fn new_request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID request Id")
}
fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("INVALID_ARGUMENT", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_file_enforces_actual_byte_budget_and_accepts_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("params.json");
        let mut bytes = vec![b' '; serial_workbench_ipc::frame::MAX_FRAME_BYTES];
        bytes[..2].copy_from_slice(b"{}");
        std::fs::write(&path, &bytes).unwrap();
        let options = || BTreeMap::from([("--params-json".into(), path.clone().into_os_string())]);
        assert!(file::<JsonObject>(&mut options(), "--params-json").is_ok());
        bytes.push(b' ');
        std::fs::write(&path, &bytes).unwrap();
        let error = file::<JsonObject>(&mut options(), "--params-json").unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("budget"));
    }
}
