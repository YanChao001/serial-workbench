//! 原生库测试的调度屏障与单次回执故障；产品不编译，不替代真实接纳/执行。
use serial_workbench_core::HostError;
use std::{
    sync::{Arc, Mutex, OnceLock, mpsc},
    time::Duration,
};
use tokio::sync::{oneshot, watch};

#[derive(Clone, Default)]
pub(crate) struct GateSlot(Arc<Mutex<Option<PendingGate>>>);
struct PendingGate {
    entered: oneshot::Sender<()>,
    resume: mpsc::Receiver<()>,
}
pub(crate) struct Gate {
    entered: oneshot::Receiver<()>,
    release: Option<mpsc::SyncSender<()>>,
}
impl GateSlot {
    pub(crate) fn arm(&self) -> Gate {
        let (entered, waiting) = oneshot::channel();
        let (release, resume) = mpsc::sync_channel(1);
        let mut slot = self.0.lock().unwrap();
        assert!(slot.is_none(), "Native gate is already armed");
        *slot = Some(PendingGate { entered, resume });
        Gate {
            entered: waiting,
            release: Some(release),
        }
    }
    pub(crate) fn arrive(&self) {
        let gate = self.0.lock().unwrap().take();
        if let Some(PendingGate { entered, resume }) = gate {
            let _ = entered.send(());
            resume
                .recv_timeout(Duration::from_secs(5))
                .expect("Native gate was not released");
        }
    }
}
impl Gate {
    pub(crate) async fn entered(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), &mut self.entered)
            .await
            .expect("Native gate was not entered")
            .expect("Native gate owner ended");
    }
    pub(crate) fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.try_send(());
        }
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) fn registry_copy_compiler_ready() -> &'static GateSlot {
    static GATE: OnceLock<GateSlot> = OnceLock::new();
    GATE.get_or_init(GateSlot::default)
}

#[derive(Clone)]
pub(crate) struct NativeExit {
    pub process_id: u32,
    pub reaped: bool,
    pub error: Option<HostError>,
}
#[derive(Clone)]
pub(crate) struct NodeTestGates {
    pub fail_child_receipt_once: Arc<std::sync::atomic::AtomicBool>,
    pub fail_dispose_request_once: Arc<std::sync::atomic::AtomicBool>,
    pub fail_recovery_worker_once: Arc<std::sync::atomic::AtomicBool>,
    pub task_operation_read_ready: GateSlot,
    pub task_raw_read_ready: GateSlot,
    pub task_derived_ready: GateSlot,
    pub recovery_failed_scan: GateSlot,
    pub recovery_snapshot_busy: GateSlot,
    pub recovery_before_release: GateSlot,
    pub waiting_for_recovery: GateSlot,
    pub recovery_failure_publish: GateSlot,
    pub recovery_before_restore: GateSlot,
    pub recovery_before_scan: GateSlot,
    pub recovery_scan_completed: GateSlot,
    pub activation_request_joined: GateSlot,
    pub activation_before_enqueue: GateSlot,
    pub activation_request_enqueued: GateSlot,
    pub upgrade_before_commit: GateSlot,
    pub query_resolved: GateSlot,
    pub action_before_accept: GateSlot,
    pub action_lookup_missing: GateSlot,
    pub before_dispose: GateSlot,
    pub disable_before_commit: GateSlot,
    pub disable_after_commit: GateSlot,
    pub before_dispose_restore: GateSlot,
    pub dispose_restore_failed: GateSlot,
    pub exit_publish_failed: GateSlot,
    pub quiesce_signalled: GateSlot,
    pub before_authority: GateSlot,
    pub exited: watch::Sender<Option<NativeExit>>,
}
impl Default for NodeTestGates {
    fn default() -> Self {
        Self {
            fail_child_receipt_once: Arc::default(),
            fail_dispose_request_once: Arc::default(),
            fail_recovery_worker_once: Arc::default(),
            task_operation_read_ready: GateSlot::default(),
            task_raw_read_ready: GateSlot::default(),
            task_derived_ready: GateSlot::default(),
            recovery_failed_scan: GateSlot::default(),
            recovery_snapshot_busy: GateSlot::default(),
            recovery_before_release: GateSlot::default(),
            waiting_for_recovery: GateSlot::default(),
            recovery_failure_publish: GateSlot::default(),
            recovery_before_restore: GateSlot::default(),
            recovery_before_scan: GateSlot::default(),
            recovery_scan_completed: GateSlot::default(),
            activation_request_joined: GateSlot::default(),
            activation_before_enqueue: GateSlot::default(),
            activation_request_enqueued: GateSlot::default(),
            upgrade_before_commit: GateSlot::default(),
            query_resolved: GateSlot::default(),
            action_before_accept: GateSlot::default(),
            action_lookup_missing: GateSlot::default(),
            before_dispose: GateSlot::default(),
            disable_before_commit: GateSlot::default(),
            disable_after_commit: GateSlot::default(),
            before_dispose_restore: GateSlot::default(),
            dispose_restore_failed: GateSlot::default(),
            exit_publish_failed: GateSlot::default(),
            quiesce_signalled: GateSlot::default(),
            before_authority: GateSlot::default(),
            exited: watch::channel(None).0,
        }
    }
}
impl NodeTestGates {
    pub(crate) fn observe_exit(&self, report: &crate::node_backend::NodeBackendExit) {
        self.exited.send_replace(Some(NativeExit {
            process_id: report.process_id,
            reaped: report.reaped,
            error: report.error.clone(),
        }));
    }
}
