//! Host typed 目录到 MCP 工具的机械映射。
use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{Value, json};
use serial_workbench_core::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fmt::Write,
    sync::Arc,
};

const DRAFT07: &str = "http://json-schema.org/draft-07/schema#";
const DRAFT202012: &str = "https://json-schema.org/draft/2020-12/schema";
const HOST_SCHEMA_ROOT: &str = "json-schema:///";

pub(crate) fn tool_name(action: &str) -> HostResult<String> {
    let mut name = String::from("swb_");
    for byte in action.bytes() {
        if byte.is_ascii_alphanumeric() {
            name.push(char::from(byte));
        } else {
            write!(name, "_x{byte:02X}_").expect("string writer");
        }
    }
    if name.len() > 128 {
        // 旧编码中的下划线只能以 _xHH_ 出现，因此 swb_h_ 不与旧名字重合。
        name = format!("swb_h_{:x}", Sha256::digest(action.as_bytes()));
    }
    Ok(name)
}

pub(crate) fn tool(spec: &ActionSpec) -> HostResult<Tool> {
    // 内置 Rust DTO 继续由 Core 机械生成；插件 schema 保持其原方言和资源边界。
    let builtin = BuiltinAction::find(spec.action_id.as_str()).ok();
    let typed = builtin
        .map(|action| action.spec_with_dialect(SchemaDialect::Draft202012))
        .unwrap_or(spec);
    let action = spec.kind == ActionKind::Action;
    let wire = wire_schema(action);
    let mut params = serde_json::to_value(&typed.input_schema).map_err(|_| invalid_schema())?;
    let params_ref = if builtin.is_some() {
        scope_refs(&mut params, "Params");
        "#/$defs/Params".to_owned()
    } else {
        parameter_resource(&mut params)?
    };
    let mut input = json!({
        "$schema":DRAFT202012,
        "type":"object", "additionalProperties":false,
        "required":["target","params"],
        "properties":{
            "target":{"$ref":"#/$defs/Wire/properties/target"},
            "requestId":{"$ref":"#/$defs/Wire/properties/requestId"},
            "params":{"$ref":params_ref}
        },
        "$defs":{"Wire":wire,"Params":params}
    });
    if builtin.is_none() {
        let identity = serde_json::to_vec(&(spec.action_id.as_str(), action, &spec.input_schema))
            .map_err(|_| invalid_schema())?;
        input["$id"] = format!(
            "https://serial-workbench.invalid/mcp/input/{:x}",
            Sha256::digest(identity)
        )
        .into();
    }
    if action {
        let properties = input["properties"]
            .as_object_mut()
            .expect("schema properties");
        for field in ["expectedRevision", "leaseId", "executionMode"] {
            properties.insert(
                field.into(),
                json!({"$ref":format!("#/$defs/Wire/properties/{field}")}),
            );
        }
    }
    let output = if action {
        static OPERATION: std::sync::LazyLock<Value> =
            std::sync::LazyLock::new(|| schema_for::<Operation>(SchemaDialect::Draft202012));
        OPERATION.clone()
    } else {
        let mut output =
            serde_json::to_value(&typed.output_schema).map_err(|_| invalid_schema())?;
        if builtin.is_none() {
            explicit_dialect(&mut output)?;
        }
        output
    };
    let Value::Object(input) = input else {
        return Err(invalid_schema());
    };
    let Value::Object(output) = output else {
        return Err(invalid_schema());
    };
    Ok(Tool::new(
        tool_name(spec.action_id.as_str())?,
        if action {
            format!(
                "{}. Returns the accepted operation; query operation.get for its result.",
                spec.action_id
            )
        } else {
            format!("{}. Returns its bounded query result.", spec.action_id)
        },
        input,
    )
    .with_raw_output_schema(Arc::new(output))
    .with_annotations(ToolAnnotations::new().read_only(!action)))
}

fn explicit_dialect(schema: &mut Value) -> HostResult<()> {
    schema
        .as_object_mut()
        .ok_or_else(invalid_schema)?
        .entry("$schema")
        .or_insert_with(|| DRAFT07.into());
    Ok(())
}

/// 独立资源保留 Host 的根 URI；D7根引用另用同方言桥保留被忽略的同层约束。
fn parameter_resource(schema: &mut Value) -> HostResult<String> {
    explicit_dialect(schema)?;
    if referencing::Draft::Draft7.detect(schema) == referencing::Draft::Draft7
        && schema.get("$ref").is_some()
    {
        *schema = draft7_reference_resource(schema)?;
        return Ok(HOST_SCHEMA_ROOT.to_owned());
    }
    let object = schema.as_object_mut().ok_or_else(invalid_schema)?;
    let id = match object.get("$id") {
        Some(Value::String(id)) if referencing::Uri::parse(id.as_str()).is_ok() => id.clone(),
        Some(Value::String(id)) => referencing::uri::from_str(id)
            .map_err(|_| invalid_schema())?
            .as_str()
            .to_owned(),
        None => HOST_SCHEMA_ROOT.to_owned(),
        Some(_) => return Err(invalid_schema()),
    };
    object.insert("$id".into(), id.clone().into());
    Ok(id)
}

type SchemaKey = (usize, String, referencing::Draft);

#[derive(Clone)]
struct ReferenceSchema<'a> {
    value: &'a Value,
    draft: referencing::Draft,
    resolver: referencing::Resolver<'a>,
}

impl ReferenceSchema<'_> {
    fn key(&self) -> SchemaKey {
        (
            std::ptr::from_ref(self.value).addr(),
            self.resolver.base_uri().as_str().to_owned(),
            self.draft,
        )
    }

    fn child<'a>(&self, value: &'a Value) -> HostResult<ReferenceSchema<'a>>
    where
        Self: 'a,
    {
        let draft = self.draft.detect(value);
        Ok(ReferenceSchema {
            value,
            draft,
            resolver: self
                .resolver
                .in_subresource(draft.create_resource_ref(value))
                .map_err(|_| invalid_schema())?,
        })
    }
}

struct ReferenceResource<'a> {
    root: ReferenceSchema<'a>,
    field: String,
    aliases: Vec<usize>,
    extra: bool,
}

struct ReferenceSeed {
    uri: String,
    origin: usize,
    draft: referencing::Draft,
    value: Value,
}

enum ReferenceAttempt {
    Complete(Value),
    Seed(ReferenceSeed),
}

/// D7 的根引用对象忽略 $id，不能直接成为 compound document 的命名资源。
/// 用没有根 $ref 的 D7 allOf 桥保持原方言，再仅重定位真正的 schema 引用。
fn draft7_reference_resource(schema: &Value) -> HostResult<Value> {
    // 被动数据只在真正被引用为 schema 时补种；Box 保持跨重建的源节点身份稳定。
    let mut seeds = BTreeMap::<String, Box<ReferenceSeed>>::new();
    loop {
        match draft7_reference_attempt(schema, &seeds)? {
            ReferenceAttempt::Complete(value) => return Ok(value),
            ReferenceAttempt::Seed(seed) => {
                if seeds.contains_key(&seed.uri) {
                    return Err(invalid_schema());
                }
                seeds.insert(seed.uri.clone(), Box::new(seed));
            }
        }
    }
}

fn draft7_reference_attempt(
    schema: &Value,
    seeds: &BTreeMap<String, Box<ReferenceSeed>>,
) -> HostResult<ReferenceAttempt> {
    let draft = referencing::Draft::Draft7;
    let mut builder = referencing::Registry::new()
        .draft(draft)
        .retrieve_known_draft_meta_schemas(false)
        .add(HOST_SCHEMA_ROOT, draft.create_resource_ref(schema))
        .map_err(|_| invalid_schema())?;
    for seed in seeds.values() {
        builder = builder
            .add(&seed.uri, seed.draft.create_resource_ref(&seed.value))
            .map_err(|_| invalid_schema())?;
    }
    let registry = builder.prepare().map_err(|_| invalid_schema())?;
    let resolver = registry
        .resolver(referencing::uri::from_str(HOST_SCHEMA_ROOT).map_err(|_| invalid_schema())?);
    let (value, resolver, draft) = resolver
        .lookup("")
        .map_err(|_| invalid_schema())?
        .into_inner();
    let root = ReferenceSchema {
        value,
        resolver,
        draft,
    };
    let mut adapter = ReferenceAdapter {
        registry: &registry,
        main: HashSet::new(),
        queue: VecDeque::new(),
        visited: HashSet::new(),
        resources: BTreeMap::new(),
        aliases: Vec::new(),
        alias_refs: HashMap::new(),
        rewrites: HashMap::new(),
        seed_origins: seeds
            .values()
            .map(|seed| (seed.uri.clone(), seed.origin))
            .collect(),
    };
    adapter.collect_main(&root)?;
    adapter.ensure_resource(HOST_SCHEMA_ROOT)?;
    if let Some(seed) = adapter.plan()? {
        return Ok(ReferenceAttempt::Seed(seed));
    }
    let original = adapter.render(&root)?;
    let mut bridge = json!({
        "$schema":DRAFT07,"$id":HOST_SCHEMA_ROOT,
        "allOf":[{"$ref":"#/definitions/Original"}],
        "definitions":{"Original":original}
    });
    adapter.append_aliases(&mut bridge, HOST_SCHEMA_ROOT)?;
    for (index, resource) in adapter
        .resources
        .values()
        .filter(|resource| resource.extra)
        .enumerate()
    {
        bridge["definitions"]
            .as_object_mut()
            .expect("bridge definitions")
            .insert(format!("Resource{index}"), adapter.render(&resource.root)?);
    }
    Ok(ReferenceAttempt::Complete(bridge))
}

struct ReferenceAdapter<'a> {
    registry: &'a referencing::Registry<'a>,
    main: HashSet<SchemaKey>,
    queue: VecDeque<ReferenceSchema<'a>>,
    visited: HashSet<SchemaKey>,
    resources: BTreeMap<String, ReferenceResource<'a>>,
    aliases: Vec<ReferenceSchema<'a>>,
    alias_refs: HashMap<SchemaKey, String>,
    rewrites: HashMap<SchemaKey, Vec<(&'static str, String)>>,
    seed_origins: HashMap<String, usize>,
}

impl<'a> ReferenceAdapter<'a> {
    fn collect_main(&mut self, node: &ReferenceSchema<'a>) -> HostResult<()> {
        if !self.main.insert(node.key()) {
            return Ok(());
        }
        self.queue.push_back(node.clone());
        for (_, child) in schema_children(node.value, node.draft) {
            self.collect_main(&node.child(child)?)?;
        }
        Ok(())
    }

    fn ensure_resource(&mut self, uri: &str) -> HostResult<()> {
        if self.resources.contains_key(uri) {
            return Ok(());
        }
        let resolver = self
            .registry
            .resolver(referencing::uri::from_str(uri).map_err(|_| invalid_schema())?);
        let (value, resolver, draft) = resolver
            .lookup("")
            .map_err(|_| invalid_schema())?
            .into_inner();
        let root = ReferenceSchema {
            value,
            resolver,
            draft: draft.detect(value),
        };
        let mut field = "x-serial-workbench-mcp-ref-targets".to_owned();
        while value.get(&field).is_some() {
            field.push('_');
        }
        let extra = !self.main.contains(&root.key());
        self.queue.push_back(root.clone());
        self.resources.insert(
            uri.to_owned(),
            ReferenceResource {
                root,
                field,
                aliases: Vec::new(),
                extra,
            },
        );
        Ok(())
    }

    fn missing_seed(&self, node: &ReferenceSchema<'a>) -> HostResult<Option<ReferenceSeed>> {
        let uri = node.resolver.base_uri();
        if self.registry.resolver((*uri).clone()).lookup("").is_ok() {
            return Ok(None);
        }
        // in_subresource 只改变 resolver 的 base，不把被动位置的新资源加入 Registry。
        // 退出本轮所有借用后，由外层用规范绝对ID登记拥有原件身份的副本再重试。
        if node.draft.create_resource_ref(node.value).id().is_none() {
            return Err(invalid_schema());
        }
        let mut value = node.value.clone();
        value[node.draft.id_keyword()] = uri.as_str().into();
        Ok(Some(ReferenceSeed {
            uri: uri.as_str().to_owned(),
            origin: std::ptr::from_ref(node.value).addr(),
            draft: node.draft,
            value,
        }))
    }

    fn plan(&mut self) -> HostResult<Option<ReferenceSeed>> {
        while let Some(node) = self.queue.pop_front() {
            if !self.visited.insert(node.key()) {
                continue;
            }
            if let Some(seed) = self.missing_seed(&node)? {
                return Ok(Some(seed));
            }
            for (_, child) in schema_children(node.value, node.draft) {
                self.queue.push_back(node.child(child)?);
            }
            for keyword in ["$ref", "$dynamicRef", "$recursiveRef"] {
                if !node.draft.is_known_keyword(keyword) {
                    continue;
                }
                let Some(reference) = node.value.get(keyword).and_then(Value::as_str) else {
                    continue;
                };
                let absolute = referencing::uri::resolve_against(
                    &node.resolver.base_uri().borrow(),
                    reference,
                )
                .map_err(|_| invalid_schema())?;
                let document_uri = absolute.strip_fragment();
                let document = document_uri.as_str();
                let fragment = absolute.fragment().map_or("", |fragment| fragment.as_str());
                self.ensure_resource(document)?;
                // 命名锚点保留原URI和动态查找语义。
                if !fragment.is_empty() && !fragment.starts_with('/') {
                    continue;
                }
                let (value, resolver, draft) = node
                    .resolver
                    .lookup(reference)
                    .map_err(|_| invalid_schema())?
                    .into_inner();
                let mut target = ReferenceSchema {
                    value,
                    resolver,
                    draft: draft.detect(value),
                };
                if !self.main.contains(&target.key()) {
                    let (resource_root, _, _) = target
                        .resolver
                        .lookup("")
                        .map_err(|_| invalid_schema())?
                        .into_inner();
                    // 被动指针首次进入资源；已在自身资源的回指不可再次应用相对ID。
                    if !std::ptr::eq(resource_root, value) {
                        target.resolver = target
                            .resolver
                            .in_subresource(target.draft.create_resource_ref(value))
                            .map_err(|_| invalid_schema())?;
                    }
                }
                if let Some(seed) = self.missing_seed(&target)? {
                    return Ok(Some(seed));
                }
                let replacement = if self.main.contains(&target.key()) {
                    if document != HOST_SCHEMA_ROOT {
                        continue;
                    }
                    format!("{HOST_SCHEMA_ROOT}#/definitions/Original{fragment}")
                } else {
                    let base = target.resolver.base_uri().as_str().to_owned();
                    self.ensure_resource(&base)?;
                    if self.resources[&base].root.key() == target.key()
                        || self.seed_origins.get(&base) == Some(&std::ptr::from_ref(value).addr())
                    {
                        base
                    } else if let Some(reference) = self.alias_refs.get(&target.key()) {
                        reference.clone()
                    } else {
                        let index = self.aliases.len();
                        let resource = self.resources.get_mut(&base).expect("target resource");
                        let reference = format!("{base}#/{}/{index}", resource.field);
                        resource.aliases.push(index);
                        self.alias_refs.insert(target.key(), reference.clone());
                        self.queue.push_back(target.clone());
                        self.aliases.push(target);
                        reference
                    }
                };
                self.rewrites
                    .entry(node.key())
                    .or_default()
                    .push((keyword, replacement));
            }
        }
        Ok(None)
    }

    fn render(&self, node: &ReferenceSchema<'a>) -> HostResult<Value> {
        let mut value = node.value.clone();
        for (pointer, child) in schema_children(node.value, node.draft) {
            *value.pointer_mut(&pointer).expect("pinned draft subschema") =
                self.render(&node.child(child)?)?;
        }
        if let Some(rewrites) = self.rewrites.get(&node.key()) {
            for (keyword, reference) in rewrites {
                value[*keyword] = reference.clone().into();
            }
        }
        let base = node.resolver.base_uri().as_str().to_owned();
        if base != HOST_SCHEMA_ROOT
            && self
                .resources
                .get(&base)
                .is_some_and(|resource| resource.root.key() == node.key())
        {
            // 被动位置资源的附加副本沿用同一规范绝对ID。
            if node.draft.create_resource_ref(node.value).id().is_some() {
                value[node.draft.id_keyword()] = base.clone().into();
            }
            self.append_aliases(&mut value, &base)?;
        }
        Ok(value)
    }

    fn append_aliases(&self, value: &mut Value, base: &str) -> HostResult<()> {
        let resource = &self.resources[base];
        if !resource.aliases.is_empty() {
            let mut aliases = serde_json::Map::new();
            for index in &resource.aliases {
                aliases.insert(index.to_string(), self.render(&self.aliases[*index])?);
            }
            value[&resource.field] = Value::Object(aliases);
        }
        Ok(())
    }
}

/// 由锁定Draft提供schema位置；const/default等字面载荷不作为schema遍历。
fn schema_children(value: &Value, draft: referencing::Draft) -> Vec<(String, &Value)> {
    let children: HashSet<_> = draft
        .subresources_of(value)
        .map(|child| std::ptr::from_ref(child).addr())
        .collect();
    let mut found = Vec::new();
    let escape = |key: &str| key.replace('~', "~0").replace('/', "~1");
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            let pointer = format!("/{}", escape(key));
            if children.contains(&std::ptr::from_ref(child).addr()) {
                found.push((pointer, child));
            } else if let Some(object) = child.as_object() {
                for (key, child) in object {
                    if children.contains(&std::ptr::from_ref(child).addr()) {
                        found.push((format!("{pointer}/{}", escape(key)), child));
                    }
                }
            } else if let Some(array) = child.as_array() {
                for (index, child) in array.iter().enumerate() {
                    if children.contains(&std::ptr::from_ref(child).addr()) {
                        found.push((format!("{pointer}/{index}"), child));
                    }
                }
            }
        }
    }
    found
}

fn wire_schema(action: bool) -> &'static Value {
    fn scoped(mut schema: Value) -> Value {
        scope_refs(&mut schema, "Wire");
        schema
    }
    static CALL: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| scoped(schema_for::<Call>(SchemaDialect::Draft202012)));
    static QUERY: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| scoped(schema_for::<Query>(SchemaDialect::Draft202012)));
    if action { &CALL } else { &QUERY }
}

/// 仅用于 Core 生成的 schema；插件的 default/const 等字面数据不可递归改写。
fn scope_refs(schema: &mut Value, component: &str) {
    match schema {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref")
                && let Some(local) = reference.strip_prefix('#')
            {
                *reference = format!("#/$defs/{component}{local}");
            }
            for value in object.values_mut() {
                scope_refs(value, component);
            }
        }
        Value::Array(array) => {
            for value in array {
                scope_refs(value, component);
            }
        }
        _ => {}
    }
}

fn invalid_schema() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid typed action schema")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn names_preserve_legacy_encoding_and_hash_long_ids_without_truncation() {
        assert_eq!(tool_name("session.tx").unwrap(), "swb_session_x2E_tx");
        assert_eq!(tool_name("a_b").unwrap(), "swb_a_x5F_b");
        assert_ne!(tool_name("a.b").unwrap(), tool_name("a_x2E_b").unwrap());
        assert_eq!(
            tool_name(&"a".repeat(124)).unwrap(),
            format!("swb_{}", "a".repeat(124))
        );
        let action = "_".repeat(26);
        let hashed = tool_name(&action).unwrap();
        assert_eq!(
            hashed,
            format!("swb_h_{:x}", Sha256::digest(action.as_bytes()))
        );
        assert_eq!(hashed.len(), 70);
        assert_ne!(hashed, tool_name(&format!("{action}x")).unwrap());
        assert_ne!(hashed, tool_name(&hashed).unwrap());
    }

    fn assert_refs(root: &Value, node: &Value) {
        match node {
            Value::Object(object) => {
                if let Some(Value::String(reference)) = object.get("$ref") {
                    let local = reference.strip_prefix('#').expect("local typed schema ref");
                    assert!(root.pointer(local).is_some(), "Unresolved {reference}");
                }
                for value in object.values() {
                    assert_refs(root, value);
                }
            }
            Value::Array(array) => {
                for value in array {
                    assert_refs(root, value);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn every_typed_action_has_a_unique_tool_and_resolved_2020_schema() {
        let mut names = HashSet::new();
        for action in BuiltinAction::ALL {
            let spec = action.spec();
            let tool = tool(spec).unwrap();
            assert!(names.insert(tool.name.clone()));
            let input = Value::Object(tool.input_schema.as_ref().clone());
            assert_refs(&input, &input);
            assert_eq!(
                input["$schema"],
                "https://json-schema.org/draft/2020-12/schema"
            );
            let target = &input["$defs"]["Wire"]["$defs"]["Target"];
            assert!(target.get("dependentRequired").is_some(), "{target}");
            assert!(target.get("dependencies").is_none());
            let output = Value::Object(tool.output_schema.unwrap().as_ref().clone());
            assert_refs(&output, &output);
            if spec.kind == ActionKind::Action {
                assert_eq!(output, schema_for::<Operation>(SchemaDialect::Draft202012));
            } else {
                assert_eq!(
                    output,
                    serde_json::to_value(
                        &action
                            .spec_with_dialect(SchemaDialect::Draft202012)
                            .output_schema
                    )
                    .unwrap()
                );
            }
        }
    }

    fn dynamic_spec(schema: &Value) -> ActionSpec {
        let mut spec = BuiltinAction::WorkspaceRead.spec().clone();
        spec.action_id = Id::try_from("example.graph.inspect").unwrap();
        spec.input_schema = serde_json::from_value(schema.clone()).unwrap();
        spec.output_schema = serde_json::from_value(schema.clone()).unwrap();
        spec
    }

    fn assert_dynamic_semantics(schema: Value, valid: Value, invalid: Value) -> Value {
        let original = if schema.get("$schema").is_some() {
            jsonschema::validator_for(&schema).unwrap()
        } else {
            jsonschema::options()
                .with_draft(jsonschema::Draft::Draft7)
                .build(&schema)
                .unwrap()
        };
        assert!(
            original.is_valid(&valid),
            "Original rejected {valid}: {schema}"
        );
        assert!(
            !original.is_valid(&invalid),
            "Original accepted {invalid}: {schema}"
        );
        let tool = tool(&dynamic_spec(&schema)).unwrap();
        let input = Value::Object(tool.input_schema.as_ref().clone());
        let exported = jsonschema::validator_for(&input)
            .unwrap_or_else(|error| panic!("Exported schema failed to compile: {error}; {input}"));
        for instance in [valid, invalid] {
            let envelope = json!({
                "target":{"hostId":"host","kind":"host","id":"host"},
                "params":instance
            });
            assert_eq!(
                exported.is_valid(&envelope),
                original.is_valid(&envelope["params"]),
                "Changed parameter semantics: {envelope}; {input}"
            );
            let output = Value::Object(tool.output_schema.as_ref().unwrap().as_ref().clone());
            assert_eq!(
                jsonschema::validator_for(&output)
                    .unwrap()
                    .is_valid(&envelope["params"]),
                original.is_valid(&envelope["params"]),
                "Changed query output semantics: {output}"
            );
        }
        input
    }

    #[test]
    fn dynamic_draft7_preserves_root_refs_dependencies_and_tuple_items() {
        for reference in ["#/definitions/Count", "json-schema:///#/definitions/Count"] {
            let input = assert_dynamic_semantics(
                json!({
                    "type":"object","required":["count"],
                    "properties":{"count":{"$ref":reference}},
                    "definitions":{"Count":{"type":"integer","minimum":2}}
                }),
                json!({"count":2}),
                json!({"count":1}),
            );
            assert_eq!(input["$defs"]["Params"]["$schema"], DRAFT07);
            assert_eq!(input["$defs"]["Params"]["$id"], HOST_SCHEMA_ROOT);
            assert_eq!(
                input["$defs"]["Params"]["properties"]["count"]["$ref"],
                reference
            );
        }
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT07,"type":"object","required":["pair"],
                "properties":{
                    "pair":{"type":"array","items":[{"type":"integer"},{"type":"string"}],"additionalItems":false},
                    "a":{},"b":{}
                },
                "dependencies":{"a":["b"]}
            }),
            json!({"pair":[1,"two"],"a":true,"b":false}),
            json!({"pair":[1,"two"],"a":true}),
        );
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT07,"type":"object","required":["pair"],
                "properties":{"pair":{"type":"array","items":[{"type":"integer"},{"type":"string"}],"additionalItems":false}}
            }),
            json!({"pair":[1,"two"]}),
            json!({"pair":[1,"two",3]}),
        );
    }

    #[test]
    fn dynamic_resources_preserve_absolute_relative_ids_and_nested_anchors() {
        for id in [
            "schemas/root.json",
            "https://EXAMPLE.test/schemas/root.json",
        ] {
            let input = assert_dynamic_semantics(
                json!({
                    "$schema":DRAFT07,"$id":id,"type":"object","required":["count"],
                    "properties":{"count":{"$ref":"parts/count.json"}},
                    "definitions":{"Count":{"$id":"parts/count.json","type":"integer","minimum":2}}
                }),
                json!({"count":2}),
                json!({"count":1}),
            );
            let expected = if id.starts_with("https:") {
                id.to_owned()
            } else {
                referencing::uri::from_str(id).unwrap().as_str().to_owned()
            };
            assert_eq!(input["$defs"]["Params"]["$id"], expected);
            assert_eq!(input["properties"]["params"]["$ref"], expected);
            assert_ne!(input["$id"], input["$defs"]["Params"]["$id"]);
        }
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT202012,"$id":"https://example.test/root.json",
                "type":"object","required":["count"],
                "properties":{"count":{"$ref":"parts/count.json#positive"}},
                "$defs":{"Count":{"$id":"parts/count.json","$anchor":"positive","type":"integer","minimum":2}}
            }),
            json!({"count":2}),
            json!({"count":1}),
        );
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT202012,"type":"object","required":["pair"],
                "properties":{"pair":{"$ref":"legacy"}},
                "$defs":{"Legacy":{"$schema":DRAFT07,"$id":"legacy","type":"array","items":[{"type":"integer"}],"additionalItems":false}}
            }),
            json!({"pair":[1]}),
            json!({"pair":[1,2]}),
        );
    }

    #[test]
    fn dynamic_literal_defaults_and_consts_are_not_treated_as_schema_refs() {
        let literal = json!({"$ref":"#/literal-data","nested":{"$id":"also-data"}});
        for dialect in [DRAFT07, DRAFT202012] {
            let input = assert_dynamic_semantics(
                json!({
                    "$schema":dialect,"type":"object","required":["payload"],
                    "properties":{"payload":{"const":literal,"default":literal}}
                }),
                json!({"payload":literal}),
                json!({"payload":{"$ref":"#/changed"}}),
            );
            let property = &input["$defs"]["Params"]["properties"]["payload"];
            assert_eq!(property["const"], literal);
            assert_eq!(property["default"], literal);
        }
    }

    #[test]
    fn dynamic_draft7_root_reference_keeps_ignored_siblings_and_original_scope() {
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT07,"$ref":"#/definitions/Params","type":"array",
                "definitions":{"Params":{
                    "type":"object","required":["count"],
                    "properties":{"count":{"type":"integer","minimum":2}}
                }}
            }),
            json!({"count":2}),
            json!({"count":1}),
        );
    }

    #[test]
    fn dynamic_draft7_root_reference_reaches_unknown_positions_without_mutating_literals() {
        let literal = json!({"$ref":"#/literal-data","nested":{"$id":"literal-only"}});
        let schema = json!({
            "$schema":DRAFT07,"$ref":"#/opaque","type":"array",
            "const":literal,"default":literal,
            "opaque":{
                "type":"object","required":["payload","count","step"],
                "properties":{
                    "payload":{"const":literal,"default":literal},
                    "count":{"$ref":"#/definitions/Count"},
                    "step":{"$ref":"parts/step.json"}
                }
            },
            "definitions":{
                "Count":{"type":"integer","minimum":2},
                "Step":{"$id":"parts/step.json","type":"integer","minimum":3}
            }
        });
        let input = assert_dynamic_semantics(
            schema.clone(),
            json!({"payload":literal,"count":2,"step":3}),
            json!({"payload":literal,"count":1,"step":3}),
        );
        let bridge = &input["$defs"]["Params"];
        assert_eq!(bridge["definitions"]["Original"]["const"], literal);
        assert_eq!(bridge["definitions"]["Original"]["default"], literal);
        assert_eq!(
            bridge["definitions"]["Original"]["opaque"],
            schema["opaque"]
        );
    }

    #[test]
    fn dynamic_draft7_const_can_be_a_referenced_schema_without_changing_its_data_copy() {
        let literal = json!({"$ref":"#/literal-data"});
        let selected = json!({
            "type":"object","required":["payload","count"],
            "properties":{"payload":{"const":literal,"default":literal},"count":{"$ref":"#/opaque"}}
        });
        let schema = json!({
            "$schema":DRAFT07,"$id":"https://ignored.example/root.json",
            "$ref":"#/const","type":"array","const":selected,
            "opaque":{"type":"integer","minimum":2}
        });
        let input = assert_dynamic_semantics(
            schema.clone(),
            json!({"payload":literal,"count":2}),
            json!({"payload":literal,"count":1}),
        );
        let bridge = &input["$defs"]["Params"];
        assert_eq!(bridge["$id"], HOST_SCHEMA_ROOT);
        assert_eq!(bridge["definitions"]["Original"]["const"], selected);
    }

    #[test]
    fn dynamic_draft7_referenced_relative_resource_can_refer_to_itself() {
        assert_dynamic_semantics(
            json!({
                "$schema":DRAFT07,"$ref":"#/const",
                "const":{"$id":"child/","type":"object","properties":{"next":{"$ref":"#"}}}
            }),
            json!({"next":{}}),
            json!({"next":2}),
        );
    }
}
