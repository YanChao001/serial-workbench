use serial_workbench_core::{ContextToken, HostError, HostResult};
use serial_workbench_host::{Host, ipc::HostServer};
use serial_workbench_ipc::startup_config;
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
enum StartupTransfer {
    None,
    Bootstrap,
    UserControl,
    Browser(PathBuf),
    HttpControl,
}

async fn run() -> HostResult<()> {
    let mut profile: Option<PathBuf> = None;
    let mut transfer = StartupTransfer::None;
    let mut owned_run = false;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--profile") if profile.is_none() => {
                profile = Some(args.next().ok_or_else(invalid_args)?.into())
            }
            Some("--owned-run-stdio") if !owned_run => owned_run = true,
            Some("--bootstrap-stdio") if matches!(transfer, StartupTransfer::None) => {
                transfer = StartupTransfer::Bootstrap;
            }
            Some("--user-control-stdio") if matches!(transfer, StartupTransfer::None) => {
                transfer = StartupTransfer::UserControl;
            }
            Some("--browser-pair-stdio") if matches!(transfer, StartupTransfer::None) => {
                transfer = StartupTransfer::Browser(args.next().ok_or_else(invalid_args)?.into());
            }
            Some("--http-control-stdio") if matches!(transfer, StartupTransfer::None) => {
                transfer = StartupTransfer::HttpControl;
            }
            Some("--help") => {
                println!(
                    "Usage: serial-workbench-host [--profile <directory>] [--browser-pair-stdio <assets-directory> | --http-control-stdio]\nCredential transfers require an inherited stdout pipe."
                );
                return Ok(());
            }
            _ => return Err(invalid_args()),
        }
    }
    if !matches!(transfer, StartupTransfer::None) {
        if owned_run {
            return Err(invalid_args());
        }
        serial_workbench_ipc::require_bootstrap_pipe()?;
    }
    let stopped = if owned_run {
        Some(watch_owned_run()?)
    } else {
        None
    };
    let startup = startup_config::resolve(profile)?;
    startup_config::init_stderr_logging(startup.log_filter())?;
    startup_config::log_startup_configuration(&startup.snapshot());
    let profile = startup.profile();
    if matches!(transfer, StartupTransfer::UserControl) {
        // 明确本地用户控制入口，普通 IPC 无领取此凭据的方法。
        let secret =
            serial_workbench_ipc::read_secret(&profile.join("host-v0/user-control.secret"))?
                .ok_or_else(|| {
                    HostError::new(
                        "UNAUTHENTICATED",
                        "Local user-control credential is unavailable",
                    )
                })?;
        let token =
            ContextToken::try_from(std::str::from_utf8(&secret).map_err(|_| invalid_args())?)?;
        return serial_workbench_ipc::write_bootstrap_capability(token.as_str().as_bytes());
    }
    let mut host = HostServer::prepare(profile).await?;
    let handler = Host::with_startup_config(host.store(), host.auth(), startup.snapshot()).await?;
    let entry = match &transfer {
        StartupTransfer::Browser(assets) => {
            Some(serde_json::to_vec(&host.enable_browser(assets).await?))
        }
        StartupTransfer::HttpControl => {
            Some(serde_json::to_vec(&host.enable_http_control().await?))
        }
        _ => None,
    };
    host.publish_discovery().await?;
    if matches!(transfer, StartupTransfer::Bootstrap) {
        host.write_bootstrap_capability()?;
    }
    if let Some(encoded) = entry {
        serial_workbench_ipc::write_bootstrap_capability(&encoded.map_err(|_| invalid_args())?)?;
    }
    host.serve_until(Arc::new(handler), async move {
        if let Some(stopped) = stopped {
            tokio::select! {
                _ = stopped => {},
                _ = tokio::signal::ctrl_c() => {},
            }
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }
    })
    .await
}
fn watch_owned_run() -> HostResult<tokio::sync::oneshot::Receiver<()>> {
    use std::io::Read;
    let (stopped, receiver) = tokio::sync::oneshot::channel();
    // A private stdin pipe is the CLI's lifetime token. EOF also handles abrupt CLI exit.
    // Use an ordinary thread so Ctrl+C does not leave a Tokio blocking worker on console stdin.
    std::thread::Builder::new()
        .name("owned-run-stdio".into())
        .spawn(move || {
            let _ = std::io::stdin().lock().read(&mut [0u8; 1]);
            let _ = stopped.send(());
        })
        .map_err(|_| HostError::new("HOST_START_FAILED", "Cannot watch the CLI Host lifetime"))?;
    Ok(receiver)
}
fn invalid_args() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Host startup arguments")
}
