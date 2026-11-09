//! Volatile platform effects sourced only from the trusted Host connection.
use crate::{
    error::{ErrorCode, NativeError, NativeResult},
    network::NetworkMode,
};
use serial_workbench_core::{Id, SettingsSnapshot, SharedSettings, U64};
use std::sync::Mutex;
#[derive(Default)]
pub struct PlatformSettings {
    current: Mutex<Option<(Id, U64, SettingsSnapshot)>>,
}
impl PlatformSettings {
    pub(crate) fn apply(
        &self,
        host: Id,
        epoch: U64,
        document: SettingsSnapshot,
    ) -> NativeResult<()> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| NativeError::new(ErrorCode::Internal, "Platform settings unavailable"))?;
        if current
            .as_ref()
            .is_some_and(|(current_host, current_epoch, previous)| {
                current_host == &host
                    && (epoch < *current_epoch
                        || (epoch == *current_epoch && document.revision < previous.revision))
            })
        {
            return Err(NativeError::new(
                ErrorCode::Conflict,
                "Stale Host settings cannot replace platform effects",
            ));
        }
        *current = Some((host, epoch, document));
        Ok(())
    }
    pub fn value(&self) -> NativeResult<SharedSettings> {
        self.current
            .lock()
            .map(|current| {
                current
                    .as_ref()
                    .map_or_else(SharedSettings::default, |(_, _, document)| {
                        document.value.clone()
                    })
            })
            .map_err(|_| NativeError::new(ErrorCode::Internal, "Platform settings unavailable"))
    }
    pub fn revision(&self) -> NativeResult<Option<U64>> {
        self.current
            .lock()
            .map(|current| current.as_ref().map(|(_, _, document)| document.revision))
            .map_err(|_| NativeError::new(ErrorCode::Internal, "Platform settings unavailable"))
    }
    pub fn run_in_background(&self) -> bool {
        self.value().is_ok_and(|value| value.run_in_background)
    }
    pub fn network_mode(&self) -> NativeResult<NetworkMode> {
        self.value().map(|value| {
            if value.network_mode == serial_workbench_core::settings::NetworkMode::Direct {
                NetworkMode::Direct
            } else {
                NetworkMode::System
            }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_host_snapshot_updates_volatile_effects_and_rejects_older_revision() {
        let platform = PlatformSettings::default();
        assert!(!platform.run_in_background());
        let mut settings = SharedSettings::default();
        settings.run_in_background = true;
        settings.network_mode = serial_workbench_core::settings::NetworkMode::Direct;
        platform
            .apply(
                Id::try_from("local-host").unwrap(),
                1.into(),
                SettingsSnapshot {
                    revision: 4.into(),
                    value: settings,
                },
            )
            .unwrap();
        assert!(platform.run_in_background());
        assert_eq!(platform.network_mode().unwrap(), NetworkMode::Direct);
        assert!(
            platform
                .apply(
                    Id::try_from("local-host").unwrap(),
                    1.into(),
                    SettingsSnapshot {
                        revision: 3.into(),
                        value: SharedSettings::default()
                    }
                )
                .is_err()
        );
        assert!(platform.run_in_background());
    }
    #[test]
    fn late_previous_host_epoch_cannot_replace_current_platform_effects() {
        let platform = PlatformSettings::default();
        platform
            .apply(
                Id::try_from("local-host").unwrap(),
                2.into(),
                SettingsSnapshot {
                    revision: 0.into(),
                    value: SharedSettings::default(),
                },
            )
            .unwrap();
        let old = SharedSettings {
            run_in_background: true,
            ..SharedSettings::default()
        };
        assert!(
            platform
                .apply(
                    Id::try_from("local-host").unwrap(),
                    1.into(),
                    SettingsSnapshot {
                        revision: 99.into(),
                        value: old
                    }
                )
                .is_err()
        );
        assert!(!platform.run_in_background());
    }
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlatformEffects {
    pub tray_language: bool,
    pub network_mode: bool,
    pub run_in_background: bool,
}
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsEffectsReceipt {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub revision: U64,
    pub effects: PlatformEffects,
}

pub(crate) fn next_effects_request_id()
-> serial_workbench_core::HostResult<serial_workbench_core::RequestId> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| {
            serial_workbench_core::HostError::new(
                "COUNTER_EXHAUSTED",
                "Platform request identity exhausted",
            )
        })?;
    // 查询不进入持久操作日志；进程内序号隔离所有窗口的同时在途请求。
    serial_workbench_core::RequestId::try_from(
        format!(
            "00000000-0000-0000-{:04x}-{:012x}",
            sequence >> 48,
            sequence & 0x0000_ffff_ffff_ffff
        )
        .as_str(),
    )
}
#[cfg(test)]
mod request_tests {
    #[test]
    fn overlapping_effect_reads_have_distinct_request_ids() {
        let first = std::thread::spawn(super::next_effects_request_id);
        let second = std::thread::spawn(super::next_effects_request_id);
        assert_ne!(
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap()
        );
    }
}
