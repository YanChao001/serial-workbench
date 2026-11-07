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
}
impl DiscoveryRecord {
    pub fn read(path: &Path) -> HostResult<Self> {
        let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
        if !metadata.file_type().is_file() || metadata.len() > 65536 {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| unavailable())?
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > 65536 {
            return Err(unavailable());
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable())
    }
    pub fn write(&self, path: &Path) -> HostResult<()> {
        crate::write_atomic(path, &serde_json::to_vec(self).map_err(|_| unavailable())?)
    }
}
fn unavailable() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Host discovery is unavailable")
}
