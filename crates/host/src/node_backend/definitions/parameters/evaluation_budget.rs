//! 求值前约束可能的工作和诊断输出；同实例回边截断，非活动的重复引用仍分别累计。
use super::{
    Position, Prepared, SchemaScope, Work, address, dynamic_scope, encode_pointer, limit, measure,
};
use jsonschema::Draft;
use serde_json::Value;
use serial_workbench_core::HostResult;
use std::collections::HashMap;

const DETAIL_BYTES: usize = 512;
const SCHEMA_CONTAINERS: &[&str] = &[
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "dependentSchemas",
    "dependencies",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "items",
    "prefixItems",
    "additionalItems",
    "contains",
    "unevaluatedItems",
];
#[derive(Clone, Copy)]
enum Mode {
    Evaluate,
    Validate,
    Mark,
}
#[derive(Clone, Copy)]
struct Visit {
    depth: usize,
    instance_bytes: usize,
    evaluation_bytes: usize,
    mode: Mode,
    validations: usize,
}
impl Visit {
    fn child(
        self,
        keyword: &str,
        suffix: usize,
        instance: Option<usize>,
        validations: usize,
    ) -> HostResult<Self> {
        Ok(Self {
            depth: self.depth.checked_add(1).ok_or_else(limit)?,
            instance_bytes: self
                .instance_bytes
                .checked_add(instance.unwrap_or(0))
                .ok_or_else(limit)?,
            evaluation_bytes: self
                .evaluation_bytes
                .checked_add(keyword.len() + 1)
                .and_then(|n| n.checked_add(suffix))
                .ok_or_else(limit)?,
            validations,
            ..self
        })
    }
}
type ActiveReference = (usize, usize, String, Vec<String>, bool, String);
struct Budget<'a> {
    prepared: &'a Prepared,
    work: &'a mut Work,
    active: HashMap<ActiveReference, usize>,
}
fn pointer_segment(name: &str) -> usize {
    encode_pointer(&format!("/{}", name.replace('~', "~0").replace('/', "~1"))).len()
}
pub(super) fn max_schema_path(schema: &Value) -> HostResult<usize> {
    let mut work = Work::default();
    let mut pending = vec![(schema, 0usize, 0usize)];
    let mut longest = 0;
    while let Some((value, path, depth)) = pending.pop() {
        work.step(depth, DETAIL_BYTES)?;
        longest = longest.max(path);
        match value {
            Value::Object(object) => {
                if let Some(anchor) = object.get("$dynamicAnchor").and_then(Value::as_str) {
                    longest = longest.max(pointer_segment(anchor) + "/$defs".len());
                }
                for (name, value) in object {
                    pending.push((
                        value,
                        path.checked_add(pointer_segment(name)).ok_or_else(limit)?,
                        depth + 1,
                    ));
                }
            }
            Value::Array(array) => {
                for (index, value) in array.iter().enumerate() {
                    pending.push((
                        value,
                        path.checked_add(index.to_string().len() + 1)
                            .ok_or_else(limit)?,
                        depth + 1,
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(longest)
}
impl Prepared {
    pub(super) fn evaluation_budget(
        &self,
        scope: &SchemaScope<'_>,
        value: &Value,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        self.budget(scope, value, position, work, Mode::Evaluate)
    }
    pub(super) fn validation_budget(
        &self,
        scope: &SchemaScope<'_>,
        value: &Value,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        self.budget(scope, value, position, work, Mode::Validate)
    }
    fn budget(
        &self,
        scope: &SchemaScope<'_>,
        value: &Value,
        position: Position<'_>,
        work: &mut Work,
        mode: Mode,
    ) -> HostResult<()> {
        let wrappers = dynamic_scope(&scope.resolver, work, position.depth)?.len() + 1;
        work.charge(position.depth, wrappers * 2, wrappers * 2 * DETAIL_BYTES)?;
        Budget {
            prepared: self,
            work,
            active: HashMap::new(),
        }
        .node(
            scope,
            value,
            Visit {
                depth: position.depth,
                instance_bytes: position.path.len(),
                evaluation_bytes: wrappers * 7,
                mode,
                validations: 0,
            },
        )
    }
}
impl Budget<'_> {
    fn literal(&mut self, value: &Value, depth: usize) -> HostResult<()> {
        let bytes = match value {
            Value::String(text) => text
                .len()
                .checked_mul(2)
                .and_then(|n| n.checked_add(DETAIL_BYTES))
                .ok_or_else(limit)?,
            Value::Object(object) => (object.len() + 1).checked_mul(1024).ok_or_else(limit)?,
            Value::Array(array) => (array.len() + 1).checked_mul(64).ok_or_else(limit)?,
            _ => DETAIL_BYTES,
        };
        self.work.step(depth, bytes)?;
        match value {
            Value::Object(object) => {
                for (name, child) in object {
                    self.work
                        .step(depth, name.len().checked_mul(2).ok_or_else(limit)?)?;
                    self.literal(child, depth + 1)?;
                }
            }
            Value::Array(array) => {
                for child in array {
                    self.literal(child, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn charge(&mut self, scope: &SchemaScope<'_>, value: &Value, visit: Visit) -> HostResult<()> {
        let object = scope.schema.as_object();
        let fields = object.map_or(0, serde_json::Map::len);
        let required = scope
            .schema
            .get("required")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let enums = scope
            .schema
            .get("enum")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let units = fields
            .checked_add(2)
            .and_then(|n| n.checked_add(required))
            .and_then(|n| n.checked_add(enums))
            .ok_or_else(limit)?;
        let locations = scope
            .resolver
            .base_uri()
            .as_str()
            .len()
            .checked_add(self.prepared.max_schema_path)
            .and_then(|n| n.checked_add(visit.evaluation_bytes))
            .and_then(|n| n.checked_add(visit.instance_bytes))
            .ok_or_else(limit)?;
        let bytes = locations
            .checked_mul(2)
            .and_then(|n| n.checked_add(DETAIL_BYTES))
            .and_then(|n| n.checked_mul(units))
            .ok_or_else(limit)?;
        self.work.charge(visit.depth, units, bytes)?;
        let mut assertions = 0usize;
        if let Some(object) = object {
            for (keyword, child) in object {
                if SCHEMA_CONTAINERS.contains(&keyword.as_str())
                    && scope.draft.is_known_keyword(keyword)
                {
                    continue;
                }
                self.literal(child, visit.depth + 1)?;
                if scope.draft.is_known_keyword(keyword)
                    && !matches!(
                        keyword.as_str(),
                        "$schema"
                            | "$id"
                            | "$anchor"
                            | "$dynamicAnchor"
                            | "title"
                            | "description"
                            | "default"
                            | "examples"
                            | "readOnly"
                            | "writeOnly"
                            | "deprecated"
                            | "required"
                            | "dependentRequired"
                            | "$ref"
                            | "$dynamicRef"
                            | "$recursiveRef"
                    )
                {
                    assertions = assertions.checked_add(1).ok_or_else(limit)?;
                }
            }
        }
        let comparisons = assertions.checked_add(enums).ok_or_else(limit)?;
        if comparisons != 0 {
            let input = measure(value)?;
            self.work.step(
                visit.depth,
                input
                    .checked_mul(comparisons)
                    .and_then(|n| n.checked_mul(2))
                    .ok_or_else(limit)?,
            )?;
        }
        match value {
            Value::Object(object) => {
                for name in object.keys() {
                    self.work.step(
                        visit.depth,
                        name.len()
                            .checked_mul(2)
                            .and_then(|n| n.checked_add(64))
                            .ok_or_else(limit)?,
                    )?;
                }
            }
            Value::Array(array) => self
                .work
                .step(visit.depth, array.len().checked_mul(64).ok_or_else(limit)?)?,
            _ => {}
        }
        Ok(())
    }
    fn descend<'s>(
        &mut self,
        parent: &SchemaScope<'s>,
        schema: &'s Value,
        value: &Value,
        visit: Visit,
    ) -> HostResult<()> {
        let scope = parent.child(schema, self.work, visit.depth)?;
        self.visits(&scope, value, visit)
    }
    fn visits(&mut self, scope: &SchemaScope<'_>, value: &Value, visit: Visit) -> HostResult<()> {
        for _ in 0..visit.validations {
            self.node(
                scope,
                value,
                Visit {
                    mode: Mode::Validate,
                    validations: 0,
                    ..visit
                },
            )?;
        }
        self.node(
            scope,
            value,
            Visit {
                validations: 0,
                ..visit
            },
        )
    }
    fn reference(
        &mut self,
        scope: &SchemaScope<'_>,
        reference: &str,
        value: &Value,
        visit: Visit,
    ) -> HostResult<()> {
        self.work.step(
            visit.depth,
            scope
                .resolver
                .base_uri()
                .as_str()
                .len()
                .checked_add(reference.len())
                .and_then(|n| n.checked_mul(2))
                .ok_or_else(limit)?,
        )?;
        let (schema, resolver, draft) = scope
            .targets
            .lookup(
                scope.lookup,
                &scope.resolver,
                reference,
                self.work,
                visit.depth,
            )?
            .into_inner();
        let target = SchemaScope {
            schema,
            resolver,
            draft,
            lookup: scope.lookup,
            targets: scope.targets.clone(),
        };
        let base_uri = target.resolver.base_uri();
        let base = base_uri.as_str();
        self.work
            .step(visit.depth, base.len().checked_mul(2).ok_or_else(limit)?)?;
        let dynamic = dynamic_scope(&target.resolver, self.work, visit.depth)?;
        let key = (
            address(schema),
            address(value),
            base.to_owned(),
            dynamic,
            matches!(visit.mode, Mode::Mark),
            // 同一物理schema的不同URI别名可能各自编译出回边目标，不能合并截断。
            reference.to_owned(),
        );
        let entered = self.active.get(&key).copied().unwrap_or_default();
        // 普通强入口不建立库的Weak guard，首轮回边仍展开；覆盖标记有独立guard。
        let expansions = if matches!(visit.mode, Mode::Mark) {
            1
        } else {
            2
        };
        if entered >= expansions {
            return Ok(());
        }
        self.active.insert(key.clone(), entered + 1);
        let result = self.visits(&target, value, visit);
        if entered == 0 {
            self.active.remove(&key);
        } else {
            self.active.insert(key, entered);
        }
        result
    }
    fn node(&mut self, scope: &SchemaScope<'_>, value: &Value, visit: Visit) -> HostResult<()> {
        let schema = scope.schema;
        let draft = scope.draft;
        if matches!(draft, Draft::Draft4 | Draft::Draft6 | Draft::Draft7)
            && let Some(reference) = schema.get("$ref").and_then(Value::as_str)
        {
            self.work.charge(visit.depth, 2, DETAIL_BYTES * 2)?;
            return self.reference(scope, reference, value, visit.child("$ref", 0, None, 0)?);
        }
        self.charge(scope, value, visit)?;
        let marking = matches!(visit.mode, Mode::Mark);
        let unevaluated = match value {
            Value::Object(_) => "unevaluatedProperties",
            Value::Array(_) => "unevaluatedItems",
            _ => "",
        };
        if !marking
            && draft.is_known_keyword(unevaluated)
            && schema
                .get(unevaluated)
                .is_some_and(|v| v != &Value::Bool(true))
        {
            // 覆盖会在各分支重新校验并递归标记，不能用固定次数的校验替代。
            self.node(
                scope,
                value,
                Visit {
                    mode: Mode::Mark,
                    ..visit
                },
            )?;
        }
        if !marking
            && let (Some(pattern), Some(text)) = (
                schema.get("pattern").and_then(Value::as_str),
                value.as_str(),
            )
        {
            self.prepared
                .pattern(pattern, draft, text, self.work, visit.depth)?;
        }
        for keyword in ["$ref", "$dynamicRef", "$recursiveRef"] {
            if draft.is_known_keyword(keyword)
                && let Some(reference) = schema.get(keyword).and_then(Value::as_str)
            {
                let next = visit.child(keyword, 0, None, 0)?;
                self.reference(scope, reference, value, next)?;
                if keyword == "$recursiveRef" {
                    for uri in dynamic_scope(&scope.resolver, self.work, visit.depth)? {
                        self.reference(scope, &uri, value, next)?;
                    }
                }
            }
        }
        for keyword in ["allOf", "anyOf", "oneOf"] {
            if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
                let checks = match (visit.mode, keyword) {
                    (Mode::Mark, _) | (Mode::Evaluate, "anyOf") => 1,
                    (Mode::Evaluate, "oneOf") => 2,
                    _ => 0,
                };
                for (index, branch) in branches.iter().enumerate() {
                    self.descend(
                        scope,
                        branch,
                        value,
                        visit.child(keyword, index.to_string().len() + 1, None, checks)?,
                    )?;
                }
            }
        }
        for keyword in ["not", "if", "then", "else"] {
            if marking && keyword == "not" {
                continue;
            }
            if draft.is_known_keyword(keyword)
                && let Some(branch) = schema.get(keyword)
            {
                let checks = usize::from(
                    (marking && keyword == "if")
                        || (keyword == "not" && matches!(visit.mode, Mode::Evaluate)),
                );
                self.descend(scope, branch, value, visit.child(keyword, 0, None, checks)?)?;
            }
        }
        if let Some(object) = value.as_object() {
            for (name, value) in object {
                let segment = pointer_segment(name);
                if !marking
                    && let Some(branch) = schema
                        .get("properties")
                        .and_then(Value::as_object)
                        .and_then(|p| p.get(name))
                {
                    self.descend(
                        scope,
                        branch,
                        value,
                        visit.child("properties", segment, Some(segment), 0)?,
                    )?;
                }
                if let Some(patterns) = schema.get("patternProperties").and_then(Value::as_object) {
                    for (pattern, branch) in patterns {
                        self.prepared.property_pattern(
                            pattern,
                            draft,
                            name,
                            visit.depth,
                            self.work,
                        )?;
                        if !marking {
                            self.descend(
                                scope,
                                branch,
                                value,
                                visit.child(
                                    "patternProperties",
                                    pointer_segment(pattern),
                                    Some(segment),
                                    0,
                                )?,
                            )?;
                        }
                    }
                }
                for keyword in [
                    "additionalProperties",
                    "unevaluatedProperties",
                    "propertyNames",
                ] {
                    if marking && keyword != "unevaluatedProperties" {
                        continue;
                    }
                    if draft.is_known_keyword(keyword)
                        && let Some(branch) = schema.get(keyword)
                    {
                        let next = Visit {
                            mode: if marking { Mode::Validate } else { visit.mode },
                            ..visit.child(keyword, 0, Some(segment), 0)?
                        };
                        if keyword == "propertyNames" {
                            self.descend(scope, branch, &Value::String(name.clone()), next)?;
                        } else {
                            self.descend(scope, branch, value, next)?;
                        }
                    }
                }
            }
            for keyword in ["dependencies", "dependentSchemas"] {
                if draft.is_known_keyword(keyword)
                    && let Some(dependencies) = schema.get(keyword).and_then(Value::as_object)
                {
                    for (name, branch) in dependencies {
                        if !object.contains_key(name) {
                            continue;
                        }
                        if let Some(names) = branch.as_array() {
                            self.work.charge(
                                visit.depth,
                                names.len(),
                                names.len().checked_mul(DETAIL_BYTES).ok_or_else(limit)?,
                            )?;
                            self.literal(branch, visit.depth + 1)?;
                        } else {
                            self.descend(
                                scope,
                                branch,
                                value,
                                visit.child(keyword, pointer_segment(name), None, 0)?,
                            )?;
                        }
                    }
                }
            }
        }
        if let Some(array) = value.as_array() {
            let tuple_keyword = if draft == Draft::Draft202012 {
                "prefixItems"
            } else {
                "items"
            };
            let tuple = schema.get(tuple_keyword).and_then(Value::as_array);
            let tail_keyword = if tuple.is_some() && draft != Draft::Draft202012 {
                "additionalItems"
            } else {
                "items"
            };
            let tail = schema.get(tail_keyword).filter(|v| !v.is_array());
            for (index, value) in array.iter().enumerate() {
                let segment = index.to_string().len() + 1;
                if !marking && let Some(branch) = tuple.and_then(|p| p.get(index)) {
                    self.descend(
                        scope,
                        branch,
                        value,
                        visit.child(tuple_keyword, segment, Some(segment), 0)?,
                    )?;
                } else if !marking && let Some(branch) = tail {
                    self.descend(
                        scope,
                        branch,
                        value,
                        visit.child(tail_keyword, 0, Some(segment), 0)?,
                    )?;
                }
                for keyword in ["contains", "unevaluatedItems"] {
                    if draft.is_known_keyword(keyword)
                        && let Some(branch) = schema.get(keyword)
                    {
                        self.descend(
                            scope,
                            branch,
                            value,
                            Visit {
                                mode: if marking { Mode::Validate } else { visit.mode },
                                ..visit.child(keyword, 0, Some(segment), 0)?
                            },
                        )?;
                    }
                }
            }
        }
        Ok(())
    }
}
