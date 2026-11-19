//! 跟随registry的deferred local refs；目标路径经过的数据只有被引用后才参与预检。
use super::{
    Draft, Projection, Traversal, Uri, Value, index_budget, limit, raw_resource_id, size_of,
};
use serial_workbench_core::HostResult;
use std::sync::Arc;

struct Target<'a> {
    schema: &'a Value,
    draft: Draft,
    base: Arc<Uri<String>>,
    may_reuse_normal: bool,
}

impl<'a> Projection<'a, '_> {
    pub(super) fn local_reference(&mut self, reference: &'a str, depth: usize) -> HostResult<()> {
        if reference.len() <= 1 {
            return Ok(());
        }
        let pointer = reference.trim_start_matches('#');
        if !self.local_seen.contains(pointer) {
            self.charge(
                depth,
                pointer
                    .len()
                    .checked_add(size_of::<[usize; 8]>())
                    .ok_or_else(limit)?,
            )?;
            self.local_seen.insert(pointer);
            self.local_queue.push_back(pointer);
        }
        Ok(())
    }

    pub(super) fn local_targets(
        &mut self,
        document: &'a Value,
        draft: Draft,
        root: &Arc<Uri<String>>,
    ) -> HostResult<()> {
        while let Some(pointer) = self.local_queue.pop_front() {
            if let Some(target) = self.pointer_target(document, draft, root, pointer)? {
                // 只有实际常规路径可复用；锚点、数字对象键及容器元数据保留上游额外发现。
                if target.may_reuse_normal
                    && self.normally_crawled(target.schema, target.draft, &target.base)
                {
                    continue;
                }
                self.visit(
                    target.schema,
                    target.draft,
                    &target.base,
                    index_budget::Site::reference(0),
                    Traversal::References,
                )?;
            }
        }
        Ok(())
    }

    fn pointer_target(
        &mut self,
        document: &'a Value,
        mut draft: Draft,
        root: &Arc<Uri<String>>,
        pointer: &str,
    ) -> HostResult<Option<Target<'a>>> {
        let mut schema = document;
        let mut base = Arc::clone(root);
        let mut may_reuse_normal = pointer.is_empty() || pointer.starts_with('/');
        if let Some(id) = raw_resource_id(schema, draft, Traversal::References) {
            base = self.resolve_id(&base, id, 0)?;
            if self.collect_lookup {
                self.lookup.resource(
                    &base,
                    draft.create_resource_ref(schema).id(),
                    self.work,
                    0,
                )?;
            }
        }
        if let Some(pointer) = pointer.strip_prefix('/') {
            for (index, token) in pointer.split('/').enumerate() {
                // unescape可能分配；在调用共享实现和进入下个值之前检查路径工作量。
                self.charge(index + 1, token.len())?;
                let token = referencing::unescape_segment(token);
                let array_index = referencing::parse_index(&token);
                // pinned is_crawled_path不把数字对象键当普通路径；真实pointer lookup仍支持它。
                if schema.is_object() && array_index.is_some() {
                    may_reuse_normal = false;
                }
                let next = match schema {
                    Value::Object(values) => values.get(token.as_ref()),
                    Value::Array(values) => array_index.and_then(|index| values.get(index)),
                    _ => None,
                };
                let Some(next) = next else {
                    // 不存在的引用仍由真实compiler返回原schema错误，不在此伪造资源。
                    return Ok(None);
                };
                schema = next;
                let inherited = draft;
                draft = draft.detect(schema);
                let resource = draft.create_resource_ref(schema);
                let id = raw_resource_id(schema, draft, Traversal::References);
                if let Some(id) = id {
                    base = self.resolve_id(&base, id, index + 1)?;
                    if self.collect_lookup {
                        self.lookup
                            .resource(&base, resource.id(), self.work, index + 1)?;
                    }
                }
                // 真实schema节点可自带方言/id，承载schema的容器出现它们则必须追加发现。
                if !self.normally_crawled(schema, draft, &base)
                    && (draft != inherited || id.is_some())
                {
                    may_reuse_normal = false;
                }
            }
        }
        // 对齐resolve_deferred_target：每个前缀的id影响基址，随后引用遍历再次进入目标。
        Ok(Some(Target {
            schema,
            draft,
            base,
            may_reuse_normal,
        }))
    }
}
