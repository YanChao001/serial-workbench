//! The debugger shares the dispatch lifetime and keeps its pause data out of the store.
use super::error;
use serde::Deserialize;
use serial_workbench_core::{HostError, HostResult, ScriptDebugCommand, ScriptDebugSnapshot};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub(crate) fn debugger_unavailable() -> HostError {
    HostError::new(
        "SCRIPT_DEBUG_UNAVAILABLE",
        "Script debugging is unavailable",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum DebugCommandOutcome {
    #[serde(rename = "accepted")]
    Accepted,
    InvalidArgument,
    RevisionConflict,
    HostBusy,
    ScriptDebugUnavailable,
}
impl DebugCommandOutcome {
    pub(super) fn result(self) -> HostResult<()> {
        match self {
            Self::Accepted => Ok(()),
            Self::InvalidArgument => Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid script debug command",
            )),
            Self::RevisionConflict => Err(HostError::new(
                "REVISION_CONFLICT",
                "The script pause has changed",
            )),
            Self::HostBusy => Err(HostError::new(
                "HOST_BUSY",
                "A script debug command is pending",
            )),
            Self::ScriptDebugUnavailable => Err(debugger_unavailable()),
        }
    }
}

struct PendingCommand {
    command: Option<ScriptDebugCommand>,
    reply: oneshot::Sender<HostResult<()>>,
}
struct LiveDebugger {
    snapshot: ScriptDebugSnapshot,
    pending: Option<PendingCommand>,
}
pub(crate) struct ScriptDebugSession {
    breakpoints: Vec<u32>,
    live: Mutex<Option<LiveDebugger>>,
}
pub(crate) struct ScriptDebugLease(pub(crate) Arc<ScriptDebugSession>);

impl Drop for ScriptDebugLease {
    fn drop(&mut self) {
        self.0.close();
    }
}

impl ScriptDebugSession {
    pub(crate) fn new(breakpoints: Vec<u32>) -> HostResult<Self> {
        if breakpoints.is_empty()
            || breakpoints.len() > 32
            || breakpoints.iter().any(|line| !(1..=65_537).contains(line))
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid script breakpoints",
            ));
        }
        Ok(Self {
            breakpoints,
            live: Mutex::new(Some(LiveDebugger {
                snapshot: ScriptDebugSnapshot::Starting { revision: 0.into() },
                pending: None,
            })),
        })
    }

    pub(super) fn breakpoints(&self) -> &[u32] {
        &self.breakpoints
    }

    pub(crate) fn snapshot(&self) -> HostResult<ScriptDebugSnapshot> {
        let live = self.live.lock().map_err(|_| debugger_unavailable())?;
        live.as_ref()
            .map(|live| live.snapshot.clone())
            .ok_or_else(debugger_unavailable)
    }

    pub(crate) fn submit(
        &self,
        command: ScriptDebugCommand,
    ) -> HostResult<oneshot::Receiver<HostResult<()>>> {
        let mut live = self.live.lock().map_err(|_| debugger_unavailable())?;
        let live = live.as_mut().ok_or_else(debugger_unavailable)?;
        if !matches!(&live.snapshot, ScriptDebugSnapshot::Paused { .. })
            || live.snapshot.revision() != command.revision()
        {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "The script pause has changed",
            ));
        }
        if live.pending.is_some() {
            return Err(HostError::new(
                "HOST_BUSY",
                "A script debug command is pending",
            ));
        }
        let (reply, outcome) = oneshot::channel();
        live.pending = Some(PendingCommand {
            command: Some(command),
            reply,
        });
        Ok(outcome)
    }

    pub(super) fn take_command(&self) -> Option<ScriptDebugCommand> {
        self.live
            .lock()
            .ok()?
            .as_mut()?
            .pending
            .as_mut()?
            .command
            .take()
    }

    pub(super) fn complete(&self, result: HostResult<()>) {
        if let Ok(mut live) = self.live.lock()
            && let Some(pending) = live.as_mut().and_then(|live| live.pending.take())
        {
            let _ = pending.reply.send(result);
        }
    }

    pub(super) fn observe(&self, snapshot: ScriptDebugSnapshot) -> HostResult<()> {
        let mut live = self.live.lock().map_err(|_| debugger_unavailable())?;
        let Some(live) = live.as_mut() else {
            return Ok(());
        };
        let bounded = match &snapshot {
            ScriptDebugSnapshot::Running { .. } => true,
            ScriptDebugSnapshot::Paused {
                frames,
                selected_frame,
                variables,
                ..
            } => {
                frames.len() <= 12
                    && usize::from(*selected_frame) < frames.len()
                    && frames.iter().all(|frame| {
                        frame.name.encode_utf16().count() <= 96
                            && (1..=65_537).contains(&frame.line)
                            && (1..=65_537).contains(&frame.column)
                    })
                    && variables.len() <= 24
                    && variables.iter().all(|variable| {
                        variable.name.encode_utf16().count() <= 96
                            && variable.preview.encode_utf16().count() <= 160
                    })
            }
            ScriptDebugSnapshot::Starting { .. } => false,
        };
        if !bounded || live.snapshot.revision().checked_next()? != snapshot.revision() {
            return Err(error("PROTOCOL_ERROR", "backendScriptDebugSnapshot"));
        }
        live.snapshot = snapshot;
        Ok(())
    }

    pub(super) fn close(&self) {
        if let Ok(mut live) = self.live.lock()
            && let Some(pending) = live.take().and_then(|live| live.pending)
        {
            let _ = pending.reply.send(Err(debugger_unavailable()));
        }
    }
}
