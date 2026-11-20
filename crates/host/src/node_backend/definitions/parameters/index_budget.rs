//! owned索引的路径和锚点副本在构造前计费；路径只来自公开Draft实际列出的子schema。
use super::{Work, error, registry_budget, schema_error};
use jsonschema::Draft;
use serde_json::Value;
use serial_workbench_core::HostResult;
use std::{mem::size_of, slice, sync::OnceLock};

// 锁定referencing的索引条目含指针Vec、文档Arc、Draft与锚点元数据；此为逻辑权重。
const ENTRY_BYTES: usize = size_of::<[usize; 16]>();
const SEGMENT_BYTES: usize = size_of::<[usize; 3]>();
const CRAWL_DEPTH_CAP: usize = 128;

fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendSchemaIndexBudget")
}

pub(super) fn anchor_names(schema: &Value, draft: Draft) -> impl Iterator<Item = &str> {
    // 上游未公开anchor迭代器；这里只投影锁定版本的0—2个名称，不解析或替代引用语义。
    let (first, second) = match draft {
        Draft::Draft4 | Draft::Draft6 | Draft::Draft7 => (
            schema
                .get(draft.id_keyword())
                .and_then(Value::as_str)
                .and_then(|id| id.strip_prefix('#')),
            None,
        ),
        Draft::Draft201909 => (schema.get("$anchor").and_then(Value::as_str), None),
        _ => (
            schema.get("$anchor").and_then(Value::as_str),
            schema.get("$dynamicAnchor").and_then(Value::as_str),
        ),
    };
    [first, second].into_iter().flatten()
}

#[derive(Clone, Copy, Default)]
struct Pointer {
    segments: usize,
    keys: usize,
}
impl Pointer {
    fn segment(self, key_bytes: usize) -> HostResult<Self> {
        Ok(Self {
            segments: self.segments.checked_add(1).ok_or_else(limit)?,
            keys: self.keys.checked_add(key_bytes).ok_or_else(limit)?,
        })
    }
    fn copy_bytes(self, capacity_factor: usize) -> HostResult<usize> {
        self.segments
            .checked_mul(SEGMENT_BYTES)
            .and_then(|bytes| bytes.checked_mul(capacity_factor))
            .and_then(|bytes| bytes.checked_add(self.keys))
            .ok_or_else(limit)
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct Site {
    pub(super) depth: usize,
    pointer: Pointer,
}
impl Site {
    pub(super) fn reference(depth: usize) -> Self {
        Self {
            depth,
            ..Self::default()
        }
    }
    fn child(self, field: &str, member: Member<'_>) -> HostResult<Self> {
        let pointer = self.pointer.segment(field.len())?;
        let pointer = match member {
            Member::Direct => pointer,
            Member::Key(key) => pointer.segment(key.len())?,
            Member::Index => pointer.segment(0)?,
        };
        Ok(Self {
            depth: self.depth.checked_add(1).ok_or_else(limit)?,
            pointer,
        })
    }
}

#[derive(Clone, Copy)]
enum Member<'a> {
    Direct,
    Key(&'a str),
    Index,
}
enum Members<'a> {
    Empty,
    Object(serde_json::map::Iter<'a>),
    Array(slice::Iter<'a, Value>),
}
impl<'a> Members<'a> {
    fn next(&mut self) -> Option<(&'a Value, Member<'a>)> {
        match self {
            Self::Empty => None,
            Self::Object(values) => values.next().map(|(key, value)| (value, Member::Key(key))),
            Self::Array(values) => values.next().map(|value| (value, Member::Index)),
        }
    }
}
struct Physical<'a> {
    fields: Option<serde_json::map::Iter<'a>>,
    field: &'a str,
    members: Members<'a>,
}
impl<'a> Physical<'a> {
    fn next(&mut self) -> Option<(&'a Value, &'a str, Member<'a>)> {
        if let Some((value, member)) = self.members.next() {
            return Some((value, self.field, member));
        }
        let (field, value) = self.fields.as_mut()?.next()?;
        self.field = field;
        self.members = match value {
            Value::Object(values) => Members::Object(values.iter()),
            Value::Array(values) => Members::Array(values.iter()),
            _ => Members::Empty,
        };
        Some((value, field, Member::Direct))
    }
}

pub(super) fn children(
    schema: &Value,
    draft: Draft,
    site: Site,
) -> impl Iterator<Item = HostResult<(&Value, Site)>> {
    let mut actual = draft.subresources_of(schema);
    let mut physical = Physical {
        fields: schema.as_object().map(|values| values.iter()),
        field: "",
        members: Members::Empty,
    };
    std::iter::from_fn(move || {
        let child = actual.next()?;
        while let Some((value, field, member)) = physical.next() {
            if std::ptr::eq(child, value) {
                if matches!(member, Member::Direct) {
                    physical.members = Members::Empty;
                }
                return Some(site.child(field, member).map(|site| (child, site)));
            }
        }
        // pinned子schema位于直接字段或一层map/array中；匹配身份，不另写关键字语义表。
        Some(Err(schema_error()))
    })
}

fn registration_bytes(
    schema: &Value,
    draft: Draft,
    site: Site,
    resource: bool,
) -> HostResult<(usize, usize)> {
    let copy = site.pointer.copy_bytes(1)?;
    let entry = ENTRY_BYTES.checked_add(copy).ok_or_else(limit)?;
    let mut bytes = if resource { entry } else { 0 };
    let mut entries = usize::from(resource);
    for anchor in anchor_names(schema, draft) {
        let anchor_bytes = anchor
            .len()
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(entry))
            .ok_or_else(limit)?;
        bytes = bytes.checked_add(anchor_bytes).ok_or_else(limit)?;
        entries = entries.checked_add(1).ok_or_else(limit)?;
    }
    if entries != 0 {
        // absolute_pointer先构造临时路径，随后每个resource/anchor各自clone；Vec增长与前缀合并留余量。
        bytes = bytes
            .checked_add(site.pointer.copy_bytes(4)?)
            .ok_or_else(limit)?;
    }
    Ok((bytes, entries))
}
pub(super) fn registration(
    schema: &Value,
    draft: Draft,
    site: Site,
    resource: bool,
    work: &mut Work,
) -> HostResult<()> {
    let (bytes, entries) = registration_bytes(schema, draft, site, resource)?;
    work.charge(site.depth, entries + 1, bytes)
        .map_err(|_| limit())
}
pub(super) fn deferred(schema: &Value, site: Site, work: &mut Work) -> HostResult<()> {
    if schema.is_object() && site.depth != 0 && site.depth.is_multiple_of(CRAWL_DEPTH_CAP) {
        work.step(site.depth, site.pointer.copy_bytes(4)?)
            .map_err(|_| limit())?;
    }
    Ok(())
}

fn fixed_cost(schema: &Value, draft: Draft, site: Site) -> HostResult<usize> {
    let resource = schema
        .get(draft.id_keyword())
        .and_then(Value::as_str)
        .is_some();
    let mut bytes = if site.depth == 0 || resource || anchor_names(schema, draft).next().is_some() {
        registration_bytes(schema, draft, site, site.depth == 0 || resource)?.0
    } else {
        0
    };
    if site.depth == 0 && resource {
        // meta可因显式seed与id不同再登记一次；固定数据保守预留，不依赖用户URI。
        bytes = bytes
            .checked_add(registration_bytes(schema, draft, site, true)?.0)
            .ok_or_else(limit)?;
    }
    for child in children(schema, draft, site) {
        let (child, site) = child?;
        bytes = bytes
            .checked_add(fixed_cost(child, draft.detect(child), site)?)
            .ok_or_else(limit)?;
    }
    Ok(bytes)
}
pub(super) fn bundled_meta(work: &mut Work) -> HostResult<()> {
    static COST: OnceLock<usize> = OnceLock::new();
    let bytes = *COST.get_or_init(|| {
        registry_budget::bundled_meta_schemas()
            .into_iter()
            .try_fold(0usize, |total, schema| {
                let mut maximum = 0;
                for draft in [
                    Draft::Draft4,
                    Draft::Draft6,
                    Draft::Draft7,
                    Draft::Draft201909,
                    Draft::Draft202012,
                    Draft::Unknown,
                ] {
                    maximum = maximum.max(fixed_cost(schema, draft, Site::default())?);
                }
                total.checked_add(maximum).ok_or_else(limit)
            })
            .expect("Pinned meta-schema index costs must fit the fixed projection")
    });
    work.step(0, bytes).map_err(|_| limit())
}

pub(super) fn pattern(schema: &Value, draft: Draft, work: &mut Work) -> HostResult<()> {
    // 两个调用方只生成pattern根或带false属性子schema的根，没有id、锚点或引用。
    registration(schema, draft, Site::default(), true, work)?;
    bundled_meta(work)
}
