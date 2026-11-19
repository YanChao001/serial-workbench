//! 真正lookup前限制根id规范化、百分号解码及指针前缀可能生成的URI；不替代resolver语义。
use super::{Work, error, registry_budget, schema_error};
use referencing::{Resolved, Resolver, Target, Uri, uri::EncodedString};
use serde_json::Value;
use serial_workbench_core::HostResult;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    mem::size_of,
    rc::Rc,
    sync::Arc,
};

const ENTRY_BYTES: usize = size_of::<[usize; 8]>();

#[derive(Default)]
pub(super) struct Memo {
    roots: HashSet<(usize, Arc<Uri<String>>)>,
    uris: HashMap<(usize, Arc<Uri<String>>), HashSet<String>>,
}

struct Entry<'a> {
    target: Target<'a>,
    document: Arc<Uri<String>>,
}
type Targets<'a> = HashMap<Arc<Uri<String>>, HashMap<String, Entry<'a>>>;

// cache只属于本次图遍历/求值，Target借用活着的registry，不进入Prepared或跨线程共享。
pub(super) struct Cache<'a> {
    targets: RefCell<Targets<'a>>,
}
impl<'a> Cache<'a> {
    pub(super) fn new(work: &mut Work, depth: usize) -> HostResult<Rc<Self>> {
        work.step(depth, size_of::<Self>() + 2 * ENTRY_BYTES)
            .map_err(|_| limit())?;
        Ok(Rc::new(Self {
            targets: RefCell::new(HashMap::new()),
        }))
    }
    pub(super) fn try_lookup(
        &self,
        costs: &Costs,
        resolver: &Resolver<'a>,
        reference: &str,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Option<Resolved<'a>>> {
        work.step(depth, ENTRY_BYTES).map_err(|_| limit())?;
        let base = resolver.base_uri();
        {
            let targets = self.targets.borrow();
            if let Some(entry) = targets.get(&base).and_then(|refs| refs.get(reference)) {
                check_enter(costs, resolver, reference, &entry.document, work, depth)?;
                // Target仅与base/ref有关；enter仍使用当次动态作用域，不能缓存Resolved。
                return Ok(resolver.enter(&entry.target).ok());
            }
        }
        let Some(document) = check_reference(costs, resolver, reference, work, depth)? else {
            return Ok(None);
        };
        let bytes = reference
            .len()
            .checked_add(size_of::<Entry<'a>>())
            .and_then(|bytes| bytes.checked_add(8 * ENTRY_BYTES))
            .ok_or_else(limit)?;
        work.step(depth, bytes).map_err(|_| limit())?;
        let Ok(target) = resolver.lookup_target(reference) else {
            return Ok(None);
        };
        check_enter(costs, resolver, reference, &document, work, depth)?;
        let mut targets = self.targets.borrow_mut();
        let target = targets
            .entry(base)
            .or_default()
            .entry(reference.to_owned())
            .or_insert(Entry { target, document });
        Ok(resolver.enter(&target.target).ok())
    }
    pub(super) fn lookup(
        &self,
        costs: &Costs,
        resolver: &Resolver<'a>,
        reference: &str,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Resolved<'a>> {
        self.try_lookup(costs, resolver, reference, work, depth)?
            .ok_or_else(schema_error)
    }
    pub(super) fn try_recursive(
        &self,
        costs: &Costs,
        resolver: &Resolver<'a>,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Option<Resolved<'a>>> {
        let Some(mut resolved) = self.try_lookup(costs, resolver, "#", work, depth)? else {
            return Ok(None);
        };
        if resolved
            .contents()
            .get("$recursiveAnchor")
            .and_then(Value::as_bool)
            == Some(true)
        {
            for uri in resolver.dynamic_scope().iter() {
                let Some(next) = self.try_lookup(costs, resolver, uri.as_str(), work, depth)?
                else {
                    return Ok(None);
                };
                if next
                    .contents()
                    .get("$recursiveAnchor")
                    .and_then(Value::as_bool)
                    != Some(true)
                {
                    break;
                }
                resolved = next;
            }
        }
        Ok(Some(resolved))
    }
}

fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendSchemaLookupBudget")
}

#[derive(Default)]
pub(super) struct Costs {
    ids: Arc<HashMap<Arc<Uri<String>>, RootId>>,
    prepared_uris: HashMap<Arc<Uri<String>>, HashSet<String>>,
    largest_id: usize,
}
enum RootId {
    Known(Option<Arc<str>>),
    Ambiguous(usize),
}
impl RootId {
    fn maximum(&self) -> usize {
        match self {
            Self::Known(id) => id.as_deref().map_or(0, str::len),
            Self::Ambiguous(bytes) => *bytes,
        }
    }
    fn observe(&mut self, id: Option<&str>) {
        if matches!(self,Self::Known(current) if current.as_deref()==id) {
            return;
        }
        *self = Self::Ambiguous(self.maximum().max(id.map_or(0, str::len)));
    }
}
impl Costs {
    pub(super) fn without_uri_cache(&self) -> Self {
        // 新registry只复用资源事实，不能继承原UriCache的已准备键；元数据本身不深复制。
        Self {
            ids: Arc::clone(&self.ids),
            prepared_uris: HashMap::new(),
            largest_id: self.largest_id,
        }
    }
    pub(super) fn prepared_uri(
        &mut self,
        base: &Arc<Uri<String>>,
        reference: &str,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<()> {
        // build::resolve_id会跳过fragment id；空id也不作为可复用缓存凭据。
        if reference.is_empty() || reference.starts_with('#') {
            return Ok(());
        }
        if self
            .prepared_uris
            .get(base)
            .is_some_and(|refs| refs.contains(reference))
        {
            return Ok(());
        }
        work.step(
            depth,
            reference
                .len()
                .checked_add(2 * ENTRY_BYTES)
                .ok_or_else(limit)?,
        )
        .map_err(|_| limit())?;
        self.prepared_uris
            .entry(Arc::clone(base))
            .or_default()
            .insert(reference.to_owned());
        Ok(())
    }
    pub(super) fn resource(
        &mut self,
        uri: &Arc<Uri<String>>,
        id: Option<&str>,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<()> {
        self.largest_id = self.largest_id.max(id.map_or(0, str::len));
        // 只有Projection构造阶段写入；元数据发布后才向生成图共享。
        let ids =
            Arc::get_mut(&mut self.ids).expect("Resource metadata is shared only after projection");
        if let Some(current) = ids.get_mut(uri) {
            current.observe(id);
        } else {
            let bytes = size_of::<(Arc<Uri<String>>, RootId)>()
                .checked_add(ENTRY_BYTES)
                .and_then(|bytes| bytes.checked_add(id.map_or(0, str::len)))
                .and_then(|bytes| bytes.checked_add(2 * size_of::<usize>()))
                .ok_or_else(limit)?;
            work.step(depth, bytes).map_err(|_| limit())?;
            ids.insert(Arc::clone(uri), RootId::Known(id.map(Arc::from)));
        }
        Ok(())
    }
    fn id_bytes(&self, uri: &Arc<Uri<String>>) -> usize {
        self.ids.get(uri).map(RootId::maximum).unwrap_or_else(|| {
            self.largest_id.max(
                registry_budget::bundled_meta_ids()
                    .iter()
                    .map(String::len)
                    .max()
                    .unwrap_or(0),
            )
        })
    }
}

fn uri_charge(
    costs: &Costs,
    base: &Arc<Uri<String>>,
    reference: &str,
    work: &mut Work,
    depth: usize,
) -> HostResult<bool> {
    // 只记正常资源遍历确定会填入的键；deferred路径的投影不作为已准备缓存凭据。
    if costs
        .prepared_uris
        .get(base)
        .is_some_and(|refs| refs.contains(reference))
    {
        return Ok(false);
    }
    let key = (std::ptr::from_ref(costs).addr(), Arc::clone(base));
    if work
        .lookup
        .uris
        .get(&key)
        .is_some_and(|refs| refs.contains(reference))
    {
        return Ok(false);
    }
    let bytes = base
        .as_str()
        .len()
        .checked_add(reference.len())
        .and_then(|bytes| bytes.checked_mul(4))
        .and_then(|bytes| bytes.checked_add(reference.len()))
        .and_then(|bytes| bytes.checked_add(3 * ENTRY_BYTES))
        .ok_or_else(limit)?;
    work.step(depth, bytes).map_err(|_| limit())?;
    Ok(true)
}
fn remember_uri(costs: &Costs, base: &Arc<Uri<String>>, reference: &str, work: &mut Work) {
    work.lookup
        .uris
        .entry((std::ptr::from_ref(costs).addr(), Arc::clone(base)))
        .or_default()
        .insert(reference.to_owned());
}
fn reserve_uri(
    costs: &Costs,
    base: &Arc<Uri<String>>,
    reference: &str,
    work: &mut Work,
    depth: usize,
) -> HostResult<()> {
    if uri_charge(costs, base, reference, work, depth)? {
        remember_uri(costs, base, reference, work);
    }
    Ok(())
}

// id为已登记资源的原始字符串；各入口共同按真实(base,raw ref)缓存键预留，避免重复收费。
fn check_root(
    costs: &Costs,
    root: &Arc<Uri<String>>,
    work: &mut Work,
    depth: usize,
) -> HostResult<bool> {
    match costs.ids.get(root) {
        Some(RootId::Known(None)) => return Ok(false),
        Some(RootId::Known(Some(id))) => {
            reserve_uri(costs, root, id, work, depth)?;
            return Ok(false);
        }
        _ => {}
    }
    let key = (std::ptr::from_ref(costs).addr(), Arc::clone(root));
    if work.lookup.roots.contains(&key) {
        return Ok(false);
    }
    let bytes = root
        .as_str()
        .len()
        .checked_add(costs.id_bytes(root))
        .and_then(|bytes| bytes.checked_mul(4))
        .and_then(|bytes| bytes.checked_add(size_of::<(usize, Arc<Uri<String>>)>() + ENTRY_BYTES))
        .ok_or_else(limit)?;
    work.step(depth, bytes).map_err(|_| limit())?;
    Ok(true)
}
pub(super) fn try_subresource<'a>(
    costs: &Costs,
    resolver: &Resolver<'a>,
    schema: &Value,
    draft: referencing::Draft,
    work: &mut Work,
    depth: usize,
) -> HostResult<Option<Resolver<'a>>> {
    let resource = draft.create_resource_ref(schema);
    let base = resolver.base_uri();
    let id = resource.id();
    let fresh = id
        .map(|id| uri_charge(costs, &base, id, work, depth))
        .transpose()?
        .unwrap_or(false);
    let Ok(next) = resolver.in_subresource(resource) else {
        return Ok(None);
    };
    if fresh {
        remember_uri(costs, &base, id.expect("Reserved id exists"), work);
    }
    Ok(Some(next))
}
pub(super) fn subresource<'a>(
    costs: &Costs,
    resolver: &Resolver<'a>,
    schema: &Value,
    draft: referencing::Draft,
    work: &mut Work,
    depth: usize,
) -> HostResult<Resolver<'a>> {
    try_subresource(costs, resolver, schema, draft, work, depth)?.ok_or_else(schema_error)
}

fn scope_uri(
    costs: &Costs,
    uri: &Uri<String>,
    work: &mut Work,
    depth: usize,
) -> HostResult<Arc<Uri<String>>> {
    if let Some((known, _)) = costs.ids.get_key_value(uri) {
        return Ok(Arc::clone(known));
    }
    work.step(
        depth,
        uri.as_str()
            .len()
            .checked_add(size_of::<Uri<String>>() + ENTRY_BYTES)
            .ok_or_else(limit)?,
    )
    .map_err(|_| limit())?;
    Ok(Arc::new(uri.clone()))
}
fn check_scope_enter(
    costs: &Costs,
    document: &Arc<Uri<String>>,
    uri: &Arc<Uri<String>>,
    work: &mut Work,
    depth: usize,
) -> HostResult<()> {
    work.step(depth, ENTRY_BYTES).map_err(|_| limit())?;
    reserve_uri(costs, document, uri.as_str(), work, depth)?;
    if check_root(costs, uri, work, depth)? {
        work.lookup
            .roots
            .insert((std::ptr::from_ref(costs).addr(), Arc::clone(uri)));
    }
    Ok(())
}
fn check_enter(
    costs: &Costs,
    resolver: &Resolver<'_>,
    reference: &str,
    document: &Arc<Uri<String>>,
    work: &mut Work,
    depth: usize,
) -> HostResult<()> {
    let fragment = reference.strip_prefix('#').unwrap_or_else(|| {
        reference
            .rsplit_once('#')
            .map_or("", |(_, fragment)| fragment)
    });
    if fragment.is_empty() || fragment.starts_with('/') {
        return Ok(());
    }
    // 只有命名anchor可能动态进入其他文档；Target本身不捕获调用者的动态scope。
    check_scope_enter(costs, document, &resolver.base_uri(), work, depth)?;
    for uri in resolver.dynamic_scope().iter() {
        let uri = scope_uri(costs, uri, work, depth)?;
        check_scope_enter(costs, document, &uri, work, depth)?;
    }
    Ok(())
}

fn check_reference(
    costs: &Costs,
    resolver: &Resolver<'_>,
    reference: &str,
    work: &mut Work,
    depth: usize,
) -> HostResult<Option<Arc<Uri<String>>>> {
    work.step(depth, ENTRY_BYTES).map_err(|_| limit())?;
    let owner = std::ptr::from_ref(costs).addr();
    let hash_only = reference.starts_with('#');
    let (part, fragment) = if let Some(fragment) = reference.strip_prefix('#') {
        ("", fragment)
    } else {
        reference.rsplit_once('#').unwrap_or((reference, ""))
    };
    let root_uri = if hash_only {
        resolver.base_uri()
    } else {
        let base = resolver.base_uri();
        let fresh = uri_charge(costs, &base, part, work, depth)?;
        let Ok(uri) = resolver.resolve_uri(&base.borrow(), part) else {
            return Ok(None);
        };
        if fresh {
            remember_uri(costs, &base, part, work);
        }
        uri
    };
    let fresh = check_root(costs, &root_uri, work, depth)?;
    // '#'保留base fragment，空引用按RFC3986去掉；root id的额度在真实lookup前取得。
    let Ok(resource) = resolver.lookup(if hash_only { "#" } else { part }) else {
        return Ok(None);
    };
    if fresh {
        work.lookup.roots.insert((owner, Arc::clone(&root_uri)));
    }
    let (mut schema, root_resolver, draft) = resource.into_inner();
    let document = root_resolver.base_uri();
    if !fragment.starts_with('/') {
        return Ok(Some(document));
    }
    work.step(depth, fragment.len().checked_mul(2).ok_or_else(limit)?)
        .map_err(|_| limit())?;
    let Some(encoded) = EncodedString::new(&fragment[1..]) else {
        return Ok(Some(document));
    };
    let Ok(pointer) = encoded.decode().to_string() else {
        return Ok(Some(document));
    };
    let mut base_bytes = document.as_str().len();
    for (index, token) in pointer.split('/').enumerate() {
        let level = depth.max(index + 1);
        let bytes = token
            .len()
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(ENTRY_BYTES))
            .ok_or_else(limit)?;
        work.step(level, bytes).map_err(|_| limit())?;
        let token = referencing::unescape_segment(token);
        let next = match schema {
            Value::Object(values) => values.get(token.as_ref()),
            Value::Array(values) => token
                .parse::<usize>()
                .ok()
                .and_then(|index| values.get(index)),
            _ => None,
        };
        let Some(next) = next else {
            return Ok(Some(document));
        };
        schema = next;
        if let Some(id) = draft.create_resource_ref(schema).id() {
            // 全路径id构成单调上界，不仿制私有的maybe_in_subresource状态机。
            base_bytes = base_bytes.checked_add(id.len()).ok_or_else(limit)?;
            work.step(
                level,
                base_bytes
                    .checked_mul(4)
                    .and_then(|bytes| bytes.checked_add(ENTRY_BYTES))
                    .ok_or_else(limit)?,
            )
            .map_err(|_| limit())?;
        }
    }
    Ok(Some(document))
}
