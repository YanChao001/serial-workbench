use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::{ClientKind, HostError, HostResult, Id};
use serial_workbench_ipc::{PrivateFileLock, reserve_host_instance};
use std::{path::Path, time::Duration};

use crate::error::{ErrorCode, NativeError};

pub(super) fn install_error(error: HostError) -> NativeError {
    NativeError::operation(
        ErrorCode::UpdateInstallFailed,
        "Cannot confirm local Host shutdown before installing the update",
        error,
    )
}

pub(super) async fn stop_and_reserve(profile: &Path) -> HostResult<PrivateFileLock> {
    let namespace = profile.join("host-v0");
    match reserve_host_instance(&namespace) {
        Ok(reservation) => return Ok(reservation),
        Err(error) if error.code == "HOST_BUSY" => {}
        Err(error) => return Err(error),
    }
    let mut options = ConnectOptions::new(
        profile.to_owned(),
        Id::try_from("desktop-updater").expect("valid updater identity"),
        ClientKind::Desktop,
    );
    options.user_control_credential = Some(read_user_control_credential(profile)?);
    let client = HostClient::connect(options).await?;
    #[cfg(windows)]
    let process = client.observe_local_host_process().await?;
    client.request_shutdown(None).await?;
    // A shutdown reply alone does not release the instance lock or sidecar handles.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match reserve_host_instance(&namespace) {
            Ok(reservation) => {
                client.verify_local_shutdown_completed().await?;
                #[cfg(windows)]
                tokio::task::spawn_blocking(move || {
                    process.wait_for_clean_exit(
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    )
                })
                .await
                .map_err(|_| {
                    HostError::new(
                        "SHUTDOWN_INCOMPLETE",
                        "Cannot observe the old Host process exit",
                    )
                })??;
                return Ok(reservation);
            }
            Err(error) if error.code == "HOST_BUSY" => {}
            Err(error) => return Err(error),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(HostError::new(
                "HOST_STOP_TIMEOUT",
                "The local Host profile was not released before installation",
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::RpcRequest;
    use serial_workbench_host::{
        Host,
        ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
    };
    use std::{
        future::{Future, pending},
        pin::Pin,
        sync::Arc,
    };

    struct FailedSettlement(Arc<Host>);

    impl RequestHandler for FailedSettlement {
        fn handle(&self, connection: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            self.0.handle(connection, request)
        }

        fn disconnected(&self, connection: &ConnectionContext) {
            self.0.disconnected(connection);
        }

        fn stop_requested(&self) -> Pin<Box<dyn Future<Output = ()> + Send>> {
            self.0.stop_requested()
        }

        fn shutdown(&self) -> Pin<Box<dyn Future<Output = HostResult<()>> + Send>> {
            let host = self.0.clone();
            Box::pin(async move {
                host.shutdown().await?;
                Err(HostError::new(
                    "STORAGE_UNAVAILABLE",
                    "Injected settlement failure",
                ))
            })
        }
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn desktop_install_reserves_profile_after_actual_host_shutdown() {
        let temp_root = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempfile::tempdir_in(temp_root).unwrap();
        let profile = directory.path();
        let mut server = HostServer::bind(profile).await.unwrap();
        let old_epoch = server.identity().instance_epoch;
        let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
        let running = tokio::spawn(async move { server.serve_until(host, pending()).await });

        let reserved = stop_and_reserve(profile).await.unwrap();
        running.await.unwrap().unwrap();
        assert!(matches!(
            reserve_host_instance(&profile.join("host-v0")),
            Err(error) if error.code == "HOST_BUSY"
        ));
        assert!(matches!(
            HostServer::bind(profile).await,
            Err(error) if error.code == "HOST_BUSY"
        ));

        drop(reserved);
        let restarted = HostServer::bind(profile).await.unwrap();
        assert!(restarted.identity().instance_epoch > old_epoch);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn desktop_install_waits_for_the_actual_windows_host_process() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let profile = directory.path().to_path_buf();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        let mut child = child
            .args([
                "--ignored",
                "--exact",
                "updater::host::tests::desktop_update_windows_host_child",
            ])
            .env("SWB_TEST_UPDATER_HOST_CHILD_PROFILE", &profile)
            .creation_flags(0x0800_0000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        wait_for_test_marker(&profile.join("ready")).await;
        let observer = HostClient::connect(ConnectOptions::new(
            profile.clone(),
            Id::try_from("update-verifier").unwrap(),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let old_epoch = observer.local_instance().1;
        let process = observer.observe_local_host_process().await.unwrap();
        let update_profile = profile.clone();
        let prepare = tokio::spawn(async move { stop_and_reserve(&update_profile).await });
        wait_for_test_marker(&profile.join("settled")).await;
        assert_eq!(
            process
                .wait_for_clean_exit(Duration::ZERO)
                .unwrap_err()
                .code,
            "HOST_STOP_TIMEOUT"
        );
        assert!(child.try_wait().unwrap().is_none());
        assert!(!prepare.is_finished());
        std::fs::write(profile.join("allow-exit"), []).unwrap();
        let reserved = prepare.await.unwrap().unwrap();
        assert!(child.try_wait().unwrap().unwrap().success());
        assert!(matches!(
            HostServer::bind(&profile).await,
            Err(error) if error.code == "HOST_BUSY"
        ));
        drop(reserved);
        let restarted = HostServer::bind(&profile).await.unwrap();
        assert!(restarted.identity().instance_epoch > old_epoch);
        eprintln!(
            "windows_update host_pid={pid} old_epoch={old_epoch} exited_before_install_ready=true"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawned by desktop_install_waits_for_the_actual_windows_host_process"]
    async fn desktop_update_windows_host_child() {
        let profile = std::path::PathBuf::from(
            std::env::var_os("SWB_TEST_UPDATER_HOST_CHILD_PROFILE").expect("isolated profile"),
        );
        let mut server = HostServer::bind(&profile).await.unwrap();
        let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
        std::fs::write(profile.join("ready"), []).unwrap();
        server.serve_until(host, pending()).await.unwrap();
        drop(server);
        std::fs::write(profile.join("settled"), []).unwrap();
        wait_for_test_marker(&profile.join("allow-exit")).await;
    }

    #[cfg(windows)]
    async fn wait_for_test_marker(path: &Path) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Host test marker missing: {}", path.display()));
    }

    #[tokio::test]
    async fn desktop_install_reserves_a_profile_before_its_first_host() {
        let temp_root = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempfile::tempdir_in(temp_root).unwrap();
        let profile = directory.path().join("new-profile");
        let reserved = stop_and_reserve(&profile).await.unwrap();
        assert!(matches!(
            HostServer::bind(&profile).await,
            Err(error) if error.code == "HOST_BUSY"
        ));
        assert!(!profile.join("host-v0/state.sqlite3").exists());
        drop(reserved);
        assert!(HostServer::bind(&profile).await.is_ok());
    }

    #[tokio::test]
    async fn desktop_install_rejects_released_lock_after_failed_settlement() {
        let temp_root = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempfile::tempdir_in(temp_root).unwrap();
        let profile = directory.path();
        let mut server = HostServer::bind(profile).await.unwrap();
        let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
        let handler = Arc::new(FailedSettlement(host));
        let running = tokio::spawn(async move { server.serve_until(handler, pending()).await });

        assert!(matches!(
            stop_and_reserve(profile).await,
            Err(error) if error.code == "SHUTDOWN_INCOMPLETE"
        ));
        assert_eq!(
            running.await.unwrap().unwrap_err().code,
            "STORAGE_UNAVAILABLE"
        );
        assert!(reserve_host_instance(&profile.join("host-v0")).is_ok());
    }
}
