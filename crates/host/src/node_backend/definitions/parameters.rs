//! 默认值只补缺失项；引用、分支与工作预算在Rust边界处理，最后仍由完整schema校验。
mod compilation_budget;
mod evaluation_budget;
mod generated_schema;
mod graph_budget;
mod graph_capacity;
mod index_budget;
mod json_bytes;
mod lookup_budget;
mod proposals;
mod registry_budget;
mod resource_budget;
mod validator_cache;
use super::{compile, error, validate, validation_options as options};
use jsonschema::{Draft, Validator};
use proposals::Candidate;
use referencing::{Registry, Resolver};
use serde_json::{Map, Value};
use serial_workbench_core::{ActionKind, HostResult, JsonObject, SchemaObject};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    sync::{Arc, OnceLock},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const ROOT: &str = "json-schema:///";
const MAX_BYTES: usize = serial_workbench_ipc::frame::MAX_FRAME_BYTES;
const MAX_STEPS: usize = 50_000;
const MAX_WORK_BYTES: usize = 32 * MAX_BYTES;
const MAX_DEPTH: usize = 128;
const SCHEMA_STACK_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct CompiledSchema {
    validator: Validator,
    schema: Value,
    backtrack: usize,
    input_reason: &'static str,
    has_defaults: bool,
    max_schema_path: usize,
    prepared: OnceLock<HostResult<Prepared>>,
    // 初次validator、源Value与Prepared先析构，最后才归还其编译图逻辑额度。
    _graph: GraphReservation,
}
pub(super) struct GraphReservation {
    bytes: usize,
}
struct Prepared {
    registry: Registry<'static>,
    registry_copies: registry_budget::CopyCost,
    lookup: lookup_budget::Costs,
    backtrack: usize,
    max_schema_path: usize,
    cache: validator_cache::Cache,
}
#[derive(Clone)]
struct SchemaScope<'a> {
    schema: &'a Value,
    resolver: Resolver<'a>,
    draft: Draft,
    lookup: &'a lookup_budget::Costs,
    targets: std::rc::Rc<lookup_budget::Cache<'a>>,
}
impl<'a> SchemaScope<'a> {
    fn pointer(&self, work: &mut Work) -> HostResult<String> {
        let resource = self
            .targets
            .lookup(self.lookup, &self.resolver, "", work, 0)?;
        find_pointer(resource.contents(), address(self.schema), work)?.ok_or_else(schema_error)
    }
    fn reference(&self, work: &mut Work) -> HostResult<String> {
        let pointer = self.pointer(work)?;
        Ok(format!(
            "{}#{}",
            self.resolver.base_uri().as_str(),
            encode_pointer(&pointer)
        ))
    }
    fn keyword_location(&self, keyword: &str, work: &mut Work) -> HostResult<String> {
        let pointer = format!("{}/{keyword}", self.pointer(work)?);
        let base = self.resolver.base_uri();
        if base.scheme().as_str() == "json-schema" {
            // 校验器为默认的未命名资源输出JSON Pointer。
            Ok(pointer)
        } else {
            Ok(format!("{}#{}", base.as_str(), encode_pointer(&pointer)))
        }
    }
    fn child(&self, schema: &'a Value, work: &mut Work, depth: usize) -> HostResult<Self> {
        let draft = self.draft.detect(schema);
        let resolver =
            lookup_budget::subresource(self.lookup, &self.resolver, schema, draft, work, depth)?;
        Ok(Self {
            schema,
            resolver,
            draft,
            lookup: self.lookup,
            targets: self.targets.clone(),
        })
    }
}
#[derive(Clone, Copy)]
struct Position<'a> {
    path: &'a str,
    depth: usize,
}
impl Position<'_> {
    fn descend(self) -> Self {
        Self {
            depth: self.depth + 1,
            ..self
        }
    }
}
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ValidationKey {
    Predicate {
        base: String,
        node: usize,
        scope: Vec<String>,
    },
    Pattern {
        draft: String,
        expression: String,
    },
    PropertyPattern {
        draft: String,
        expression: String,
    },
}
#[derive(Default)]
struct Work {
    steps: usize,
    bytes: usize,
    active: HashSet<(usize, String, Vec<String>)>,
    facts: Arc<Value>,
    lookup: lookup_budget::Memo,
}
fn compilation_permit() -> HostResult<OwnedSemaphorePermit> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    CAPACITY
        .get_or_init(|| Arc::new(Semaphore::new(8)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| error("HOST_BUSY", "backendSchemaCompilationCapacity"))
}
fn normalization_permit() -> HostResult<OwnedSemaphorePermit> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    CAPACITY
        .get_or_init(|| Arc::new(Semaphore::new(8)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| error("HOST_BUSY", "backendParametersCapacity"))
}
fn with_schema_stack<T: Send>(
    capacity: OwnedSemaphorePermit,
    run: impl FnOnce() -> HostResult<T> + Send,
) -> HostResult<T> {
    // 计数深度不等于原生栈余量；整个schema工作及临时值析构都在指定栈内完成。
    // guard覆盖scope，join（含TLS析构）结束后才归还真实线程占用的名额。
    let _capacity = capacity;
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new()
            .name("node-schema".into())
            .stack_size(SCHEMA_STACK_BYTES)
            .spawn_scoped(scope, run)
            .map_err(|_| error("HOST_BUSY", "backendSchemaWorker"))?;
        worker
            .join()
            .unwrap_or_else(|_| Err(error("NODE_SCHEMA_INVALID", "backendSchemaWorkerPanicked")))
    })
}
fn address(value: &Value) -> usize {
    std::ptr::from_ref(value).addr()
}
fn invalid() -> serial_workbench_core::HostError {
    error("INVALID_ARGUMENT", "backendParametersDefault")
}
fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendParametersBudget")
}
fn schema_error() -> serial_workbench_core::HostError {
    error("NODE_SCHEMA_INVALID", "backendParametersSchema")
}
pub(super) fn check_compiler_budget(schema: &Value, draft: Draft) -> HostResult<GraphReservation> {
    let lookup = resource_budget::compiler(schema, draft)?;
    GraphReservation::reserve(graph_budget::compiler(schema, draft, &lookup)?)
}
fn has_unevaluated(scope: &SchemaScope<'_>) -> bool {
    ["unevaluatedProperties", "unevaluatedItems"]
        .iter()
        .any(|keyword| {
            scope.draft.is_known_keyword(keyword)
                && scope.schema.get(keyword).is_some_and(Value::is_object)
        })
}
fn has_defaults(schema: &Value) -> bool {
    let mut pending = vec![schema];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(object) => {
                if object.contains_key("default") {
                    return true;
                }
                pending.extend(object.values());
            }
            Value::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    false
}
impl CompiledSchema {
    pub(super) fn compile(
        schema: &SchemaObject,
        backtrack: usize,
        kind: ActionKind,
    ) -> HostResult<Self> {
        with_schema_stack(compilation_permit()?, || {
            let (schema, max_schema_path) = compilation_budget::prepare(schema)?;
            let (validator, graph) = compile(&schema, backtrack, kind)?;
            let has_defaults = has_defaults(&schema);
            Ok(Self {
                validator,
                schema,
                backtrack,
                input_reason: if kind == ActionKind::Query {
                    "backendQueryInput"
                } else {
                    "backendActionInput"
                },
                has_defaults,
                max_schema_path,
                prepared: OnceLock::new(),
                _graph: graph,
            })
        })
    }
    fn prepared(&self) -> HostResult<&Prepared> {
        let prepared = if let Some(prepared) = self.prepared.get() {
            prepared
        } else {
            let _permit = compilation_permit()?;
            self.prepared.get_or_init(|| {
                Prepared::compile(
                    &self.schema,
                    self.validator.draft(),
                    self.backtrack,
                    self.max_schema_path,
                )
            })
        };
        prepared.as_ref().map_err(Clone::clone)
    }
    pub(super) fn validate(&self, value: &Value, code: &str, reason: &str) -> HostResult<()> {
        with_schema_stack(normalization_permit()?, || {
            self.validate_with_work(value, code, reason, &mut Work::default())
        })
    }
    fn validate_with_work(
        &self,
        value: &Value,
        code: &str,
        reason: &str,
        work: &mut Work,
    ) -> HostResult<()> {
        measure(value)?;
        let prepared = self.prepared()?;
        prepared.validation_budget(
            &prepared.root_scope(work)?,
            value,
            Position { path: "", depth: 0 },
            work,
        )?;
        validate(&self.validator, value, code, reason)
    }
    pub(super) fn normalize(&self, params: &JsonObject) -> HostResult<JsonObject> {
        with_schema_stack(normalization_permit()?, || self.normalize_inner(params))
    }
    fn normalize_inner(&self, params: &JsonObject) -> HostResult<JsonObject> {
        let mut value = serde_json::to_value(params).map_err(|_| invalid())?;
        measure(&value)?;
        let mut work = Work::default();
        if self.has_defaults {
            let prepared = self.prepared()?;
            let original = work.copy(&value)?;
            let mut converged = false;
            for _ in 0..128 {
                work.facts = Arc::new(work.copy(&value)?);
                let input = Candidate::from_value(work.copy(&original)?, &mut work)?;
                value = prepared
                    .node(
                        prepared.root_scope(&mut work)?,
                        input,
                        None,
                        Position { path: "", depth: 0 },
                        &mut work,
                    )?
                    .context(None, &mut work)?
                    .ok_or_else(invalid)?;
                measure(&value)?;
                if *work.facts == value {
                    converged = true;
                    break;
                }
            }
            if !converged {
                return Err(limit());
            }
        }
        self.validate_with_work(&value, "INVALID_ARGUMENT", self.input_reason, &mut work)?;
        serde_json::from_value(value).map_err(|_| invalid())
    }
}
impl Prepared {
    fn root_scope(&self, work: &mut Work) -> HostResult<SchemaScope<'_>> {
        let resolver = self
            .registry
            .resolver(referencing::uri::from_str(ROOT).map_err(|_| schema_error())?);
        let targets = lookup_budget::Cache::new(work, 0)?;
        let resolved = targets.lookup(&self.lookup, &resolver, "", work, 0)?;
        let (schema, resolver, draft) = resolved.into_inner();
        let resolver = lookup_budget::subresource(&self.lookup, &resolver, schema, draft, work, 0)?;
        Ok(SchemaScope {
            schema,
            resolver,
            draft,
            lookup: &self.lookup,
            targets,
        })
    }
    fn compile(
        schema: &Value,
        draft: Draft,
        backtrack: usize,
        max_schema_path: usize,
    ) -> HostResult<Self> {
        let resource_budget::ResourceCosts {
            copies: registry_copies,
            lookup,
        } = resource_budget::registry(schema, draft)?;
        let registry = Registry::new()
            .draft(draft)
            .retrieve_known_draft_meta_schemas(false)
            .add(ROOT, draft.create_resource(schema.clone()))
            .map_err(|_| schema_error())?
            .prepare()
            .map_err(|_| schema_error())?;
        Ok(Self {
            registry,
            registry_copies,
            lookup,
            backtrack,
            max_schema_path,
            cache: validator_cache::Cache::default(),
        })
    }
    fn cached(
        &self,
        key: ValidationKey,
        build: impl FnOnce(&mut validator_cache::Reservation) -> HostResult<Validator>,
    ) -> HostResult<Arc<validator_cache::CachedValidator>> {
        if let Some(existing) = self.cache.get(&key)? {
            return Ok(existing);
        }
        let _permit = compilation_permit()?;
        let mut reservation = self.cache.reserve(&key)?;
        let validator = build(&mut reservation)?;
        self.cache.insert(
            key,
            Arc::new(validator_cache::CachedValidator::new(
                validator,
                reservation,
            )),
        )
    }
    fn valid<'a>(
        &self,
        scope: &SchemaScope<'a>,
        schema: &'a Value,
        value: &Value,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<bool> {
        let scope = scope.child(schema, work, position.depth + 1)?;
        self.validation_budget(&scope, value, position.descend(), work)?;
        let validator = self.scoped_validator(&scope, work)?;
        validity(&validator, value)
    }
    fn scoped_validator(
        &self,
        scope: &SchemaScope<'_>,
        work: &mut Work,
    ) -> HostResult<Arc<validator_cache::CachedValidator>> {
        let schema = scope.schema;
        let resolver = &scope.resolver;
        work.step(
            0,
            resolver
                .base_uri()
                .as_str()
                .len()
                .checked_mul(2)
                .ok_or_else(limit)?,
        )?;
        let base = resolver.base_uri().as_str().to_owned();
        let dynamic = dynamic_scope(resolver, work, 0)?;
        let key = ValidationKey::Predicate {
            base: base.clone(),
            node: address(schema),
            scope: dynamic.clone(),
        };
        self.cached(key, |reservation| {
            let mut reference = scope.reference(work)?;
            scope
                .targets
                .lookup(scope.lookup, resolver, &reference, work, 0)?;
            let targets = lookup_budget::Cache::new(work, 0)?;
            let mut builder: Option<referencing::RegistryBuilder<'_>> = None;
            let mut augmented_copies = self.registry_copies;
            for uri in &dynamic {
                let lexical = self
                    .registry
                    .resolver(referencing::uri::from_str(uri).map_err(|_| schema_error())?);
                let resource = targets.lookup(&self.lookup, &lexical, "", work, 0)?;
                let mut input = None;
                for name in dynamic_anchor_names(resource.contents(), work)? {
                    let anchor = format!("#{name}");
                    let Some(target) =
                        targets.try_lookup(&self.lookup, &lexical, &anchor, work, 0)?
                    else {
                        continue;
                    };
                    let (target, _, target_draft) = target.into_inner();
                    if target_draft != Draft::Draft202012
                        || target.get("$dynamicAnchor").and_then(Value::as_str)
                            != Some(name.as_str())
                    {
                        continue;
                    }
                    let path = find_pointer(resource.contents(), address(target), work)?
                        .ok_or_else(schema_error)?;
                    let path = encode_pointer(&path);
                    work.step(
                        0,
                        uri.len()
                            .checked_add(path.len())
                            .and_then(|n| n.checked_add(1))
                            .ok_or_else(limit)?,
                    )?;
                    let target = format!("{uri}#{path}");
                    targets.lookup(&self.lookup, &lexical, &target, work, 0)?;
                    if input.is_none() {
                        input = Some(generated_schema::Scope::new(
                            &reference,
                            reservation,
                            work,
                            0,
                        )?);
                    }
                    input.as_mut().ok_or_else(schema_error)?.insert(
                        &name,
                        &target,
                        reservation,
                        work,
                        0,
                    )?;
                }
                let Some(input) = input else {
                    continue;
                };
                let id = format!("urn:swb:parameter-scope:{}", uuid::Uuid::new_v4());
                augmented_copies.add_resource(&id)?;
                let input = input.finish()?;
                resource_budget::generated(&input, Draft::Draft202012, &id, work)?;
                let wrapper = Draft::Draft202012.create_resource(input);
                builder = Some(
                    match builder {
                        Some(builder) => builder.add(&id, wrapper),
                        None => self.registry.add(&id, wrapper),
                    }
                    .map_err(|_| schema_error())?,
                );
                reference = id;
            }
            // guard先声明，实际augmented registry先析构，最后才归还其资源表名额。
            let _augmented_copy = builder
                .as_ref()
                .map(|_| augmented_copies.reserve(work))
                .transpose()?;
            if builder.is_some() {
                index_budget::bundled_meta(work)?;
            }
            let augmented = builder
                .map(|b| b.retrieve_known_draft_meta_schemas(false).prepare())
                .transpose()
                .map_err(|_| schema_error())?;
            let input = generated_schema::reference(&reference, reservation, work, 0)?;
            let compiler_base = format!("urn:swb:parameter-predicate:{}", uuid::Uuid::new_v4());
            resource_budget::generated(&input, Draft::Draft202012, &compiler_base, work)?;
            let mut compiler_copies = augmented_copies;
            compiler_copies.add_resource(&compiler_base)?;
            // build内部的第二层registry在返回前销毁；额度覆盖该次真实构建与失败清理。
            let _compiler_copy = compiler_copies.reserve(work)?;
            index_budget::bundled_meta(work)?;
            #[cfg(test)]
            crate::node_test_gates::registry_copy_compiler_ready().arrive();
            let registry = augmented.as_ref().unwrap_or(&self.registry);
            reservation.graph(graph_budget::generated(
                &input,
                Draft::Draft202012,
                registry,
                &compiler_base,
                &self.lookup,
                work,
            )?)?;
            options(Draft::Draft202012, self.backtrack)
                .with_registry(registry)
                .with_base_uri(compiler_base)
                .build(&input)
                .map_err(|_| schema_error())
        })
    }
    fn pattern(
        &self,
        pattern: &str,
        draft: Draft,
        name: &str,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<bool> {
        work.step(
            depth,
            pattern
                .len()
                .checked_mul(2)
                .and_then(|n| n.checked_add(name.len()))
                .and_then(|n| n.checked_add(256))
                .ok_or_else(limit)?,
        )?;
        let key = ValidationKey::Pattern {
            draft: format!("{draft:?}"),
            expression: pattern.to_owned(),
        };
        let validator = self.cached(key, |reservation| {
            let input = generated_schema::pattern(pattern, false, reservation, work, depth)?;
            index_budget::pattern(&input, draft, work)?;
            reservation.graph(graph_budget::generated(
                &input,
                draft,
                &self.registry,
                ROOT,
                &self.lookup,
                work,
            )?)?;
            options(draft, self.backtrack)
                .build(&input)
                .map_err(|_| schema_error())
        })?;
        validity(&validator, &Value::String(name.to_owned()))
    }
    fn property_pattern(
        &self,
        pattern: &str,
        draft: Draft,
        name: &str,
        depth: usize,
        work: &mut Work,
    ) -> HostResult<bool> {
        work.charge(
            depth,
            3,
            name.len()
                .checked_mul(4)
                .and_then(|n| n.checked_add(pattern.len().checked_mul(2)?))
                .and_then(|n| n.checked_add(512))
                .ok_or_else(limit)?,
        )?;
        let validator = self.cached(
            ValidationKey::PropertyPattern {
                draft: format!("{draft:?}"),
                expression: pattern.to_owned(),
            },
            |reservation| {
                let input = generated_schema::pattern(pattern, true, reservation, work, depth)?;
                index_budget::pattern(&input, draft, work)?;
                reservation.graph(graph_budget::generated(
                    &input,
                    draft,
                    &self.registry,
                    ROOT,
                    &self.lookup,
                    work,
                )?)?;
                options(draft, self.backtrack)
                    .build(&input)
                    .map_err(|_| schema_error())
            },
        )?;
        // 使用实际属性匹配器；false 令匹配与不匹配的校验结果相反，不能吞掉未决匹配。
        let value = Value::Object(Map::from_iter([(name.to_owned(), Value::Null)]));
        validity(&validator, &value).map(|valid| !valid)
    }
    fn child<'a>(
        &self,
        scope: &SchemaScope<'a>,
        schema: &'a Value,
        value: Candidate,
        seed: Option<&Candidate>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<Candidate> {
        self.node(
            scope.child(schema, work, position.depth + 1)?,
            value,
            seed,
            position.descend(),
            work,
        )
    }
    fn node(
        &self,
        scope: SchemaScope<'_>,
        value: Candidate,
        seed: Option<&Candidate>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<Candidate> {
        work.step(
            position.depth,
            position
                .path
                .len()
                .checked_add(scope.resolver.base_uri().as_str().len())
                .and_then(|n| n.checked_mul(2))
                .ok_or_else(limit)?,
        )?;
        let mut dynamic = dynamic_scope(&scope.resolver, work, position.depth)?;
        dynamic.push(scope.resolver.base_uri().as_str().to_owned());
        let key = (address(scope.schema), position.path.to_owned(), dynamic);
        if !work.active.insert(key.clone()) {
            return Ok(value);
        }
        let result = self.body(&scope, value, seed, position, work);
        work.active.remove(&key);
        result
    }
    fn body<'a>(
        &self,
        scope: &SchemaScope<'a>,
        value: Candidate,
        seed: Option<&Candidate>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<Candidate> {
        let mut references = Vec::new();
        for keyword in ["$ref", "$dynamicRef"] {
            if keyword == "$dynamicRef" && scope.draft != Draft::Draft202012 {
                continue;
            }
            if let Some(reference) = scope.schema.get(keyword).and_then(Value::as_str) {
                work.step(
                    position.depth,
                    scope
                        .resolver
                        .base_uri()
                        .as_str()
                        .len()
                        .checked_add(reference.len())
                        .and_then(|n| n.checked_mul(2))
                        .and_then(|n| n.checked_add(std::mem::size_of::<SchemaScope<'_>>()))
                        .ok_or_else(limit)?,
                )?;
                let (schema, resolver, draft) = scope
                    .targets
                    .lookup(
                        scope.lookup,
                        &scope.resolver,
                        reference,
                        work,
                        position.depth,
                    )?
                    .into_inner();
                let reference = SchemaScope {
                    schema,
                    resolver,
                    draft,
                    lookup: scope.lookup,
                    targets: scope.targets.clone(),
                };
                // 纯引用没有本地提案，直接转交可避免有限链逐层重复收敛。
                let pure_reference = scope
                    .schema
                    .as_object()
                    .is_some_and(|schema| schema.len() == 1);
                if pure_reference
                    || matches!(scope.draft, Draft::Draft4 | Draft::Draft6 | Draft::Draft7)
                {
                    return self.node(reference, value, seed, position.descend(), work);
                }
                references.push(reference);
            }
        }
        let composes = !references.is_empty()
            || [
                "allOf",
                "anyOf",
                "oneOf",
                "if",
                "dependencies",
                "dependentSchemas",
            ]
            .iter()
            .any(|k| scope.draft.is_known_keyword(k) && scope.schema.get(k).is_some());
        let requires_unevaluated = has_unevaluated(scope);
        let (mut result, local_for_unevaluated) = if composes {
            let original = value;
            let mut previous = Candidate::Missing;
            let mut converged = None;
            for _ in 0..128 {
                work.step(position.depth, 0)?;
                let context = previous.context(seed, work)?;
                let context = match context {
                    Some(value) => Some(value),
                    None => original.context(seed, work)?,
                };
                let context =
                    context.map_or(Ok(Candidate::Missing), |v| Candidate::from_value(v, work))?;
                let mut candidate =
                    self.local(scope, original.copy(work)?, Some(&context), position, work)?;
                let local = if requires_unevaluated {
                    Some(candidate.copy(work)?)
                } else {
                    None
                };
                let context = candidate.context(Some(&context), work)?;
                let context =
                    context.map_or(Ok(Candidate::Missing), |v| Candidate::from_value(v, work))?;
                // 同实例的引用与applicator从同一输入提案；合成上下文只供判定和借结构。
                for reference in &references {
                    let referenced = self.node(
                        reference.clone(),
                        original.copy(work)?,
                        Some(&context),
                        position.descend(),
                        work,
                    )?;
                    candidate.merge(referenced, work)?;
                }
                self.applicators(scope, &original, &context, &mut candidate, position, work)?;
                if candidate == previous {
                    converged = Some((candidate, local));
                    break;
                }
                previous = candidate;
            }
            converged.ok_or_else(limit)?
        } else {
            (self.local(scope, value, seed, position, work)?, None)
        };
        if let Some(mut local) = local_for_unevaluated {
            // 覆盖判断读取本轮完整组合值；兄弟提案仍不成为本scope的输入。
            let context = result.context(seed, work)?;
            let context =
                context.map_or(Ok(Candidate::Missing), |v| Candidate::from_value(v, work))?;
            self.unevaluated(scope, &mut local, Some(&context), position, work)?;
            result.merge(local, work)?;
        } else {
            self.unevaluated(scope, &mut result, seed, position, work)?;
        }
        Ok(result)
    }
    fn local<'a>(
        &self,
        scope: &SchemaScope<'a>,
        mut value: Candidate,
        seed: Option<&Candidate>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<Candidate> {
        if !value.present()
            && let Some(default) = scope.schema.get("default")
        {
            let mut proposed = Candidate::from_value(work.copy(default)?, work)?;
            proposed.merge(value, work)?;
            value = proposed;
        }
        value.borrow_shape(seed, work)?;
        // 本scope自身的字面默认值已建立的子字段继续作为该子路径的输入。
        if let Candidate::Object { fields, .. } = &mut value {
            self.object(
                scope,
                fields,
                seed.and_then(Candidate::object),
                position,
                work,
            )?;
        }
        if let Candidate::Array { items, .. } = &mut value {
            self.array(
                scope,
                items,
                seed.and_then(Candidate::array),
                position,
                work,
            )?;
        }
        Ok(value)
    }
    fn applicators<'a>(
        &self,
        scope: &SchemaScope<'a>,
        original: &Candidate,
        context: &Candidate,
        result: &mut Candidate,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        let schema = scope.schema;
        let draft = scope.draft;
        if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
            for branch in branches {
                let candidate = self.child(
                    scope,
                    branch,
                    original.copy(work)?,
                    Some(context),
                    position,
                    work,
                )?;
                result.merge(candidate, work)?;
            }
        }
        let input = context.context(None, work)?;
        for keyword in ["anyOf", "oneOf"] {
            if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
                let storage = std::mem::size_of::<Candidate>()
                    + std::mem::size_of::<Value>()
                    + std::mem::size_of::<&Value>()
                    + std::mem::size_of::<bool>();
                work.charge(
                    position.depth,
                    branches.len(),
                    branches.len().checked_mul(storage).ok_or_else(limit)?,
                )?;
                let established = branches
                    .iter()
                    .map(|branch| {
                        input.as_ref().map_or(Ok(false), |input| {
                            self.valid(scope, branch, input, position, work)
                        })
                    })
                    .collect::<HostResult<Vec<_>>>()?;
                let any = established.iter().any(|v| *v);
                let mut candidates = Vec::new();
                let mut instances = Vec::new();
                let mut unresolved = Vec::new();
                for (branch, valid) in branches.iter().zip(established) {
                    if any && !valid {
                        continue;
                    }
                    let candidate = self.child(
                        scope,
                        branch,
                        original.copy(work)?,
                        Some(context),
                        position,
                        work,
                    )?;
                    match candidate.context(Some(context), work)? {
                        Some(input) => {
                            if self.valid(scope, branch, &input, position, work)? {
                                instances.push(input);
                                candidates.push(candidate);
                            }
                        }
                        None => unresolved.push((branch, candidate)),
                    }
                }
                // 没有自身值的有效分支也投票；不能等上一轮偶然填值后才让其参与共识。
                for (branch, candidate) in unresolved {
                    for instance in &instances {
                        if self.valid(scope, branch, instance, position, work)? {
                            candidates.push(candidate);
                            break;
                        }
                    }
                }
                if let Some(first) = candidates.first() {
                    let mut agreed = first.copy(work)?;
                    for candidate in &candidates[1..] {
                        agreed = Candidate::agreement(original, agreed, candidate, work)?;
                    }
                    result.merge(agreed, work)?;
                }
            }
        }
        let Some(input) = input else {
            return Ok(());
        };
        let predicate_input = work.condition_instance(position.path, &input)?;
        if let Some(condition) = schema.get("if").filter(|_| draft.is_known_keyword("if")) {
            let keyword = if self.valid(scope, condition, &predicate_input, position, work)? {
                "then"
            } else {
                "else"
            };
            if let Some(branch) = schema.get(keyword) {
                let candidate = self.child(
                    scope,
                    branch,
                    original.copy(work)?,
                    Some(context),
                    position,
                    work,
                )?;
                result.merge(candidate, work)?;
            }
        }
        if let Some(object) = predicate_input.as_object() {
            for keyword in ["dependencies", "dependentSchemas"] {
                if !draft.is_known_keyword(keyword) {
                    continue;
                }
                if let Some(dependencies) = schema.get(keyword).and_then(Value::as_object) {
                    for name in object.keys() {
                        if let Some(branch) = dependencies
                            .get(name)
                            .filter(|v| v.is_object() || v.is_boolean())
                        {
                            let candidate = self.child(
                                scope,
                                branch,
                                original.copy(work)?,
                                Some(context),
                                position,
                                work,
                            )?;
                            result.merge(candidate, work)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    fn unevaluated(
        &self,
        scope: &SchemaScope<'_>,
        value: &mut Candidate,
        seed: Option<&Candidate>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        if !has_unevaluated(scope) {
            return Ok(());
        }
        let Some(input) = value.context(seed, work)? else {
            return Ok(());
        };
        let keyword = match &input {
            Value::Object(_) => "unevaluatedProperties",
            Value::Array(_) => "unevaluatedItems",
            _ => return Ok(()),
        };
        let Some(schema) = scope
            .schema
            .get(keyword)
            .filter(|schema| scope.draft.is_known_keyword(keyword) && schema.is_object())
        else {
            return Ok(());
        };
        let location = scope.keyword_location(keyword, work)?;
        self.evaluation_budget(scope, &input, position, work)?;
        let validator = self.scoped_validator(scope, work)?;
        let evaluation = validator.evaluate(&input);
        let mut pending = vec![(evaluation.root(), 0)];
        let mut matching = Vec::new();
        while let Some((unit, depth)) = pending.pop() {
            work.step(
                depth,
                unit.schema_location().len()
                    + unit.evaluation_path().as_str().len()
                    + unit.instance_location().as_str().len(),
            )?;
            if unit.schema_location() == location && unit.instance_location().as_str().is_empty() {
                matching.push(unit);
            }
            pending.extend(unit.children().map(|child| (child, depth + 1)));
        }
        let unit = matching
            .into_iter()
            .min_by_key(|unit| unit.evaluation_path().as_str().len())
            .ok_or_else(|| error("LIMIT_EXCEEDED", "backendParametersEvaluation"))?;
        let paths = unit
            .children()
            .map(|child| child.instance_location().as_str().to_owned())
            .collect::<BTreeSet<_>>();
        for path in paths {
            let current = value.pointer_mut(&path, &input, work)?;
            let original = std::mem::replace(current, Candidate::Missing);
            let seed = seed.map(|s| s.pointer(&path, work)).transpose()?.flatten();
            let child_path = format!("{}{path}", position.path);
            *current = self.child(
                scope,
                schema,
                original,
                seed,
                Position {
                    path: &child_path,
                    ..position
                },
                work,
            )?;
        }
        Ok(())
    }
    fn object<'a>(
        &self,
        scope: &SchemaScope<'a>,
        object: &mut BTreeMap<String, Candidate>,
        seed: Option<&BTreeMap<String, Candidate>>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        let schema = scope.schema;
        let properties = schema.get("properties").and_then(Value::as_object);
        let patterns = schema.get("patternProperties").and_then(Value::as_object);
        let mut names = BTreeSet::new();
        for name in object
            .keys()
            .chain(seed.into_iter().flat_map(|s| s.keys()))
            .chain(properties.into_iter().flat_map(|s| s.keys()))
        {
            if !names.contains(name) {
                work.step(position.depth, name.len() + std::mem::size_of::<String>())?;
                names.insert(name.clone());
            }
        }
        for name in names {
            let base = object.remove(&name).unwrap_or(Candidate::Missing);
            let seed = seed.and_then(|s| s.get(&name));
            let mut schemas = Vec::new();
            if let Some(property) = properties.and_then(|p| p.get(&name)) {
                schemas.push(property);
            }
            if let Some(patterns) = patterns {
                for (pattern, branch) in patterns {
                    if self.property_pattern(pattern, scope.draft, &name, position.depth, work)? {
                        schemas.push(branch);
                    }
                }
            }
            if schemas.is_empty()
                && (base.has_proposal(work)? || seed.is_some())
                && let Some(additional) = schema.get("additionalProperties")
            {
                schemas.push(additional);
            }
            let mut result = base.copy(work)?;
            let child_path = format!(
                "{}/{}",
                position.path,
                name.replace('~', "~0").replace('/', "~1")
            );
            for branch in schemas {
                let candidate = self.child(
                    scope,
                    branch,
                    base.copy(work)?,
                    seed,
                    Position {
                        path: &child_path,
                        ..position
                    },
                    work,
                )?;
                result.merge(candidate, work)?;
            }
            if result.has_proposal(work)? {
                object.insert(name, result);
            }
        }
        Ok(())
    }
    fn array<'a>(
        &self,
        scope: &SchemaScope<'a>,
        array: &mut Vec<Candidate>,
        seed: Option<&[Candidate]>,
        position: Position<'_>,
        work: &mut Work,
    ) -> HostResult<()> {
        let schema = scope.schema;
        let draft = scope.draft;
        let tuple = if draft == Draft::Draft202012 {
            schema.get("prefixItems")
        } else {
            schema.get("items")
        }
        .and_then(Value::as_array);
        let tail = if tuple.is_some() && draft != Draft::Draft202012 {
            schema.get("additionalItems")
        } else {
            schema.get("items").filter(|v| !v.is_array())
        };
        let count = array
            .len()
            .max(tuple.map_or(0, Vec::len))
            .max(seed.map_or(0, <[Candidate]>::len));
        for index in 0..count {
            let seed = seed.and_then(|s| s.get(index));
            let Some(branch) = tuple.and_then(|t| t.get(index)).or(tail) else {
                continue;
            };
            let existing = array.get(index).unwrap_or(&Candidate::Missing).copy(work)?;
            let candidate = self.child(
                scope,
                branch,
                existing,
                seed,
                Position {
                    path: &format!("{}/{index}", position.path),
                    ..position
                },
                work,
            )?;
            if candidate.has_proposal(work)? {
                if index >= array.len() {
                    work.charge(
                        position.depth,
                        index + 1 - array.len(),
                        (index + 1 - array.len()) * std::mem::size_of::<Candidate>(),
                    )?;
                    array.resize_with(index + 1, || Candidate::Missing);
                }
                array[index] = candidate;
            } else if index >= array.len() && seed.is_none_or(|s| !s.present()) {
                break;
            }
        }
        Ok(())
    }
}
fn validity(validator: &Validator, value: &Value) -> HostResult<bool> {
    match validator.validate(value) {
        Ok(()) => Ok(true),
        Err(e)
            if matches!(
                e.kind(),
                jsonschema::error::ValidationErrorKind::BacktrackLimitExceeded { .. }
            ) =>
        {
            Err(limit())
        }
        Err(_) => Ok(false),
    }
}
impl Work {
    fn condition_instance(&mut self, path: &str, value: &Value) -> HostResult<Value> {
        let facts = self.facts.clone();
        let mut input = self.copy(value)?;
        if let Some(previous) = facts.pointer(path) {
            fill_missing(&mut input, previous, self)?;
        }
        measure(&input)?;
        Ok(input)
    }
    fn step(&mut self, depth: usize, bytes: usize) -> HostResult<()> {
        self.charge(depth, 1, bytes)
    }
    fn charge(&mut self, depth: usize, steps: usize, bytes: usize) -> HostResult<()> {
        self.steps = self.steps.checked_add(steps).ok_or_else(limit)?;
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(limit)?;
        if depth > MAX_DEPTH || self.steps > MAX_STEPS || self.bytes > MAX_WORK_BYTES {
            Err(limit())
        } else {
            Ok(())
        }
    }
    fn copy(&mut self, value: &Value) -> HostResult<Value> {
        let bytes = measure(value)?;
        self.step(0, bytes)?;
        Ok(value.clone())
    }
}
fn fill_missing(target: &mut Value, facts: &Value, work: &mut Work) -> HostResult<()> {
    work.step(0, 0)?;
    match (target, facts) {
        (Value::Object(target), Value::Object(facts)) => {
            for (name, value) in facts {
                if let Some(existing) = target.get_mut(name) {
                    fill_missing(existing, value, work)?;
                } else {
                    target.insert(name.clone(), work.copy(value)?);
                }
            }
        }
        (Value::Array(target), Value::Array(facts)) => {
            for (index, value) in facts.iter().enumerate() {
                if let Some(existing) = target.get_mut(index) {
                    fill_missing(existing, value, work)?;
                } else {
                    target.push(work.copy(value)?);
                }
            }
        }
        _ => {}
    }
    Ok(())
}
fn measure(value: &Value) -> HostResult<usize> {
    json_bytes::measure(value, MAX_BYTES).map_err(|_| limit())
}
fn find_pointer(root: &Value, target: usize, work: &mut Work) -> HostResult<Option<String>> {
    let mut pending = vec![(root, String::new(), 0)];
    while let Some((value, path, depth)) = pending.pop() {
        work.step(depth, path.len())?;
        if address(value) == target {
            return Ok(Some(path));
        }
        match value {
            Value::Object(object) => {
                for (name, value) in object {
                    pending.push((
                        value,
                        format!("{path}/{}", name.replace('~', "~0").replace('/', "~1")),
                        depth + 1,
                    ));
                }
            }
            Value::Array(array) => {
                for (index, value) in array.iter().enumerate() {
                    pending.push((value, format!("{path}/{index}"), depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(None)
}
fn encode_pointer(pointer: &str) -> String {
    let mut encoded = referencing::uri::EncodedBuffer::new();
    encoded.encode_str::<referencing::uri::Path>(pointer);
    encoded.as_estr().as_str().to_owned()
}
fn dynamic_scope(
    resolver: &Resolver<'_>,
    work: &mut Work,
    depth: usize,
) -> HostResult<Vec<String>> {
    // 上游列表只共享Arc；先核对扫描、去重、字符串及后续键克隆，再分配本地容器。
    let all = resolver.dynamic_scope();
    let mut count = 0usize;
    let mut bytes = 0usize;
    for uri in all.iter() {
        work.step(depth, 0)?;
        count = count.checked_add(1).ok_or_else(limit)?;
        bytes = bytes.checked_add(uri.as_str().len()).ok_or_else(limit)?;
    }
    work.step(
        depth,
        bytes
            .checked_mul(count.checked_add(2).ok_or_else(limit)?)
            .and_then(|n| n.checked_add(count.checked_mul(128)?))
            .ok_or_else(limit)?,
    )?;
    let all = all.iter().collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    let mut result = all
        .into_iter()
        .rev()
        .map(|uri| uri.as_str())
        .filter(|uri| seen.insert(*uri))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    result.reverse();
    Ok(result)
}
fn dynamic_anchor_names(root: &Value, work: &mut Work) -> HostResult<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    let mut pending = vec![(root, 0)];
    while let Some((value, depth)) = pending.pop() {
        work.step(depth, 0)?;
        match value {
            Value::Object(object) => {
                if let Some(name) = object.get("$dynamicAnchor").and_then(Value::as_str) {
                    names.insert(name.to_owned());
                }
                for value in object.values() {
                    pending.push((value, depth + 1));
                }
            }
            Value::Array(array) => {
                for value in array {
                    pending.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(names)
}
