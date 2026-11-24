//! 可移交的已脱敏实验包。配置可导入，依赖和运行结果仅作证据。
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};

pub const EXPERIMENT_VERSION: &str = "1";
pub const EXPERIMENT_JSON_BYTES: usize = 192 * 1024;
const MAX_ITEMS: usize = 64;

fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid experiment package")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentExportParams {
    pub workspace_revision: U64,
    pub parsers: Vec<NodePackageId>,
    pub recordings: Vec<ObjectRef>,
    pub firmware: Vec<ExperimentFirmware>,
    pub operations: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentFirmware {
    /// 工作区绑定数组的一基序号。
    pub binding: u32,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentParser {
    pub id: NodePackageId,
    pub version: String,
    pub archive_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentRecording {
    pub reference: ObjectRef,
    pub fingerprint: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentRun {
    pub action_id: Id,
    pub state: OperationState,
    pub settled_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentPackage {
    pub format_version: String,
    pub workspace: WorkspaceDocument,
    pub parsers: Vec<ExperimentParser>,
    pub recordings: Vec<ExperimentRecording>,
    pub firmware: Vec<ExperimentFirmware>,
    pub runs: Vec<ExperimentRun>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentDependency {
    Matched,
    Missing,
    Changed,
    Unavailable,
    OtherHost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentInspection {
    pub experiment: ExperimentPackage,
    pub parser_status: Vec<ExperimentDependency>,
    pub recording_status: Vec<ExperimentDependency>,
}

fn bounded(lengths: &[usize]) -> HostResult<()> {
    if lengths.iter().any(|count| *count > MAX_ITEMS) {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Experiment dependency count exceeds the limit",
        ));
    }
    Ok(())
}

fn unique<T: Eq + std::hash::Hash>(values: impl IntoIterator<Item = T>) -> HostResult<()> {
    let mut found = HashSet::new();
    if values.into_iter().all(|value| found.insert(value)) {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

fn firmware(values: &[ExperimentFirmware], bindings: usize) -> HostResult<()> {
    unique(values.iter().map(|item| item.binding))?;
    if values.iter().any(|item| {
        item.binding == 0 || item.binding as usize > bindings || !version(&item.version)
    }) {
        return Err(invalid());
    }
    Ok(())
}

fn recordings<'a>(values: impl IntoIterator<Item = &'a ObjectRef>) -> HostResult<()> {
    let mut found = HashSet::new();
    for item in values {
        if !matches!(item.kind.as_str(), "file" | "capture")
            || !found.insert((&item.host_id, &item.id))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

impl ExperimentExportParams {
    pub fn validate(&self, bindings: usize) -> HostResult<()> {
        bounded(&[
            self.parsers.len(),
            self.recordings.len(),
            self.firmware.len(),
            self.operations.len(),
        ])?;
        unique(&self.parsers)?;
        recordings(&self.recordings)?;
        unique(&self.operations)?;
        firmware(&self.firmware, bindings)
    }
}

impl ExperimentPackage {
    pub fn validate(&self) -> HostResult<()> {
        if self.format_version != EXPERIMENT_VERSION {
            return Err(HostError::new(
                "UNSUPPORTED_FORMAT",
                "Unsupported experiment package version",
            ));
        }
        bounded(&[
            self.parsers.len(),
            self.recordings.len(),
            self.firmware.len(),
            self.runs.len(),
        ])?;
        unique(self.parsers.iter().map(|item| &item.id))?;
        recordings(self.recordings.iter().map(|item| &item.reference))?;
        firmware(&self.firmware, self.workspace.bindings.len())?;
        if self.parsers.iter().any(|item| !version(&item.version))
            || self
                .recordings
                .iter()
                .any(|item| item.reference.revision.is_none())
            || self.runs.iter().any(|item| !item.state.is_terminal())
            || portable_experiment_workspace(self.workspace.clone())? != self.workspace
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub fn check_size(&self) -> HostResult<()> {
        let encoded = serde_json::to_vec(self).map_err(|_| invalid())?;
        if encoded.len() > EXPERIMENT_JSON_BYTES {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Experiment package exceeds the size limit",
            ));
        }
        Ok(())
    }

    pub fn parse(json: &str) -> HostResult<Self> {
        if json.len() > EXPERIMENT_JSON_BYTES {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Experiment package exceeds the size limit",
            ));
        }
        let value: serde_json::Value = serde_json::from_str(json).map_err(|_| invalid())?;
        if value
            .get("formatVersion")
            .and_then(|version| version.as_str())
            .is_some_and(|version| version != EXPERIMENT_VERSION)
        {
            return Err(HostError::new(
                "UNSUPPORTED_FORMAT",
                "Unsupported experiment package version",
            ));
        }
        // 以原始文本解码，serde 可拒绝重复键及未知字段。
        let package: Self = serde_json::from_str(json).map_err(|_| invalid())?;
        package.validate()?;
        Ok(package)
    }
}

pub fn portable_experiment_workspace(
    mut workspace: WorkspaceDocument,
) -> HostResult<WorkspaceDocument> {
    workspace.validate()?;
    workspace.name.clear();
    workspace.archived = false;
    workspace.captures.clear();
    let mut bindings = HashMap::new();
    let detached_host = Id::try_from("experiment-unbound").expect("static Host");
    for (index, binding) in workspace.bindings.iter_mut().enumerate() {
        let portable = Id::try_from(format!("experiment-device-{}", index + 1).as_str())?;
        bindings.insert(binding.binding_id.clone(), portable.clone());
        binding.binding_id = portable.clone();
        binding.host_id = detached_host.clone();
        binding.device_id = portable;
        binding.port_name = None;
        binding.fingerprint.serial_number = None;
        binding.fingerprint.topology_path = None;
        binding.fingerprint.evidence = IdentityEvidence::Unreliable;
        binding.reconnect.enabled = false;
    }
    for (index, view) in workspace.views.iter_mut().enumerate() {
        view.binding_id = bindings.get(&view.binding_id).ok_or_else(invalid)?.clone();
        view.id = Id::try_from(format!("experiment-view-{}", index + 1).as_str())?;
        view.name = format!("View {}", index + 1);
        if view.color.len() != 7
            || !view.color.starts_with('#')
            || !view.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            view.color = "#64748b".into();
        }
        view.icon = "terminal".into();
    }
    for favorite in &mut workspace.favorite_binding_ids {
        *favorite = bindings.get(favorite).ok_or_else(invalid)?.clone();
    }
    Ok(workspace)
}
