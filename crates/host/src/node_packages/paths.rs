use super::{invalid, limit};
use serial_workbench_core::{HostResult, NodePackagePath};
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

#[derive(Default)]
pub(super) struct PackagePaths {
    entries: HashMap<String, (String, bool)>,
}
impl PackagePaths {
    pub fn add(
        &mut self,
        raw: &[u8],
        directory: bool,
        max_bytes: usize,
        max_nodes: usize,
    ) -> HostResult<String> {
        let name = std::str::from_utf8(raw).map_err(|_| invalid("nonUtf8Path"))?;
        let name = if directory {
            name.strip_suffix('/')
                .ok_or_else(|| invalid("directoryPath"))?
        } else {
            name
        };
        if name.len() > max_bytes {
            return Err(limit("pathBytes"));
        }
        NodePackagePath::try_from(name)?;
        let mut original = String::new();
        let mut folded = String::new();
        let mut components = name.split('/').peekable();
        while let Some(component) = components.next() {
            validate_component(component)?;
            if !original.is_empty() {
                original.push('/');
                folded.push('/');
            }
            original.push_str(component);
            // 文件系统规范化和不区分大小写的目标均不得把两个声明合并。
            let key: String = component.nfc().flat_map(char::to_uppercase).nfc().collect();
            folded.push_str(&key);
            let file = components.peek().is_none() && !directory;
            if let Some((previous, previous_file)) = self.entries.get(&folded) {
                if previous != &original || *previous_file || file {
                    return Err(invalid("pathAliasOrTypeConflict"));
                }
            } else {
                if self.entries.len() >= max_nodes {
                    return Err(limit("pathNodes"));
                }
                self.entries
                    .insert(folded.clone(), (original.clone(), file));
            }
        }
        Ok(name.into())
    }
}

fn validate_component(component: &str) -> HostResult<()> {
    if component.len() > 255 {
        return Err(limit("pathComponentBytes"));
    }
    if component.ends_with(['.', ' ']) || component.contains(['<', '>', '"', '|', '?', '*']) {
        return Err(invalid("nonPortablePath"));
    }
    let basename = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    let device = matches!(
        basename.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if device {
        return Err(invalid("reservedDevicePath"));
    }
    Ok(())
}
