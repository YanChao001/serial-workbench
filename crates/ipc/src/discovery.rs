use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use std::{fs, io::Read, path::Path};

#[derive(Clone, Copy, Serialize, Deserialize)]
pub enum DiscoveryFormat {
    // 1.0 was emitted by a v1 development candidate before separating the wire and record.
    #[serde(rename = "0.1", alias = "1.0")]
    V0_1,
}

/// 本地发现文件只提供连接提示，不能替代受保护 identity pin 与握手认证。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryRecord {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub endpoint: String,
    pub pid: u32,
    /// Historical discovery format field. The actual RPC version is negotiated on the connection.
    #[serde(rename = "protocolVersion")]
    pub format: DiscoveryFormat,
    /// 本地开发版本核对提示；不替代身份 pin、OS 对端校验或握手。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<std::path::PathBuf>,
}
impl DiscoveryRecord {
    pub fn read(path: &Path) -> HostResult<Self> {
        let bytes = read_bounded_metadata(path, 65536).ok_or_else(unavailable)?;
        serde_json::from_slice(&bytes).map_err(|_| unavailable())
    }
    pub fn write(&self, path: &Path) -> HostResult<()> {
        crate::write_atomic(path, &serde_json::to_vec(self).map_err(|_| unavailable())?)
    }
}

pub(crate) fn read_bounded_metadata(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn unavailable() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Host discovery is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_namespace() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let namespace = root.path().join("host-v0");
        crate::prepare_private_directory(&namespace).unwrap();
        (root, namespace)
    }

    #[test]
    fn discovery_source_written_before_wire_upgrade_remains_readable() {
        let (_root, namespace) = private_namespace();
        let saved = namespace.join("discovery.json");
        let legacy = br#"{
            "hostId":"fixture-host",
            "instanceEpoch":"7",
            "endpoint":"fixture-endpoint",
            "pid":123,
            "protocolVersion":"0.1"
        }"#;
        crate::write_atomic(&saved, legacy).unwrap();
        let discovered = DiscoveryRecord::read(&saved).unwrap();
        assert_eq!(discovered.host_id.as_str(), "fixture-host");
        assert_eq!(discovered.instance_epoch, U64::from(7));

        let published = namespace.join("published.json");
        discovered.write(&published).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(published).unwrap()).unwrap(),
            serde_json::from_slice::<serde_json::Value>(legacy).unwrap()
        );
        assert_eq!(ProtocolVersion::V1_0.as_wire(), "1.0");
    }

    #[test]
    fn discovery_republishes_draft_format_and_rejects_future_records() {
        let (_root, namespace) = private_namespace();
        let saved = namespace.join("discovery.json");
        let mut draft = serde_json::json!({
            "hostId":"fixture-host",
            "instanceEpoch":"7",
            "endpoint":"fixture-endpoint",
            "pid":123,
            "protocolVersion":"1.0"
        });
        crate::write_atomic(&saved, &serde_json::to_vec(&draft).unwrap()).unwrap();
        DiscoveryRecord::read(&saved)
            .unwrap()
            .write(&saved)
            .unwrap();
        let normalized: serde_json::Value =
            serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        assert_eq!(normalized["protocolVersion"], "0.1");

        draft["protocolVersion"] = serde_json::json!("2.0");
        crate::write_atomic(&saved, &serde_json::to_vec(&draft).unwrap()).unwrap();
        assert!(DiscoveryRecord::read(&saved).is_err());
    }
}
