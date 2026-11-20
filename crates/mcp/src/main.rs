use rmcp::{ServiceExt, transport::stdio};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::{ClientKind, HostError, HostResult, Id, LanRoute};
use serial_workbench_ipc::startup_config;
use serial_workbench_mcp::McpBridge;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}

async fn run() -> HostResult<()> {
    let mut profile: Option<PathBuf> = None;
    let mut client_id = None;
    let mut lan_peer = None;
    let mut lan_address = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--profile") if profile.is_none() => {
                profile = Some(args.next().ok_or_else(invalid_args)?.into());
            }
            Some("--client-id") if client_id.is_none() => {
                let value = args.next().ok_or_else(invalid_args)?;
                client_id = Some(Id::try_from(value.to_str().ok_or_else(invalid_args)?)?);
            }
            Some("--lan-peer") if lan_peer.is_none() => {
                lan_peer = Some(
                    args.next()
                        .ok_or_else(invalid_args)?
                        .into_string()
                        .map_err(|_| invalid_args())?,
                );
            }
            Some("--lan-address") if lan_address.is_none() => {
                lan_address = Some(
                    args.next()
                        .ok_or_else(invalid_args)?
                        .into_string()
                        .map_err(|_| invalid_args())?,
                );
            }
            _ => return Err(invalid_args()),
        }
    }
    let startup = startup_config::resolve(profile)?;
    startup_config::init_stderr_logging(startup.log_filter())?;
    startup_config::log_startup_configuration(&startup.snapshot());
    let mut options = ConnectOptions::new(
        startup.profile().to_path_buf(),
        client_id.unwrap_or(Id::try_from("serial-workbench-mcp")?),
        ClientKind::Mcp,
    );
    options.lan_route = match (lan_peer, lan_address) {
        (Some(peer), Some(address)) => Some(LanRoute::parse(&peer, address)?),
        (None, None) => None,
        _ => return Err(invalid_args()),
    };
    let client = HostClient::connect_or_start(options).await?;
    let server = McpBridge::new(client)
        .serve(stdio())
        .await
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "MCP initialization failed"))?;
    server
        .waiting()
        .await
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "MCP service task failed"))?;
    Ok(())
}

fn invalid_args() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Usage: serial-workbench-mcp [--profile <directory>] [--client-id <name>] [--lan-peer <hostId> --lan-address <ip:port>]",
    )
}
