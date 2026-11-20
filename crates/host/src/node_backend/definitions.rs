//! 从已验证manifest编译实际处理器的输入输出边界；不加载网络或文件schema。
mod parameters;
use super::error;
use serial_workbench_core::{
    ActionKind, ActionSpec, Call, HostResult, NodePackageManifest, NodePackageRegistration, Query,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(super) const MAX_BACKTRACK_LIMIT: usize = 1_000_000;

#[derive(Default)]
pub(super) struct Definitions(BTreeMap<String, Arc<Definition>>);
pub(super) struct Definition {
    spec: ActionSpec,
    input: parameters::CompiledSchema,
    output: parameters::CompiledSchema,
}
impl Definitions {
    pub(super) fn compile(
        manifest: &NodePackageManifest,
        backtrack_limit: usize,
    ) -> HostResult<Self> {
        let mut items = BTreeMap::new();
        for spec in manifest
            .contributes
            .queries
            .iter()
            .chain(&manifest.contributes.actions)
        {
            if spec.target_kinds.iter().any(|kind| {
                spec.permissions.iter().any(|permission| {
                    !manifest.permissions.host_api.iter().any(|scope| {
                        scope.target_kinds.contains(kind) && scope.permissions.contains(permission)
                    })
                })
            }) {
                return Err(error(
                    "PERMISSION_DENIED",
                    if spec.kind == ActionKind::Query {
                        "backendQueryPluginScope"
                    } else {
                        "backendActionPluginScope"
                    },
                ));
            }
            let input = parameters::CompiledSchema::compile(
                &spec.input_schema,
                backtrack_limit,
                spec.kind,
            )?;
            let output = parameters::CompiledSchema::compile(
                &spec.output_schema,
                backtrack_limit,
                spec.kind,
            )?;
            items.insert(
                spec.action_id.as_str().to_owned(),
                Arc::new(Definition {
                    spec: spec.clone(),
                    input,
                    output,
                }),
            );
        }
        Ok(Self(items))
    }
    pub(super) fn select(mut self, registration: &NodePackageRegistration) -> Self {
        let selected: BTreeSet<&str> = registration
            .contributes
            .queries
            .iter()
            .chain(&registration.contributes.actions)
            .map(|id| id.as_str())
            .collect();
        self.0.retain(|id, _| selected.contains(id.as_str()));
        self
    }
    pub(super) fn get(&self, id: &str) -> HostResult<Arc<Definition>> {
        self.0
            .get(id)
            .cloned()
            .ok_or_else(|| error("UNSUPPORTED_CAPABILITY", "backendHandlerNotRegistered"))
    }
    pub(super) fn definitions(&self) -> Vec<Arc<Definition>> {
        self.0.values().cloned().collect()
    }
}
impl Definition {
    pub(super) fn spec(&self) -> &ActionSpec {
        &self.spec
    }
    pub(super) fn normalize_parameters(
        &self,
        params: &serial_workbench_core::JsonObject,
    ) -> HostResult<serial_workbench_core::JsonObject> {
        self.input.normalize(params)
    }
    pub(super) fn validate_input(&self, query: &Query) -> HostResult<()> {
        self.validate_parameters(
            ActionKind::Query,
            &query.action_id,
            &query.host_id,
            &query.target,
            &query.params,
        )
    }
    pub(super) fn validate_call(&self, call: &Call) -> HostResult<()> {
        self.validate_parameters(
            ActionKind::Action,
            &call.action_id,
            &call.host_id,
            &call.target,
            &call.params,
        )
    }
    pub(super) fn validate_check(&self, query: &Query) -> HostResult<()> {
        self.validate_parameters(
            self.spec.kind,
            &query.action_id,
            &query.host_id,
            &query.target,
            &query.params,
        )
    }
    fn validate_parameters(
        &self,
        kind: ActionKind,
        action_id: &serial_workbench_core::Id,
        host_id: &serial_workbench_core::Id,
        target: &serial_workbench_core::Target,
        params: &serial_workbench_core::JsonObject,
    ) -> HostResult<()> {
        target.validate()?;
        let (target_reason, input_reason) = match kind {
            ActionKind::Query => ("backendQueryTarget", "backendQueryInput"),
            ActionKind::Action => ("backendActionTarget", "backendActionInput"),
        };
        if self.spec.kind != kind
            || action_id != &self.spec.action_id
            || host_id != &target.host_id
            || !self.spec.target_kinds.contains(&target.kind)
        {
            return Err(error("INVALID_ARGUMENT", target_reason));
        }
        let value =
            serde_json::to_value(params).map_err(|_| error("INVALID_ARGUMENT", input_reason))?;
        self.input
            .validate(&value, "INVALID_ARGUMENT", input_reason)
    }
    pub(super) fn validate_output(&self, value: &serde_json::Value) -> HostResult<()> {
        self.output.validate(
            value,
            if self.spec.kind == ActionKind::Query {
                "NODE_QUERY_FAILED"
            } else {
                "NODE_ACTION_FAILED"
            },
            if self.spec.kind == ActionKind::Query {
                "backendQueryOutput"
            } else {
                "backendActionOutput"
            },
        )
    }
}
pub(super) fn normalize_parameters(
    spec: &ActionSpec,
    params: &serial_workbench_core::JsonObject,
) -> HostResult<serial_workbench_core::JsonObject> {
    parameters::CompiledSchema::compile(&spec.input_schema, MAX_BACKTRACK_LIMIT, spec.kind)?
        .normalize(params)
}
fn validate(
    validator: &jsonschema::Validator,
    value: &serde_json::Value,
    code: &str,
    reason: &str,
) -> HostResult<()> {
    validator.validate(value).map_err(|failure| {
        error(
            if matches!(
                failure.kind(),
                jsonschema::error::ValidationErrorKind::BacktrackLimitExceeded { .. }
            ) {
                "LIMIT_EXCEEDED"
            } else {
                code
            },
            reason,
        )
    })
}
fn validation_options<'a>(
    draft: jsonschema::Draft,
    backtrack_limit: usize,
) -> jsonschema::ValidationOptions<'a> {
    jsonschema::options()
        .with_draft(draft)
        .offline()
        .with_pattern_options(
            jsonschema::PatternOptions::fancy_regex()
                .backtrack_limit(backtrack_limit)
                .size_limit(10 * 1024 * 1024)
                .dfa_size_limit(2 * 1024 * 1024),
        )
}
fn compile(
    value: &serde_json::Value,
    backtrack_limit: usize,
    kind: ActionKind,
) -> HostResult<(jsonschema::Validator, parameters::GraphReservation)> {
    let reason = match kind {
        ActionKind::Query => "backendQuerySchema",
        ActionKind::Action => "backendActionSchema",
    };
    let draft = match value.get("$schema").and_then(serde_json::Value::as_str) {
        None
        | Some(
            "http://json-schema.org/draft-07/schema#" | "http://json-schema.org/draft-07/schema",
        ) => jsonschema::Draft::Draft7,
        Some(
            "https://json-schema.org/draft/2020-12/schema"
            | "https://json-schema.org/draft/2020-12/schema#",
        ) => jsonschema::Draft::Draft202012,
        _ => {
            return Err(error(
                "NODE_SCHEMA_INVALID",
                match kind {
                    ActionKind::Query => "backendQuerySchemaDialect",
                    ActionKind::Action => "backendActionSchemaDialect",
                },
            ));
        }
    };
    let graph = parameters::check_compiler_budget(value, draft)?;
    let validator = validation_options(draft, backtrack_limit)
        .build(value)
        .map_err(|_| error("NODE_SCHEMA_INVALID", reason))?;
    Ok((validator, graph))
}
