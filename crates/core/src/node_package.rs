//! Node 正式包的公共元数据；执行、来源信任和文件系统责任由 Host 持有。
use crate::{
    ActionKind, ActionSpec, Digest, HostError, HostResult, Id, ProtocolVersion, ResourceKind,
    SchemaObject, SchemaValue, U64,
};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use specta::Type;
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    fmt,
};

/// 签名动作声明此字段后，Host 将解码后的输出保存为结果文件。
pub const NODE_FILE_RESULT_KEY: &str = "x-swb-file-result";

fn invalid_metadata() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Node package metadata")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Type)]
#[serde(transparent)]
pub struct NodePackageId(String);
impl NodePackageId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<&str> for NodePackageId {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        if value.len() > 128
            || !value.contains('.')
            || value.split('.').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            })
        {
            return Err(invalid_metadata());
        }
        Ok(Self(value.into()))
    }
}
impl<'de> Deserialize<'de> for NodePackageId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?.as_str())
            .map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for NodePackageId {
    fn schema_name() -> Cow<'static, str> {
        "NodePackageId".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string", "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+$"
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Type)]
#[serde(transparent)]
pub struct NodePackageVersion(String);
impl NodePackageVersion {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// 包版本升级使用 SemVer precedence，构建元数据变化本身不构成升级。
    pub fn is_upgrade_from(&self, installed: &Self) -> bool {
        let current = semver::Version::parse(&self.0).expect("validated package version");
        let previous = semver::Version::parse(&installed.0).expect("validated package version");
        current.cmp_precedence(&previous).is_gt()
    }
}
impl TryFrom<&str> for NodePackageVersion {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        semver::Version::parse(value).map_err(|_| invalid_metadata())?;
        Ok(Self(value.into()))
    }
}
impl<'de> Deserialize<'de> for NodePackageVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?.as_str())
            .map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for NodePackageVersion {
    fn schema_name() -> Cow<'static, str> {
        "NodePackageVersion".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let number = crate::identity::decimal_pattern(u64::MAX, 0);
        let number = &number[1..number.len() - 1];
        let pre = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
        let pattern = format!(
            "^{number}\\.{number}\\.{number}(?:-{pre}(?:\\.{pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
        );
        schemars::json_schema!({ "type": "string", "pattern": pattern })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Type)]
#[serde(transparent)]
pub struct NodePackagePath(String);
impl NodePackagePath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<&str> for NodePackagePath {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        if value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\\' | ':'))
            || value
                .split('/')
                .any(|component| component.is_empty() || matches!(component, "." | ".."))
        {
            return Err(invalid_metadata());
        }
        Ok(Self(value.into()))
    }
}
impl<'de> Deserialize<'de> for NodePackagePath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?.as_str())
            .map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for NodePackagePath {
    fn schema_name() -> Cow<'static, str> {
        "NodePackagePath".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let component = r"(?!\.{1,2}(?:/|$))[^/\\:\u0000-\u001F\u007F-\u009F]+";
        schemars::json_schema!({
            "type": "string", "pattern": format!("^{component}(?:/{component})*$")
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
pub enum NodePackageSchemaVersion {
    #[serde(rename = "0.1")]
    V0_1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageManifest {
    pub schema_version: NodePackageSchemaVersion,
    pub id: NodePackageId,
    pub version: NodePackageVersion,
    pub display_name: String,
    pub description: String,
    pub license: String,
    pub notices: Vec<NodePackagePath>,
    pub host_protocol_version: ProtocolVersion,
    pub runtime_ref: Id,
    pub main: NodePackagePath,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodePackageWebUi")]
    #[specta(type = NodePackageWebUi, optional)]
    pub web_ui: Option<NodePackageWebUi>,
    pub dependencies: Vec<NodePackageDependency>,
    pub platform_resources: Vec<NodePackageResource>,
    pub activation: Vec<Id>,
    pub permissions: NodePackagePermissions,
    pub contributes: NodePackageContributions,
    pub data_schema_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageWebUi {
    pub entry: NodePackagePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageDependency {
    pub name: String,
    pub version: NodePackageVersion,
    pub path: NodePackagePath,
    pub license: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, Type)]
pub enum NodePackageTarget {
    #[serde(rename = "x86_64-pc-windows-msvc")]
    WindowsX64,
    #[serde(rename = "aarch64-apple-darwin")]
    MacosArm64,
    #[serde(rename = "x86_64-apple-darwin")]
    MacosX64,
    #[serde(rename = "x86_64-unknown-linux-gnu")]
    LinuxX64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum NodePackageResourceKind {
    NativeAddon,
    Tool,
    Data,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageResource {
    pub id: Id,
    pub target: NodePackageTarget,
    pub path: NodePackagePath,
    pub kind: NodePackageResourceKind,
    pub version: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type = Id, optional)]
    pub runtime_ref: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeHostApiScope {
    pub permissions: Vec<String>,
    pub target_kinds: Vec<ResourceKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackagePermissions {
    pub host_api: Vec<NodeHostApiScope>,
    pub execution_purposes: Vec<String>,
    pub external_tools: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageContributions {
    pub actions: Vec<ActionSpec>,
    pub queries: Vec<ActionSpec>,
    pub transports: Vec<ActionSpec>,
    pub parsers: Vec<ActionSpec>,
    pub views: Vec<NodePackageView>,
    pub themes: Vec<NodePackageTheme>,
    pub configuration: Vec<ActionSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageView {
    pub id: Id,
    pub action_id: Id,
    pub state_scopes: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodePackageViewFeed")]
    #[specta(type = NodePackageViewFeed, optional)]
    pub feed: Option<NodePackageViewFeed>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum NodePackageViewFeed {
    Derived,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageTheme {
    pub id: Id,
    pub path: NodePackagePath,
    pub resource_schema: SchemaObject,
    pub configuration_action_id: Id,
}

pub const NODE_PACKAGE_SIGNATURE_PREFIX: &[u8] = b"serial-workbench-node-package-v0\n";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageIntegrity {
    pub schema_version: NodePackageSchemaVersion,
    pub id: NodePackageId,
    pub version: NodePackageVersion,
    pub source: Id,
    pub key_id: Id,
    pub files: Vec<NodePackageFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageFile {
    pub path: NodePackagePath,
    pub size: U64,
    pub sha256: Digest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
pub enum NodePackageSignatureAlgorithm {
    Ed25519,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub struct NodePackageSignatureBytes(String);
impl NodePackageSignatureBytes {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<&str> for NodePackageSignatureBytes {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 88
            || &bytes[86..] != b"=="
            || !bytes[..85]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+/".contains(byte))
            || !b"AQgw".contains(&bytes[85])
        {
            return Err(invalid_metadata());
        }
        Ok(Self(value.into()))
    }
}
impl<'de> Deserialize<'de> for NodePackageSignatureBytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?.as_str())
            .map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for NodePackageSignatureBytes {
    fn schema_name() -> Cow<'static, str> {
        "NodePackageSignatureBytes".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"string","pattern":"^[A-Za-z0-9+/]{85}[AQgw]==$"})
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageSignature {
    pub algorithm: NodePackageSignatureAlgorithm,
    pub key_id: Id,
    pub signature_base64: NodePackageSignatureBytes,
}

/// 登记只选择 manifest 中的贡献；目录元数据始终读取已验证的原声明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageRegistration {
    pub id: NodePackageId,
    pub version: NodePackageVersion,
    pub contributes: NodeContributionSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeContributionSelection {
    pub actions: Vec<Id>,
    pub queries: Vec<Id>,
    pub transports: Vec<Id>,
    pub parsers: Vec<Id>,
    pub views: Vec<Id>,
    pub themes: Vec<Id>,
    pub configuration: Vec<Id>,
}

impl NodePackageIntegrity {
    pub fn validate(&self) -> HostResult<()> {
        let mut previous: Option<&NodePackagePath> = None;
        let mut names = HashSet::new();
        for file in &self.files {
            let name = file.path.as_str().to_uppercase();
            if previous.is_some_and(|path| path >= &file.path)
                || matches!(name.as_str(), "INTEGRITY.JSON" | "SIGNATURE.JSON")
                || !names.insert(name)
            {
                return Err(invalid_metadata());
            }
            previous = Some(&file.path);
        }
        if !self
            .files
            .iter()
            .any(|file| file.path.as_str() == "manifest.json")
        {
            return Err(invalid_metadata());
        }
        Ok(())
    }

    fn contains_file(&self, path: &NodePackagePath) -> bool {
        self.files
            .binary_search_by(|file| file.path.cmp(path))
            .is_ok()
    }

    fn contains_dependency(&self, path: &NodePackagePath) -> bool {
        if self.contains_file(path) {
            return true;
        }
        let prefix = format!("{}/", path.as_str());
        let index = self
            .files
            .partition_point(|file| file.path.as_str() < prefix.as_str());
        self.files
            .get(index)
            .is_some_and(|file| file.path.as_str().starts_with(&prefix))
    }
}

/// 只验证元数据身份与载荷引用；文件内容、ZIP 边界及来源验签由 Host 验证。
pub fn validate_node_package_metadata(
    manifest: &NodePackageManifest,
    integrity: &NodePackageIntegrity,
) -> HostResult<()> {
    manifest.validate()?;
    integrity.validate()?;
    if manifest.id != integrity.id
        || manifest.version != integrity.version
        || !integrity.contains_file(&manifest.main)
        || manifest
            .web_ui
            .as_ref()
            .is_some_and(|ui| !integrity.contains_file(&ui.entry))
        || manifest
            .notices
            .iter()
            .any(|path| !integrity.contains_file(path))
        || manifest
            .dependencies
            .iter()
            .any(|dependency| !integrity.contains_dependency(&dependency.path))
        || manifest
            .platform_resources
            .iter()
            .any(|resource| !integrity.contains_file(&resource.path))
        || manifest
            .contributes
            .themes
            .iter()
            .any(|theme| !integrity.contains_file(&theme.path))
    {
        return Err(invalid_metadata());
    }
    Ok(())
}

impl NodePackageRegistration {
    pub fn validate_against(&self, manifest: &NodePackageManifest) -> HostResult<()> {
        manifest.validate()?;
        if self.id != manifest.id || self.version != manifest.version {
            return Err(invalid_metadata());
        }
        let declared_actions = |specs: &[ActionSpec]| -> HashSet<Id> {
            specs.iter().map(|spec| spec.action_id.clone()).collect()
        };
        let declared = [
            declared_actions(&manifest.contributes.actions),
            declared_actions(&manifest.contributes.queries),
            declared_actions(&manifest.contributes.transports),
            declared_actions(&manifest.contributes.parsers),
            manifest
                .contributes
                .views
                .iter()
                .map(|view| view.id.clone())
                .collect(),
            manifest
                .contributes
                .themes
                .iter()
                .map(|theme| theme.id.clone())
                .collect(),
            declared_actions(&manifest.contributes.configuration),
        ];
        let selected = [
            &self.contributes.actions,
            &self.contributes.queries,
            &self.contributes.transports,
            &self.contributes.parsers,
            &self.contributes.views,
            &self.contributes.themes,
            &self.contributes.configuration,
        ];
        for (ids, allowed) in selected.into_iter().zip(declared) {
            let mut unique = HashSet::new();
            if ids
                .iter()
                .any(|id| !allowed.contains(id) || !unique.insert(id))
            {
                return Err(invalid_metadata());
            }
        }
        Ok(())
    }
}

impl NodePackageManifest {
    pub fn validate(&self) -> HostResult<()> {
        let text = |value: &str| !value.trim().is_empty();
        if [
            &self.display_name,
            &self.description,
            &self.license,
            &self.data_schema_version,
        ]
        .iter()
        .any(|value| !text(value))
            || self.notices.is_empty()
            || self.permissions.execution_purposes.is_empty()
            || self
                .permissions
                .execution_purposes
                .iter()
                .any(|purpose| !text(purpose))
            || self.permissions.host_api.iter().any(|scope| {
                scope.target_kinds.is_empty()
                    || scope.permissions.iter().any(|permission| !text(permission))
            })
        {
            return Err(invalid_metadata());
        }
        let mut notices = HashSet::new();
        if self.notices.iter().any(|path| !notices.insert(path)) {
            return Err(invalid_metadata());
        }
        let mut dependency_paths = HashSet::new();
        if self.dependencies.iter().any(|dependency| {
            !text(&dependency.name)
                || !text(&dependency.license)
                || !dependency_paths.insert(&dependency.path)
        }) {
            return Err(invalid_metadata());
        }
        let mut resource_keys = HashSet::new();
        let mut tools = HashSet::new();
        for resource in &self.platform_resources {
            if !text(&resource.version)
                || !resource_keys.insert((&resource.id, resource.target))
                || resource.kind == NodePackageResourceKind::NativeAddon
                    && resource.runtime_ref.as_ref() != Some(&self.runtime_ref)
            {
                return Err(invalid_metadata());
            }
            if resource.kind == NodePackageResourceKind::Tool {
                tools.insert(&resource.id);
            }
        }
        if self
            .permissions
            .external_tools
            .iter()
            .any(|id| !tools.contains(id))
        {
            return Err(invalid_metadata());
        }

        let prefix = format!("{}.", self.id.as_str());
        let mut ids = HashSet::new();
        let mut declare = |id: &Id| -> HostResult<()> {
            if !id
                .as_str()
                .strip_prefix(&prefix)
                .is_some_and(|suffix| !suffix.is_empty())
                || !ids.insert(id.clone())
            {
                return Err(invalid_metadata());
            }
            Ok(())
        };
        let groups: [(&[ActionSpec], Option<ActionKind>); 5] = [
            (&self.contributes.actions, Some(ActionKind::Action)),
            (&self.contributes.queries, Some(ActionKind::Query)),
            (&self.contributes.transports, Some(ActionKind::Action)),
            (&self.contributes.parsers, Some(ActionKind::Action)),
            (&self.contributes.configuration, None),
        ];
        let mut actions = HashMap::new();
        for (specs, expected_kind) in groups {
            for spec in specs {
                declare(&spec.action_id)?;
                if let Some(format) = spec.output_schema.get(NODE_FILE_RESULT_KEY) {
                    let has_schema_value = |key, expected: &str| matches!(spec.output_schema.get(key), Some(SchemaValue::String(value)) if value == expected);
                    if spec.kind != ActionKind::Action
                        || !matches!(format, SchemaValue::String(value) if value == "image/svg+xml")
                        || !has_schema_value("type", "string")
                        || !has_schema_value("contentEncoding", "base64")
                    {
                        return Err(invalid_metadata());
                    }
                }
                if expected_kind.is_some_and(|kind| spec.kind != kind)
                    || spec.target_kinds.is_empty()
                    || spec
                        .permissions
                        .iter()
                        .chain(&spec.state_scopes)
                        .chain(&spec.event_types)
                        .any(|value| !text(value))
                {
                    return Err(invalid_metadata());
                }
                let scopes: HashSet<&str> = spec.state_scopes.iter().map(String::as_str).collect();
                actions.insert(spec.action_id.as_str(), (spec.kind, scopes));
            }
        }
        for view in &self.contributes.views {
            declare(&view.id)?;
            let Some((kind, scopes)) = actions.get(view.action_id.as_str()) else {
                return Err(invalid_metadata());
            };
            if self.web_ui.is_none()
                || *kind != ActionKind::Action
                || view
                    .state_scopes
                    .iter()
                    .any(|scope| !scopes.contains(scope.as_str()))
            {
                return Err(invalid_metadata());
            }
        }
        let configuration: HashSet<&Id> = self
            .contributes
            .configuration
            .iter()
            .map(|spec| &spec.action_id)
            .collect();
        for theme in &self.contributes.themes {
            declare(&theme.id)?;
            if !configuration.contains(&theme.configuration_action_id) {
                return Err(invalid_metadata());
            }
        }
        if self
            .activation
            .iter()
            .any(|id| id.as_str() != "startup" && !ids.contains(id))
        {
            return Err(invalid_metadata());
        }
        Ok(())
    }
}

/// 在 DTO/schema 映射丢失重复键之前检查所有层级的 JSON 对象。
struct UniqueJson(serde_json::Value);
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON with unique object keys")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| UniqueJson(number.into()))
                    .ok_or_else(|| E::custom("Non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(values.into()))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut object: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = object.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("Duplicate JSON object key"));
                    }
                    values.insert(key, object.next_value::<UniqueJson>()?.0);
                }
                Ok(UniqueJson(values.into()))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

fn decode_metadata<T: DeserializeOwned>(bytes: &[u8]) -> HostResult<T> {
    decode_node_json(bytes).map_err(|_| invalid_metadata())
}

pub(crate) fn decode_node_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueJson::deserialize(&mut deserializer)?;
    deserializer.end()?;
    serde_json::from_value(value.0)
}

pub fn parse_node_manifest(bytes: &[u8]) -> HostResult<NodePackageManifest> {
    let manifest: NodePackageManifest = decode_metadata(bytes)?;
    manifest.validate()?;
    Ok(manifest)
}

pub fn parse_node_integrity(bytes: &[u8]) -> HostResult<NodePackageIntegrity> {
    let integrity: NodePackageIntegrity = decode_metadata(bytes)?;
    integrity.validate()?;
    Ok(integrity)
}

pub fn parse_node_signature(bytes: &[u8]) -> HostResult<NodePackageSignature> {
    decode_metadata(bytes)
}

pub fn parse_node_registration(bytes: &[u8]) -> HostResult<NodePackageRegistration> {
    decode_metadata(bytes)
}
