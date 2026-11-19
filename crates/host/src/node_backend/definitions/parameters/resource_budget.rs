//! 在registry分配前投影URI缓存及资源索引；未引用的数据不参与schema资源遍历。
mod pointers;
use super::{
    MAX_WORK_BYTES, ROOT, Work, address, error, index_budget, lookup_budget, registry_budget,
    schema_error,
};
use jsonschema::Draft;
use referencing::{Uri, uri};
use serde_json::Value;
use serial_workbench_core::HostResult;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    mem::size_of,
    sync::Arc,
};

const CACHE_ENTRY_BYTES: usize =
    size_of::<(String, String)>() + size_of::<Uri<String>>() + size_of::<[usize; 8]>();
const RESOURCE_ENTRY_BYTES: usize = registry_budget::ENTRY_WEIGHT;
const PENDING_ENTRY_BYTES: usize =
    size_of::<(String, Uri<String>, ReferenceKind)>() + size_of::<[usize; 8]>();
type ResolvedReferences = HashMap<String, Arc<Uri<String>>>;
type PendingReferences = HashMap<String, HashSet<Arc<Uri<String>>>>;

pub(super) struct ResourceCosts {
    pub(super) copies: registry_budget::CopyCost,
    pub(super) lookup: lookup_budget::Costs,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum ReferenceKind {
    Ref,
    Schema,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Traversal {
    Resources,
    References,
}

type VisitKey = (usize, Draft, usize);

fn visit_key(schema: &Value, draft: Draft, base: &Arc<Uri<String>>) -> VisitKey {
    (address(schema), draft, Arc::as_ptr(base).addr())
}

fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendSchemaRegistryBudget")
}

fn records_external(base: &str, reference: &str) -> bool {
    // 与锁定referencing的registry规则一致：标准meta资源不进入URI缓存/external。
    !reference.starts_with('#')
        && !reference.starts_with("https://json-schema.org/draft/")
        && !reference.starts_with("http://json-schema.org/draft-")
        && !base.starts_with("https://json-schema.org/draft/")
}

fn raw_resource_id(schema: &Value, draft: Draft, traversal: Traversal) -> Option<&str> {
    let id = schema.get(draft.id_keyword()).and_then(Value::as_str)?;
    let legacy = matches!(draft, Draft::Draft4 | Draft::Draft6 | Draft::Draft7);
    // normal analyze_object按字符串ref抑制id；deferred id_of则按字段是否存在抑制。
    // 两者都读原始id，避免ResourceRef::id先去掉尾#；元schema检查在索引构造之后。
    let has_reference = match traversal {
        Traversal::Resources => schema.get("$ref").and_then(Value::as_str).is_some(),
        Traversal::References => schema.get("$ref").is_some(),
    };
    if legacy && (id.starts_with('#') || has_reference) {
        None
    } else {
        Some(id)
    }
}

struct Projection<'a, 'work> {
    work: &'work mut Work,
    collect_lookup: bool,
    copies: registry_budget::CopyCost,
    lookup: lookup_budget::Costs,
    // 预检共享canonical字符串，计费仍覆盖底层真正复制的base/ref及known URI。
    resolved: HashMap<Arc<Uri<String>>, ResolvedReferences>,
    known: HashSet<Arc<Uri<String>>>,
    pending: HashMap<ReferenceKind, PendingReferences>,
    visited: HashMap<VisitKey, Traversal>,
    local_queue: VecDeque<&'a str>,
    local_seen: HashSet<&'a str>,
}
impl<'a, 'work> Projection<'a, 'work> {
    fn new(work: &'work mut Work, collect_lookup: bool) -> Self {
        Self {
            work,
            collect_lookup,
            copies: registry_budget::CopyCost::default(),
            lookup: lookup_budget::Costs::default(),
            resolved: HashMap::new(),
            known: HashSet::new(),
            pending: HashMap::new(),
            visited: HashMap::new(),
            local_queue: VecDeque::new(),
            local_seen: HashSet::new(),
        }
    }
    fn normally_crawled(&self, schema: &Value, draft: Draft, base: &Arc<Uri<String>>) -> bool {
        self.visited.get(&visit_key(schema, draft, base)) == Some(&Traversal::Resources)
    }
    fn ensure(&self, bytes: usize) -> HostResult<()> {
        self.work
            .bytes
            .checked_add(bytes)
            .filter(|total| *total <= MAX_WORK_BYTES)
            .map(|_| ())
            .ok_or_else(limit)
    }
    fn charge(&mut self, depth: usize, bytes: usize) -> HostResult<()> {
        self.work.step(depth, bytes).map_err(|_| limit())
    }
    fn remember(&mut self, value: &Arc<Uri<String>>, depth: usize) -> HostResult<()> {
        if !self.known.contains(value) {
            self.charge(
                depth,
                value
                    .as_str()
                    .len()
                    .checked_add(RESOURCE_ENTRY_BYTES)
                    .ok_or_else(limit)?,
            )?;
            self.copies.add_resource(value.as_str())?;
            self.known.insert(Arc::clone(value));
        }
        Ok(())
    }
    fn seed(&mut self, reference: &str, id: Option<&str>) -> HostResult<Arc<Uri<String>>> {
        let maximum = ROOT
            .len()
            .checked_add(reference.len())
            .and_then(|bytes| bytes.checked_add(1))
            .ok_or_else(limit)?;
        self.ensure(
            maximum
                .checked_mul(4)
                .and_then(|bytes| bytes.checked_add(RESOURCE_ENTRY_BYTES))
                .ok_or_else(limit)?,
        )?;
        let value = Arc::new(uri::from_str(reference).map_err(|_| schema_error())?);
        if self.collect_lookup {
            self.lookup.resource(&value, id, self.work, 0)?;
        }
        self.remember(&value, 0)?;
        Ok(value)
    }
    fn pending_reference(
        &mut self,
        reference: &str,
        resolved: Arc<Uri<String>>,
        kind: ReferenceKind,
        depth: usize,
    ) -> HostResult<()> {
        if self
            .pending
            .get(&kind)
            .and_then(|items| items.get(reference))
            .is_some_and(|items| items.contains(&resolved))
        {
            return Ok(());
        }
        // 上游external按原ref、完整URI和种类去重；不同别名/种类各持有一份副本。
        self.charge(
            depth,
            reference
                .len()
                .checked_add(resolved.as_str().len())
                .and_then(|bytes| bytes.checked_add(PENDING_ENTRY_BYTES))
                .ok_or_else(limit)?,
        )?;
        self.pending
            .entry(kind)
            .or_default()
            .entry(reference.to_owned())
            .or_default()
            .insert(resolved);
        Ok(())
    }
    fn resolve(
        &mut self,
        base: &Arc<Uri<String>>,
        reference: &str,
        depth: usize,
    ) -> HostResult<Arc<Uri<String>>> {
        self.charge(depth, 0)?;
        if let Some(value) = self
            .resolved
            .get(base)
            .and_then(|items| items.get(reference))
        {
            return Ok(Arc::clone(value));
        }
        let key_bytes = base
            .as_str()
            .len()
            .checked_add(reference.len())
            .and_then(|bytes| bytes.checked_add(CACHE_ENTRY_BYTES))
            .ok_or_else(limit)?;
        let maximum = base
            .as_str()
            .len()
            .checked_add(reference.len())
            .and_then(|bytes| bytes.checked_add(1))
            .ok_or_else(limit)?;
        // 先为纯URI解析/规范化的临时值及可能新增的canonical副本留出余量。
        // 不调用Registry::resolve_uri，避免检查自身先填满真实缓存。
        self.ensure(
            maximum
                .checked_mul(4)
                .and_then(|bytes| bytes.checked_add(key_bytes))
                .and_then(|bytes| bytes.checked_add(RESOURCE_ENTRY_BYTES))
                .ok_or_else(limit)?,
        )?;
        let value = Arc::new(
            uri::resolve_against(&base.as_ref().borrow(), reference).map_err(|_| schema_error())?,
        );
        self.charge(
            depth,
            key_bytes
                .checked_add(value.as_str().len())
                .ok_or_else(limit)?,
        )?;
        self.resolved
            .entry(Arc::clone(base))
            .or_default()
            .insert(reference.to_owned(), Arc::clone(&value));
        Ok(value)
    }
    fn resolve_id(
        &mut self,
        base: &Arc<Uri<String>>,
        id: &str,
        depth: usize,
    ) -> HostResult<Arc<Uri<String>>> {
        // normal/deferred crawl均跳过fragment id并去掉单个尾部#；运行时in_subresource不同。
        if id.starts_with('#') {
            return Ok(Arc::clone(base));
        }
        self.resolve(base, id.strip_suffix('#').unwrap_or(id), depth)
    }
    fn visit(
        &mut self,
        schema: &'a Value,
        draft: Draft,
        base: &Arc<Uri<String>>,
        site: index_budget::Site,
        traversal: Traversal,
    ) -> HostResult<()> {
        let depth = site.depth;
        self.charge(depth, 0)?;
        let draft = if depth == 0 {
            draft
        } else {
            draft.detect(schema)
        };
        let resource = draft.create_resource_ref(schema);
        let incoming_base = base;
        let base = if let Some(id) = raw_resource_id(schema, draft, traversal) {
            let resolved = self.resolve_id(base, id, depth)?;
            if self.collect_lookup && traversal == Traversal::Resources {
                self.lookup.prepared_uri(
                    base,
                    id.strip_suffix('#').unwrap_or(id),
                    self.work,
                    depth,
                )?;
            }
            if self.collect_lookup {
                self.lookup
                    .resource(&resolved, resource.id(), self.work, depth)?;
            }
            if traversal == Traversal::Resources {
                self.remember(&resolved, depth)?;
            }
            resolved
        } else {
            Arc::clone(base)
        };
        if traversal == Traversal::Resources && schema.is_object() {
            index_budget::deferred(schema, site, self.work)?;
            let changed = base != *incoming_base;
            let has_anchor = index_budget::anchor_names(schema, draft).next().is_some();
            if changed || (depth != 0 && has_anchor) {
                index_budget::registration(schema, draft, site, changed, self.work)?;
            }
        }
        // 与上游一样按共享URI对象身份去重；seed/缓存持有Arc直到预检结束，不复用地址。
        // 每个schema节点都哈希完整长URI会把预检本身放大为节点数乘URI长度。
        let key = visit_key(schema, draft, &base);
        let visited = self.visited.contains_key(&key);
        if visited && traversal == Traversal::References {
            return Ok(());
        }
        if !visited {
            self.charge(depth, size_of::<(VisitKey, Traversal)>())?;
            self.visited.insert(key, traversal);
        }
        // 上游只在deferred引用遍历中跳过URN；常规资源登记仍记录其引用。
        let records_references =
            traversal == Traversal::Resources || base.scheme().as_str() != "urn";
        for (keyword, kind, enabled) in [
            ("$ref", ReferenceKind::Ref, true),
            ("$schema", ReferenceKind::Schema, draft == Draft::Unknown),
        ] {
            if !enabled || !records_references {
                continue;
            }
            if let Some(reference) = schema.get(keyword).and_then(Value::as_str) {
                if records_external(base.as_str(), reference) {
                    let resolved = self.resolve(&base, reference, depth)?;
                    if self.collect_lookup && traversal == Traversal::Resources {
                        self.lookup
                            .prepared_uri(&base, reference, self.work, depth)?;
                    }
                    self.pending_reference(reference, resolved, kind, depth)?;
                } else if reference.starts_with('#')
                    && !base.as_str().starts_with("https://json-schema.org/draft/")
                {
                    self.local_reference(reference, depth)?;
                }
            }
        }
        if traversal == Traversal::Resources {
            for child in index_budget::children(schema, draft, site) {
                let (child, site) = child?;
                self.visit(child, draft, &base, site, traversal)?;
            }
        } else {
            for child in draft.subresources_of(schema) {
                self.visit(
                    child,
                    draft,
                    &base,
                    index_budget::Site::reference(depth + 1),
                    traversal,
                )?;
            }
        }
        Ok(())
    }
}

fn check(
    schema: &Value,
    draft: Draft,
    seed: &str,
    work: &mut Work,
    collect_lookup: bool,
) -> HostResult<ResourceCosts> {
    let mut projection = Projection::new(work, collect_lookup);
    if collect_lookup {
        index_budget::bundled_meta(projection.work)?;
    }
    let root = projection.seed(seed, draft.create_resource_ref(schema).id())?;
    let site = index_budget::Site::default();
    // 首次发布前验证以后每次输入/输出都必需的owned索引；borrowed compiler索引不比它更大。
    index_budget::registration(schema, draft, site, true, projection.work)?;
    projection.visit(schema, draft, &root, site, Traversal::Resources)?;
    projection.local_targets(schema, draft, &root)?;
    Ok(ResourceCosts {
        copies: projection.copies,
        lookup: projection.lookup,
    })
}

pub(super) fn compiler(schema: &Value, draft: Draft) -> HostResult<lookup_budget::Costs> {
    // jsonschema首次build以根资源id为起点，而Prepared显式登记在ROOT。
    let resource = draft.create_resource_ref(schema);
    let seed = resource.id().unwrap_or(ROOT);
    if seed != ROOT {
        // 未来Prepared还会在ROOT/canonical两处登记根；必须独立检查其完整URI与owned索引总额。
        check(schema, draft, ROOT, &mut Work::default(), true)?;
    }
    check(schema, draft, seed, &mut Work::default(), true).map(|costs| costs.lookup)
}

pub(super) fn registry(schema: &Value, draft: Draft) -> HostResult<ResourceCosts> {
    check(schema, draft, ROOT, &mut Work::default(), true)
}

pub(super) fn generated(
    schema: &Value,
    draft: Draft,
    seed: &str,
    work: &mut Work,
) -> HostResult<()> {
    // scope/predicate各自建新索引，但不得重置请求已经消耗的工作预算。
    check(schema, draft, seed, work, false).map(|_| ())
}
