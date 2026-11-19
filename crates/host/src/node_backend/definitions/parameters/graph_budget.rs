//! 按引用目标及动态作用域限制编译展开工作；实际引用语义仍由锁定的resolver处理。
use super::{MAX_WORK_BYTES, ROOT, Work, address, error, json_bytes, lookup_budget, schema_error};
use jsonschema::Draft;
use referencing::{List, Registry, Resolver, Uri, Vocabulary, VocabularySet, uri};
use serde_json::Value;
use serial_workbench_core::HostResult;
use std::{
    collections::HashSet,
    hash::{Hash, Hasher},
    sync::Arc,
};

const NODE_WORK_BYTES: usize = 512;
const URI_WORK_OVERHEAD: usize = 256;
const IGNORED_CHILD_BYTES: usize = 4 * std::mem::size_of::<usize>();

#[derive(PartialEq, Eq)]
struct NodeKey {
    node: usize,
    draft: Draft,
    base: Arc<Uri<String>>,
    scope: List<Uri<String>>,
    target: Option<Arc<Uri<String>>>,
}
impl Hash for NodeKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // 和上游一样优先按物理节点分桶，等值比较仍核对完整上下文。
        self.node.hash(state);
    }
}
struct Budget<'lookup, 'work> {
    lookup: &'lookup lookup_budget::Costs,
    work: &'work mut Work,
    retained_bytes: usize,
    visited: HashSet<NodeKey>,
    active: HashSet<Arc<Uri<String>>>,
}
struct Scope<'a> {
    resolver: Resolver<'a>,
    draft: Draft,
    vocabularies: Arc<VocabularySet>,
    targets: std::rc::Rc<lookup_budget::Cache<'a>>,
}
fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendSchemaGraphBudget")
}
impl Budget<'_, '_> {
    fn step(&mut self, depth: usize, bytes: usize) -> HostResult<()> {
        self.work.step(depth, bytes).map_err(|_| limit())
    }
    fn enter<'a>(
        &mut self,
        schema: &'a Value,
        parent: &Scope<'a>,
        depth: usize,
        target: Option<Arc<Uri<String>>>,
    ) -> HostResult<()> {
        let draft = parent.draft.detect(schema);
        // 非执行分支也可能在draft的资源迭代中出现；最终编译器负责其合法性。
        if let Some(resolver) = lookup_budget::try_subresource(
            self.lookup,
            &parent.resolver,
            schema,
            draft,
            self.work,
            depth,
        )? {
            // 和compiler Context一致：同Draft继承，只有Draft变化才重新选择词汇表。
            let vocabularies = if draft == parent.draft {
                Arc::clone(&parent.vocabularies)
            } else {
                Arc::new(resolver.find_vocabularies(draft, schema))
            };
            self.visit(
                schema,
                &Scope {
                    resolver,
                    draft,
                    vocabularies,
                    targets: parent.targets.clone(),
                },
                depth,
                target,
            )?;
        }
        Ok(())
    }
    fn uri_budget(
        &mut self,
        resolver: &Resolver<'_>,
        reference: &str,
        depth: usize,
    ) -> HostResult<()> {
        let bytes = resolver
            .base_uri()
            .as_str()
            .len()
            .checked_add(reference.len())
            .and_then(|bytes| bytes.checked_mul(4))
            .and_then(|bytes| bytes.checked_add(URI_WORK_OVERHEAD))
            .ok_or_else(limit)?;
        self.step(depth, bytes)
    }
    fn reference<'a>(
        &mut self,
        schema: &'a Value,
        scope: &Scope<'a>,
        reference: &str,
        recursive: bool,
        depth: usize,
    ) -> HostResult<()> {
        if reference.is_empty() {
            return Ok(());
        }
        let resolver = &scope.resolver;
        self.uri_budget(resolver, reference, depth)?;
        let base = resolver.base_uri();
        let Ok(alias) = resolver.resolve_uri(&base.borrow(), reference) else {
            return Ok(());
        };
        // 正在编译的别名用回边连接，不展开成无限增长的动态作用域。
        if self.active.contains(&alias) {
            return Ok(());
        }
        let resolved = if recursive {
            scope
                .targets
                .try_recursive(self.lookup, resolver, self.work, depth)?
        } else {
            scope
                .targets
                .try_lookup(self.lookup, resolver, reference, self.work, depth)?
        };
        let Some(resolved) = resolved else {
            return Ok(());
        };
        let (contents, resolver, draft) = resolved.into_inner();
        if std::ptr::eq(contents, schema) {
            return Ok(());
        }
        self.active.insert(Arc::clone(&alias));
        // ref目标已由resolver进入资源；不能再次应用相对$id。
        // 引用切换与普通child不同，始终使用目标资源词汇表。
        let scope = Scope {
            vocabularies: Arc::new(resolver.find_vocabularies(draft, contents)),
            resolver,
            targets: scope.targets.clone(),
            draft,
        };
        let result = self.visit(contents, &scope, depth + 1, Some(Arc::clone(&alias)));
        self.active.remove(&alias);
        result
    }
    fn visit<'a>(
        &mut self,
        schema: &'a Value,
        scope: &Scope<'a>,
        depth: usize,
        target: Option<Arc<Uri<String>>>,
    ) -> HostResult<()> {
        let draft = scope.draft;
        let resolver = &scope.resolver;
        self.step(depth, 0)?;
        let key = NodeKey {
            node: address(schema),
            draft,
            base: resolver.base_uri(),
            scope: resolver.dynamic_scope(),
            target: target.clone(),
        };
        if self.visited.contains(&key) {
            return Ok(());
        }
        let bytes = json_bytes::measure(schema, MAX_WORK_BYTES)
            .map_err(|_| limit())?
            .checked_add(NODE_WORK_BYTES)
            .ok_or_else(limit)?;
        self.step(depth, bytes)?;
        // 逐编译上下文保留逻辑图权重；URI解析与临时遍历表只属于Work，不计为常驻图。
        self.retained_bytes = self.retained_bytes.checked_add(bytes).ok_or_else(limit)?;
        self.visited.insert(key);
        for (keyword, enabled) in [
            ("$ref", true),
            (
                "$dynamicRef",
                matches!(draft, Draft::Draft202012 | Draft::Unknown),
            ),
            ("$recursiveRef", draft == Draft::Draft201909),
        ] {
            if enabled && let Some(reference) = schema.get(keyword).and_then(Value::as_str) {
                self.reference(schema, scope, reference, keyword == "$recursiveRef", depth)?;
                if keyword == "$ref" && draft < Draft::Draft201909 {
                    return Ok(());
                }
            }
        }
        let ignored = self.ignored_children(schema, depth)?;
        let applicator =
            draft < Draft::Draft201909 || scope.vocabularies.contains(&Vocabulary::Applicator);
        let unevaluated = if draft == Draft::Draft201909 {
            applicator
        } else {
            scope.vocabularies.contains(&Vocabulary::Unevaluated)
        };
        for child in draft.subresources_of(schema) {
            self.step(depth, 0)?;
            if ignored.contains(&address(child)) {
                continue;
            }
            let is_unevaluated =
                ["unevaluatedProperties", "unevaluatedItems"]
                    .iter()
                    .any(|keyword| {
                        schema
                            .get(keyword)
                            .is_some_and(|value| std::ptr::eq(value, child))
                    });
            if (is_unevaluated && !unevaluated) || (!is_unevaluated && !applicator) {
                continue;
            }
            self.enter(child, scope, depth + 1, target.clone())?;
        }
        Ok(())
    }
    fn ignored_children(&mut self, schema: &Value, depth: usize) -> HostResult<HashSet<usize>> {
        let mut ignored = HashSet::new();
        // 一次分类，避免为跳过每个definition再扫描整张定义表。
        for keyword in ["$defs", "definitions"] {
            if let Some(values) = schema.get(keyword).and_then(Value::as_object) {
                for value in values.values() {
                    self.step(depth, IGNORED_CHILD_BYTES)?;
                    ignored.insert(address(value));
                }
            }
        }
        for (keyword, skip) in [
            (
                "if",
                schema.get("then").is_none() && schema.get("else").is_none(),
            ),
            ("then", schema.get("if").is_none()),
            ("else", schema.get("if").is_none()),
            (
                "additionalItems",
                !schema.get("items").is_some_and(Value::is_array),
            ),
            // contentSchema只产生注释，不编译其中的schema。
            ("contentSchema", true),
        ] {
            if skip && let Some(value) = schema.get(keyword) {
                self.step(depth, IGNORED_CHILD_BYTES)?;
                ignored.insert(address(value));
            }
        }
        Ok(ignored)
    }
}

pub(super) fn compiler(
    schema: &Value,
    draft: Draft,
    lookup: &lookup_budget::Costs,
) -> HostResult<usize> {
    let base = uri::from_str(draft.create_resource_ref(schema).id().unwrap_or(ROOT))
        .map_err(|_| schema_error())?;
    let registry = Registry::new()
        .draft(draft)
        .retrieve_known_draft_meta_schemas(false)
        .add(base.as_str(), draft.create_resource_ref(schema))
        .map_err(|_| schema_error())?
        .prepare()
        .map_err(|_| schema_error())?;
    inspect(schema, draft, &registry, base, lookup, &mut Work::default())
}

pub(super) fn generated(
    schema: &Value,
    draft: Draft,
    registry: &Registry<'_>,
    base: &str,
    lookup: &lookup_budget::Costs,
    work: &mut Work,
) -> HostResult<usize> {
    let previous_steps = work.steps;
    let previous_bytes = work.bytes;
    work.step(
        0,
        base.len()
            .checked_add(URI_WORK_OVERHEAD)
            .ok_or_else(limit)?,
    )?;
    let base = uri::from_str(base).map_err(|_| schema_error())?;
    // 调用方只生成无id的pattern根或绝对ref根；借用实际overlay，不复制整个registry。
    let lookup = lookup.without_uri_cache();
    // 只隔离查找去重表，保留请求已经消耗的bytes/steps及其他状态。
    // 局部Costs地址可能复用，跨overlay不得据此继承另一张UriCache的信用。
    let previous_memo = std::mem::take(&mut work.lookup);
    let result = inspect(schema, draft, registry, base, &lookup, work);
    work.lookup = previous_memo;
    let retained_bytes = result?;
    // 检查器在overlay A实际解析；随后compiler B又新建UriCache。
    // A的命中不能替B抵扣，构建前再预留一份保守展开工作，不重复持有常驻图权重。
    work.charge(0, work.steps - previous_steps, work.bytes - previous_bytes)
        .map_err(|_| limit())?;
    Ok(retained_bytes)
}

fn inspect(
    schema: &Value,
    draft: Draft,
    registry: &Registry<'_>,
    base: Uri<String>,
    lookup: &lookup_budget::Costs,
    work: &mut Work,
) -> HostResult<usize> {
    let targets = lookup_budget::Cache::new(work, 0)?;
    let mut budget = Budget {
        lookup,
        work,
        retained_bytes: 0,
        visited: HashSet::new(),
        active: HashSet::new(),
    };
    let scope = Scope {
        vocabularies: Arc::new(registry.find_vocabularies(draft, schema)),
        resolver: registry.resolver(base),
        draft,
        targets,
    };
    budget.enter(schema, &scope, 0, None)?;
    Ok(budget.retained_bytes)
}
