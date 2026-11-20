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
async fn run() -> HostResult<()> {
    let mut profile: Option<PathBuf> = None;
    let mut bootstrap = false;
    let mut broker = false;
    let mut browser_assets: Option<PathBuf> = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--profile") if profile.is_none() => {
                profile = Some(args.next().ok_or_else(invalid_args)?.into())
            }
            Some("--bootstrap-stdio") if !bootstrap && !broker && browser_assets.is_none() => {
                bootstrap = true
            }
            Some("--user-control-stdio") if !bootstrap && !broker && browser_assets.is_none() => {
                broker = true
            }
            Some("--browser-pair-stdio") if browser_assets.is_none() && !bootstrap && !broker => {
                browser_assets = Some(args.next().ok_or_else(invalid_args)?.into());
            }
            Some("--help") => {
                println!(
                    "Usage: serial-workbench-host [--profile <directory>] [--browser-pair-stdio <assets-directory>]\nUser-control and browser pairing transfers require an inherited stdout pipe."
                );
                return Ok(());
            }
            _ => return Err(invalid_args()),
        }
    }
    let startup = startup_config::resolve(profile)?;
    startup_config::init_stderr_logging(startup.log_filter())?;
    startup_config::log_startup_configuration(&startup.snapshot());
    let profile = startup.profile();
    if broker {
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
    let mut host = HostServer::bind(profile).await?;
    if bootstrap {
        host.write_bootstrap_capability()?;
    }
    let handler = Host::with_startup_config(host.store(), host.auth(), startup.snapshot()).await?;
    if let Some(assets) = browser_assets {
        let entry = host.enable_browser(&assets).await?;
        let encoded = serde_json::to_vec(&entry).map_err(|_| invalid_args())?;
        serial_workbench_ipc::write_bootstrap_capability(&encoded)?;
    }
    host.serve_until(Arc::new(handler), async move {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
fn invalid_args() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Host startup arguments")
}
