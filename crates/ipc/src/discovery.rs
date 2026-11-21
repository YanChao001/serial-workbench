use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use std::{fs, io::Read, path::Path};

/// 本地发现文件只提供连接提示，不能替代受保护 identity pin 与握手认证。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryRecord {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub endpoint: String,
    pub pid: u32,
    pub protocol_version: ProtocolVersion,
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
