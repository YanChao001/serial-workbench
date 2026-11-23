use super::{integrity, storage};
use serde::{Deserialize, Serialize};
use serial_workbench_core::HostResult;
use std::{fs, path::Path};
use windows_registry::{CURRENT_USER, Key};
use windows_sys::Win32::System::Registry::{KEY_QUERY_VALUE, KEY_SET_VALUE, RegFlushKey};

const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const MAIN_BINARY: &str = "serial-workbench.exe";
const UNINSTALLER: &str = "uninstall.exe";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Values {
    version: String,
    kib: u32,
}

/// 仅更新一个已存在、且仍指向原物理安装位置的当前用户 NSIS 卸载项。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallRegistration {
    product: String,
    previous: Values,
    candidate: Values,
}

impl InstallRegistration {
    pub fn capture(
        active: &Path,
        product: &str,
        previous_version: &str,
        candidate_version: &str,
        candidate_kib: u32,
    ) -> HostResult<Self> {
        if !valid_version(previous_version)
            || !valid_version(candidate_version)
            || previous_version == candidate_version
            || candidate_kib == 0
        {
            return Err(integrity());
        }
        let key = open_install_key(active, product, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        let previous = read_values(&key)?;
        if previous.version != previous_version {
            return Err(integrity());
        }
        Ok(Self {
            product: product.into(),
            previous,
            candidate: Values {
                version: candidate_version.into(),
                kib: candidate_kib,
            },
        })
    }

    pub(super) fn verify(&self, active: &Path, committed: bool) -> HostResult<()> {
        let key = open_install_key(active, &self.product, KEY_QUERY_VALUE)?;
        if read_values(&key)? != *self.target(committed) {
            return Err(integrity());
        }
        Ok(())
    }

    pub(super) fn settle(&self, active: &Path, committed: bool) -> HostResult<()> {
        let key = open_install_key(active, &self.product, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        let actual = read_values(&key)?;
        if ![&self.previous.version, &self.candidate.version].contains(&&actual.version)
            || ![self.previous.kib, self.candidate.kib].contains(&actual.kib)
        {
            return Err(integrity());
        }
        let expected = self.target(committed);
        if actual.version != expected.version {
            key.set_string("DisplayVersion", &expected.version)
                .map_err(|_| storage())?;
        }
        if actual.kib != expected.kib {
            key.set_u32("EstimatedSize", expected.kib)
                .map_err(|_| storage())?;
        }
        if unsafe { RegFlushKey(key.as_raw()) } != 0 {
            return Err(storage());
        }
        if read_values(&key)? != *expected {
            return Err(integrity());
        }
        Ok(())
    }

    fn target(&self, committed: bool) -> &Values {
        if committed {
            &self.candidate
        } else {
            &self.previous
        }
    }
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 96
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn open_install_key(active: &Path, product: &str, access: u32) -> HostResult<Key> {
    if product.trim() != product
        || product.is_empty()
        || product.len() > 180
        || product
            .chars()
            .any(|character| character.is_control() || matches!(character, '\\' | '/'))
    {
        return Err(integrity());
    }
    let key = CURRENT_USER
        .options()
        .access(access)
        .open(format!(r"{UNINSTALL_ROOT}\{product}"))
        .map_err(|_| storage())?;
    if key.get_string("DisplayName").map_err(|_| storage())? != product
        || !key
            .get_string("MainBinaryName")
            .map_err(|_| storage())?
            .eq_ignore_ascii_case(MAIN_BINARY)
        || !same_path(
            &key.get_string("InstallLocation").map_err(|_| storage())?,
            active,
        )
        || !same_path(
            &key.get_string("UninstallString").map_err(|_| storage())?,
            &active.join(UNINSTALLER),
        )
    {
        return Err(integrity());
    }
    Ok(key)
}

fn same_path(stored: &str, expected: &Path) -> bool {
    let Some(path) = stored
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return false;
    };
    let path = Path::new(path);
    if !path.is_absolute() {
        return false;
    }
    match (fs::canonicalize(path), fs::canonicalize(expected)) {
        (Ok(stored), Ok(expected)) => stored == expected,
        _ => false,
    }
}

fn read_values(key: &Key) -> HostResult<Values> {
    let version = key.get_string("DisplayVersion").map_err(|_| storage())?;
    let kib = key.get_u32("EstimatedSize").map_err(|_| storage())?;
    if !valid_version(&version) {
        return Err(integrity());
    }
    Ok(Values { version, kib })
}
