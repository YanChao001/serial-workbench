use crate::*;
use schemars::{JsonSchema, generate::SchemaSettings};
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Query,
    Action,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocation {
    ResourceHost,
    Client,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum Cancellation {
    None,
    Cooperative,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionSpec {
    pub action_id: Id,
    pub kind: ActionKind,
    pub input_schema: SchemaObject,
    pub output_schema: SchemaObject,
    pub target_kinds: Vec<ResourceKind>,
    pub execution_location: ExecutionLocation,
    pub permissions: Vec<String>,
    pub state_scopes: Vec<String>,
    pub event_types: Vec<String>,
    pub cancellation: Cancellation,
    pub reveal_target: RevealTarget,
}
pub struct ActionMetadata {
    pub action_id: Id,
    pub kind: ActionKind,
    pub target_kinds: Vec<ResourceKind>,
    pub execution_location: ExecutionLocation,
    pub permissions: Vec<String>,
    pub state_scopes: Vec<String>,
    pub event_types: Vec<String>,
    pub cancellation: Cancellation,
    pub reveal_target: RevealTarget,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaDialect {
    Draft07,
    Draft202012,
}
impl ActionSpec {
    pub fn of<I: JsonSchema, O: JsonSchema>(meta: ActionMetadata) -> Self {
        Self::of_with_dialect::<I, O>(meta, SchemaDialect::Draft07)
    }
    pub fn of_with_dialect<I: JsonSchema, O: JsonSchema>(
        meta: ActionMetadata,
        dialect: SchemaDialect,
    ) -> Self {
        Self {
            action_id: meta.action_id,
            kind: meta.kind,
            input_schema: serde_json::from_value(schema_for::<I>(dialect)).expect("schema object"),
            output_schema: serde_json::from_value(schema_for::<O>(dialect)).expect("schema object"),
            target_kinds: meta.target_kinds,
            execution_location: meta.execution_location,
            permissions: meta.permissions,
            state_scopes: meta.state_scopes,
            event_types: meta.event_types,
            cancellation: meta.cancellation,
            reveal_target: meta.reveal_target,
        }
    }
}
pub fn schema<T: JsonSchema>() -> serde_json::Value {
    schema_for::<T>(SchemaDialect::Draft07)
}
pub fn schema_for<T: JsonSchema>(dialect: SchemaDialect) -> serde_json::Value {
    serde_json::to_value(
        match dialect {
            SchemaDialect::Draft07 => SchemaSettings::draft07(),
            SchemaDialect::Draft202012 => SchemaSettings::draft2020_12(),
        }
        .into_generator()
        .into_root_schema_for::<T>(),
    )
    .expect("schema serializes")
}
/// 只有已经实现的 handler 才能进入目录；业务任务在接线时添加目录项。
pub fn builtin_catalog() -> Vec<ActionSpec> {
    BuiltinAction::ALL
        .iter()
        .map(|action| action.spec())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinAction {
    CatalogList,
    OperationGet,
    OperationCancel,
    StateSnapshot,
    StateSubscribe,
    SubscriptionClose,
    Authorize,
    Revoke,
}
impl BuiltinAction {
    pub const ALL: [Self; 8] = [
        Self::CatalogList,
        Self::OperationGet,
        Self::OperationCancel,
        Self::StateSnapshot,
        Self::StateSubscribe,
        Self::SubscriptionClose,
        Self::Authorize,
        Self::Revoke,
    ];
    pub fn action_id(self) -> &'static str {
        match self {
            Self::CatalogList => "catalog.list",
            Self::OperationGet => "operation.get",
            Self::OperationCancel => "operation.cancel",
            Self::StateSnapshot => "state.snapshot",
            Self::StateSubscribe => "state.subscribe",
            Self::SubscriptionClose => "subscription.close",
            Self::Authorize => "auth.authorize",
            Self::Revoke => "auth.revoke",
        }
    }
    pub fn find(id: &str) -> HostResult<Self> {
        Self::ALL
            .into_iter()
            .find(|action| action.action_id() == id)
            .ok_or_else(|| {
                HostError::new("UNSUPPORTED_CAPABILITY", "Action handler is not registered")
            })
    }
    pub fn spec(self) -> ActionSpec {
        static SPECS: std::sync::LazyLock<Vec<ActionSpec>> = std::sync::LazyLock::new(|| {
            BuiltinAction::ALL
                .into_iter()
                .map(|action| action.build_spec(SchemaDialect::Draft07))
                .collect()
        });
        SPECS[Self::ALL
            .iter()
            .position(|action| *action == self)
            .expect("builtin action")]
        .clone()
    }
    pub fn spec_with_dialect(self, dialect: SchemaDialect) -> ActionSpec {
        if dialect == SchemaDialect::Draft07 {
            self.spec()
        } else {
            self.build_spec(dialect)
        }
    }
    fn build_spec(self, dialect: SchemaDialect) -> ActionSpec {
        let action = matches!(self, Self::OperationCancel | Self::Authorize | Self::Revoke);
        let auth = matches!(self, Self::Authorize | Self::Revoke);
        let kinds: &[&str] = match self {
            Self::OperationCancel => &["operation"],
            Self::StateSnapshot | Self::StateSubscribe => &["host", "workspace", "session"],
            Self::OperationGet => &["host", "operation"],
            _ => &["host"],
        };
        let meta = ActionMetadata {
            action_id: Id::try_from(self.action_id()).expect("builtin Id"),
            kind: if action {
                ActionKind::Action
            } else {
                ActionKind::Query
            },
            target_kinds: kinds
                .iter()
                .map(|kind| ResourceKind::try_from(*kind).expect("builtin kind"))
                .collect(),
            execution_location: ExecutionLocation::ResourceHost,
            permissions: vec![if auth { "auth.manage" } else { "metadata.read" }.into()],
            state_scopes: vec![
                if action {
                    "host.operations"
                } else {
                    "host.activity"
                }
                .into(),
            ],
            event_types: vec![
                if action {
                    "operations.changed"
                } else {
                    "activity.changed"
                }
                .into(),
            ],
            cancellation: Cancellation::None,
            reveal_target: RevealTarget {
                page_id: Id::try_from("workbench").expect("page"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        };
        match self {
            Self::CatalogList => {
                ActionSpec::of_with_dialect::<CatalogListParams, CatalogListResult>(meta, dialect)
            }
            Self::OperationGet => {
                ActionSpec::of_with_dialect::<OperationGetParams, OperationResult>(meta, dialect)
            }
            Self::OperationCancel => ActionSpec::of_with_dialect::<
                OperationCancelParams,
                CancellationResult,
            >(meta, dialect),
            Self::StateSnapshot => {
                ActionSpec::of_with_dialect::<StateSnapshotParams, Snapshot>(meta, dialect)
            }
            Self::StateSubscribe => ActionSpec::of_with_dialect::<
                StateSubscribeParams,
                SubscriptionResult,
            >(meta, dialect),
            Self::SubscriptionClose => {
                ActionSpec::of_with_dialect::<SubscriptionCloseParams, ClosedResult>(meta, dialect)
            }
            Self::Authorize => {
                ActionSpec::of_with_dialect::<AuthorizeParams, AuthorizationResult>(meta, dialect)
            }
            Self::Revoke => {
                ActionSpec::of_with_dialect::<RevokeParams, AuthorizationResult>(meta, dialect)
            }
        }
    }
}
