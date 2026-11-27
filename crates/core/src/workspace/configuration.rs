use crate::{
    CommandDraft, CommandGroup, Digest, HostError, HostResult, Id, NodePackageId,
    NodePackageVersion, U64, WorkspaceDocument,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;

pub const WORKSPACE_CONFIGURATION_FORMAT: &str = "serial-workbench-configuration";
pub const WORKSPACE_CONFIGURATION_VERSION: u32 = 1;
pub const WORKSPACE_CONFIGURATION_BYTES: usize = 192 * 1024;
pub const WORKSPACE_CONFIGURATION_COMMANDS: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfiguration {
    pub format: String,
    pub version: u32,
    pub workspace: WorkspaceDocument,
    pub groups: Vec<CommandGroup>,
    pub commands: Vec<CommandDraft>,
    pub scripts: Vec<WorkspaceScriptReference>,
    pub credential_refs: Vec<WorkspaceCredentialReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceScriptReference {
    pub package_id: NodePackageId,
    pub version: NodePackageVersion,
    pub archive_sha256: Digest,
    pub action_id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCredentialReference {
    pub slot: Id,
    pub host_id: Id,
    pub reference_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfigurationInspection {
    pub configuration: WorkspaceConfiguration,
    pub workspace_revision: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub command_revision: Option<U64>,
    pub script_statuses: Vec<WorkspaceScriptStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceScriptStatus {
    Matched,
    Missing,
    Changed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfigurationImportParams {
    pub json: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub command_revision: Option<U64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfigurationImportResult {
    pub workspace: crate::WorkspaceDocumentResult,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub command_revision: Option<U64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfigurationExportParams {
    pub workspace_revision: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub command_revision: Option<U64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[specta(optional)]
    pub command_ids: Vec<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Vec<WorkspaceScriptReference>")]
    #[specta(type = Vec<WorkspaceScriptReference>, optional)]
    pub scripts: Option<Vec<WorkspaceScriptReference>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStartupPlanParams {
    pub workspace_revision: U64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStartupSelection {
    pub workspace_id: Id,
    pub workspace_revision: U64,
    pub reference: WorkspaceScriptReference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStartupPlan {
    pub scope: crate::StateScopeRef,
    pub workspace_revision: U64,
    pub scripts: Vec<WorkspaceStartupScript>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStartupScript {
    pub reference: WorkspaceScriptReference,
    pub status: WorkspaceScriptStatus,
    pub target_kinds: Vec<crate::ResourceKind>,
}

impl WorkspaceConfigurationExportParams {
    pub fn validate(&self) -> HostResult<()> {
        if self.command_ids.len() > WORKSPACE_CONFIGURATION_COMMANDS
            || self
                .scripts
                .as_ref()
                .is_some_and(|scripts| scripts.len() > WORKSPACE_CONFIGURATION_COMMANDS)
        {
            return Err(configuration_size_error());
        }
        if self.command_ids.is_empty() == self.command_revision.is_some()
            || self.command_ids.iter().collect::<HashSet<_>>().len() != self.command_ids.len()
        {
            return Err(invalid_configuration());
        }
        Ok(())
    }
}

impl WorkspaceConfiguration {
    pub fn parse(json: &str) -> HostResult<Self> {
        if json.len() > WORKSPACE_CONFIGURATION_BYTES {
            return Err(configuration_size_error());
        }

        // 先判断格式和版本，避免把未来版本新增的字段误报为损坏。
        #[derive(Deserialize)]
        struct Header {
            format: String,
            version: u32,
        }

        let header: Header = serde_json::from_str(json).map_err(|_| invalid_configuration())?;
        if header.format != WORKSPACE_CONFIGURATION_FORMAT {
            return Err(invalid_configuration());
        }
        if header.version > WORKSPACE_CONFIGURATION_VERSION {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "Unsupported workspace configuration package version",
            ));
        }
        if header.version != WORKSPACE_CONFIGURATION_VERSION {
            return Err(invalid_configuration());
        }

        let value: Self = serde_json::from_str(json).map_err(|_| invalid_configuration())?;
        value.validate_sections()?;
        Ok(value)
    }

    pub fn to_json(&self) -> HostResult<String> {
        if self.format != WORKSPACE_CONFIGURATION_FORMAT
            || self.version != WORKSPACE_CONFIGURATION_VERSION
        {
            return Err(invalid_configuration());
        }
        self.validate_sections()?;
        let json = serde_json::to_string(self).map_err(|_| invalid_configuration())?;
        if json.len() > WORKSPACE_CONFIGURATION_BYTES {
            return Err(configuration_size_error());
        }
        Ok(json)
    }

    fn validate_sections(&self) -> HostResult<()> {
        self.workspace.validate()?;
        if self.workspace.archived || !self.workspace.captures.is_empty() {
            return Err(invalid_configuration());
        }

        let mut groups = HashSet::new();
        for group in &self.groups {
            group.validate()?;
            if !groups.insert(&group.id) {
                return Err(invalid_configuration());
            }
        }

        let mut commands = HashSet::new();
        for command in &self.commands {
            command.validate()?;
            if !groups.contains(&command.summary.group_id) || !commands.insert(&command.summary.id)
            {
                return Err(invalid_configuration());
            }
        }

        let mut scripts = HashSet::new();
        let mut credentials = HashSet::new();
        if !self
            .scripts
            .iter()
            .all(|script| scripts.insert((&script.package_id, &script.action_id)))
            || !self
                .credential_refs
                .iter()
                .all(|credential| credentials.insert(&credential.slot))
        {
            return Err(invalid_configuration());
        }
        Ok(())
    }
}

fn configuration_size_error() -> HostError {
    HostError::new(
        "LIMIT_EXCEEDED",
        "Workspace configuration package exceeds the size limit",
    )
}

fn invalid_configuration() -> HostError {
    HostError::new(
        "INVALID_DOCUMENT",
        "Invalid workspace configuration package",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn configuration() -> Value {
        json!({
            "format": "serial-workbench-configuration",
            "version": 1,
            "workspace": WorkspaceDocument {
                name: "Modbus 调试".into(),
                ..WorkspaceDocument::default()
            },
            "groups": [{"id": "modbus", "name": "Modbus"}],
            "commands": [{
                "summary": {"id": "read", "groupId": "modbus", "name": "Read", "note": ""},
                "body": "01 03 00 00",
                "mode": "hex",
                "encoding": "utf-8"
            }],
            "scripts": [{
                "packageId": "swb.builtin.modbus",
                "version": "0.3.0",
                "archiveSha256": "d".repeat(64),
                "actionId": "swb.builtin.modbus.transact"
            }],
            "credentialRefs": [{
                "slot": "gateway",
                "hostId": "host-a",
                "referenceId": "credential-25"
            }]
        })
    }

    #[test]
    fn configuration_keeps_commands_scripts_and_opaque_credentials() {
        let input = configuration();
        let value = WorkspaceConfiguration::parse(&input.to_string()).unwrap();
        assert_eq!(value.workspace.name, "Modbus 调试");
        assert_eq!(value.groups[0].id.as_str(), "modbus");
        assert_eq!(value.commands[0].body, "01 03 00 00");
        assert_eq!(
            value.scripts[0].action_id.as_str(),
            "swb.builtin.modbus.transact"
        );
        assert_eq!(
            value.credential_refs[0].reference_id.as_str(),
            "credential-25"
        );
        assert_eq!(serde_json::to_value(value).unwrap(), input);
    }

    #[test]
    fn configuration_rejects_future_versions_before_reading_new_fields() {
        let error = WorkspaceConfiguration::parse(
            r#"{"format":"serial-workbench-configuration","version":2,"futureContent":[]}"#,
        )
        .unwrap_err();
        assert_eq!(error.code, "FUTURE_FORMAT");
    }

    #[test]
    fn configuration_rejects_unknown_secrets_and_dangling_references() {
        let mut secret = configuration();
        secret["credentialRefs"][0]["password"] = json!("fixture-secret");
        let mut broken = configuration();
        broken["commands"][0]["summary"]["groupId"] = json!("missing");
        let mut repeated = configuration();
        let commands = repeated["commands"].as_array_mut().unwrap();
        commands.push(commands[0].clone());
        for input in [secret, broken, repeated] {
            assert_eq!(
                WorkspaceConfiguration::parse(&input.to_string())
                    .unwrap_err()
                    .code,
                "INVALID_DOCUMENT"
            );
        }
    }

    #[test]
    fn configuration_rejects_files_outside_the_request_budget() {
        let oversized = " ".repeat(WORKSPACE_CONFIGURATION_BYTES + 1);
        assert_eq!(
            WorkspaceConfiguration::parse(&oversized).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
    }
}
