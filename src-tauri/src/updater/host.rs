use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::{ClientKind, HostError, HostResult, Id};
use serial_workbench_ipc::{
    PrivateFileLock, reserve_host_instance, shutdown::verify_idle_profile_shutdown,
};
use std::{path::Path, time::Duration};

use crate::error::{ErrorCode, NativeError};

const STOP_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn install_error(error: HostError) -> NativeError {
    if error.code == "SHUTDOWN_INCOMPLETE" {
        return NativeError::operation(
            ErrorCode::UpdateHostRecoveryRequired,
            "Restart Serial Workbench from the current installation, then check for updates again",
            error,
        );
    }
    NativeError::operation(
        ErrorCode::UpdateInstallFailed,
        "Cannot confirm local Host shutdown before installing the update",
        error,
    )
}

pub(super) async fn stop_and_reserve(profile: &Path) -> HostResult<PrivateFileLock> {
    let idle_profile = profile.to_owned();
    match inspect_local_host(move || {
        let reservation = reserve_host_instance(&idle_profile.join("host-v0"))?;
        verify_idle_profile_shutdown(&idle_profile, STOP_TIMEOUT)?;
        Ok(reservation)
    })
    .await
    {
        Ok(reservation) => return Ok(reservation),
        Err(error) if error.code == "HOST_BUSY" => {}
        Err(error) => return Err(error),
    }
    let mut options = ConnectOptions::new(
        profile.to_owned(),
        Id::try_from("desktop-updater").expect("valid updater identity"),
        ClientKind::Desktop,
    );
    let active_profile = profile.to_owned();
    options.user_control_credential =
        Some(inspect_local_host(move || read_user_control_credential(&active_profile)).await?);
    let client = HostClient::connect(options).await?;
    #[cfg(windows)]
    let process = client.observe_local_host_process().await?;
    client.request_shutdown(None).await?;
    // 接纳回执出来后，继续等待已结算的关停证明和实际进程退出。
    let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
    loop {
        let namespace = profile.join("host-v0");
        match inspect_local_host(move || reserve_host_instance(&namespace)).await {
            Ok(reservation) => {
                return inspect_local_host(move || {
                    #[cfg(not(windows))]
                    client.verify_local_shutdown_completed()?;
                    #[cfg(windows)]
                    client.verify_local_shutdown_exit(
                        &process,
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    )?;
                    Ok(reservation)
                })
                .await;
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

async fn inspect_local_host<T: Send + 'static>(
    task: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    crate::blocking::run(move || Ok(task()))
        .await
        .map_err(|_| HostError::new("SHUTDOWN_INCOMPLETE", "Cannot inspect the local Host"))?
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
        check_windows_process_exit(false, 0, false).await;
        check_windows_process_exit(true, 0, false).await;
        check_windows_process_exit(false, 7, false).await;
        check_windows_process_exit(false, 0, true).await;
    }

    #[cfg(windows)]
    async fn check_windows_process_exit(
        shutdown_before_prepare: bool,
        expected_exit: i32,
        cancel_preparation: bool,
    ) {
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
            .env("SWB_TEST_UPDATER_HOST_EXIT", expected_exit.to_string())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        wait_for_test_marker(&profile.join("ready")).await;
        let mut options = ConnectOptions::new(
            profile.clone(),
            Id::try_from("update-verifier").unwrap(),
            ClientKind::Desktop,
        );
        if shutdown_before_prepare {
            options.user_control_credential = Some(read_user_control_credential(&profile).unwrap());
        }
        let observer = HostClient::connect(options).await.unwrap();
        let old_epoch = observer.local_instance().1;
        if shutdown_before_prepare {
            observer.request_shutdown(None).await.unwrap();
            wait_for_test_marker(&profile.join("settled")).await;
            assert!(!serial_workbench_ipc::profile_has_running_host(&profile).unwrap());
        }
        let update_profile = profile.clone();
        let prepare = tokio::spawn(async move { stop_and_reserve(&update_profile).await });
        wait_for_test_marker(&profile.join("settled")).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assert!(
                    !prepare.is_finished(),
                    "installation became ready before Host exit"
                );
                if serial_workbench_ipc::profile_has_running_host(&profile).unwrap() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(child.try_wait().unwrap().is_none());
        assert!(!prepare.is_finished());
        if cancel_preparation {
            let pending = profile.join(format!("host-v0/shutdown-exit-{old_epoch}.json"));
            wait_for_test_marker(&pending).await;
            prepare.abort();
            assert!(
                prepare
                    .await
                    .err()
                    .expect("cancelled preparation")
                    .is_cancelled()
            );
            assert!(serial_workbench_ipc::profile_has_running_host(&profile).unwrap());
            std::fs::write(profile.join("allow-exit"), []).unwrap();
            assert!(child.wait().await.unwrap().success());
            wait_until_profile_idle(&profile).await;
            drop(stop_and_reserve(&profile).await.unwrap());
            eprintln!(
                "windows_update host_pid={pid} old_epoch={old_epoch} cancellation_retained_instance_lock=true"
            );
            return;
        }
        std::fs::write(profile.join("allow-exit"), []).unwrap();
        let outcome = prepare.await.unwrap();
        assert_eq!(
            child.try_wait().unwrap().unwrap().code(),
            Some(expected_exit)
        );
        drop(child);
        drop(observer);
        if expected_exit == 0 {
            let reserved = outcome.unwrap();
            assert!(matches!(
                HostServer::bind(&profile).await,
                Err(error) if error.code == "HOST_BUSY"
            ));
            drop(reserved);
            drop(stop_and_reserve(&profile).await.unwrap());
        } else {
            let first = outcome.err().expect("nonzero exit must refuse install");
            let retry = stop_and_reserve(&profile)
                .await
                .err()
                .expect("nonzero exit persists");
            assert!(first.message.contains("status 7"));
            assert_eq!(retry, first);
            assert_eq!(
                install_error(retry).code,
                ErrorCode::UpdateHostRecoveryRequired
            );
        }
        let restarted = HostServer::bind(&profile).await.unwrap();
        assert!(restarted.identity().instance_epoch > old_epoch);
        eprintln!(
            "windows_update host_pid={pid} old_epoch={old_epoch} idle_retry={shutdown_before_prepare} exit_code={expected_exit} repeated_after_handles_closed=true"
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
        let code: i32 = std::env::var("SWB_TEST_UPDATER_HOST_EXIT")
            .unwrap()
            .parse()
            .unwrap();
        if code != 0 {
            std::process::exit(code);
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires actual previous and current bundled Windows Host executables"]
    async fn desktop_install_recovers_through_current_host_after_legacy_shutdown() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let profile = directory.path();
        let legacy_binary = std::env::var_os("SWB_TEST_UPDATER_LEGACY_HOST_BIN").unwrap();
        let current_binary = std::env::var_os("SWB_TEST_UPDATER_CURRENT_HOST_BIN").unwrap();
        let manual_start =
            std::env::var("SWB_TEST_UPDATER_MANUAL_HOST_START").as_deref() == Ok("1");
        let mut legacy = spawn_fixture_host(&legacy_binary, profile);
        let mut options = ConnectOptions::new(
            profile.to_path_buf(),
            Id::try_from("update-legacy-verifier").unwrap(),
            ClientKind::Desktop,
        );
        let previous = attach_fixture_host(&options).await;
        let (host_id, old_epoch) = previous.local_instance();
        let host_id = host_id.clone();
        options.expected_host_id = Some(host_id.clone());
        options.expected_host_executable = Some(std::path::PathBuf::from(&current_binary));
        let blocked = stop_and_reserve(profile)
            .await
            .err()
            .expect("legacy has no new receipt");
        assert_eq!(
            install_error(blocked).code,
            ErrorCode::UpdateHostRecoveryRequired
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(10), legacy.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        drop(previous);
        assert!(!profile.join("host-v0/shutdown-complete.json").exists());
        // 显式选择受 Windows Job 限制时的启动方式，保留独立桌面的自动启动用例。
        let (recovered, mut manual_host, startup) = if manual_start {
            let host = spawn_fixture_host(&current_binary, profile);
            (attach_fixture_host(&options).await, Some(host), "manual")
        } else {
            (
                HostClient::connect_or_start(options).await.unwrap(),
                None,
                "automatic",
            )
        };
        let (recovered_id, recovered_epoch) = recovered.local_instance();
        assert_eq!(recovered_id, &host_id);
        assert!(recovered_epoch > old_epoch);
        drop(stop_and_reserve(profile).await.unwrap());
        drop(stop_and_reserve(profile).await.unwrap());
        if let Some(host) = &mut manual_host {
            assert!(host.try_wait().unwrap().unwrap().success());
        }
        eprintln!(
            "windows_legacy_update startup={startup} old_epoch={old_epoch} recovered_epoch={recovered_epoch} current_host_settled=true"
        );
    }

    #[cfg(windows)]
    fn spawn_fixture_host(binary: &std::ffi::OsStr, profile: &Path) -> tokio::process::Child {
        tokio::process::Command::new(binary)
            .arg("--profile")
            .arg(profile)
            .creation_flags(0x0800_0000)
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[cfg(windows)]
    async fn attach_fixture_host(options: &ConnectOptions) -> HostClient {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match HostClient::connect(options.clone()).await {
                    Ok(client) => break client,
                    Err(error)
                        if matches!(error.code.as_str(), "HOST_BUSY" | "STORAGE_UNAVAILABLE") => {}
                    Err(error) => panic!("Host fixture did not attach: {error:?}"),
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("Host fixture did not attach before the deadline")
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

    #[cfg(windows)]
    async fn wait_until_profile_idle(profile: &Path) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while serial_workbench_ipc::profile_has_running_host(profile).unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the detached observation must release the instance lock");
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
        assert!(!serial_workbench_ipc::profile_has_host_state(&profile).unwrap());
        let host = HostServer::bind(&profile).await.unwrap();
        assert!(serial_workbench_ipc::profile_has_host_state(&profile).unwrap());
        drop(host);
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
        assert!(matches!(
            stop_and_reserve(profile).await,
            Err(error) if error.code == "SHUTDOWN_INCOMPLETE"
        ));
    }
}
