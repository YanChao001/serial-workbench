//! 候选只保存自身提案；借来的结构仅用于求值上下文，不能遮住后续分支的默认值。
use super::{Work, invalid, limit};
use serde_json::{Map, Value};
use serial_workbench_core::HostResult;
use std::collections::BTreeMap;

#[derive(Debug, PartialEq)]
pub(super) enum Candidate {
    Missing,
    Scalar(Value),
    Object {
        /// 原输入或本候选的字面默认值已建立容器；false仅借用求值结构。
        present: bool,
        fields: BTreeMap<String, Candidate>,
    },
    Array {
        /// 原输入或本候选的字面默认值已建立容器；Missing槽位仍须由实际提案补齐。
        present: bool,
        items: Vec<Candidate>,
    },
}
impl Candidate {
    pub(super) fn from_value(value: Value, work: &mut Work) -> HostResult<Self> {
        Self::read(value, work, 0)
    }
    fn read(value: Value, work: &mut Work, depth: usize) -> HostResult<Self> {
        work.step(depth, std::mem::size_of::<Self>())?;
        Ok(match value {
            Value::Object(object) => {
                allocation(
                    work,
                    depth,
                    object.len(),
                    std::mem::size_of::<(String, Self)>(),
                )?;
                Self::Object {
                    present: true,
                    fields: object
                        .into_iter()
                        .map(|(key, value)| Ok((key, Self::read(value, work, depth + 1)?)))
                        .collect::<HostResult<_>>()?,
                }
            }
            Value::Array(array) => {
                allocation(work, depth, array.len(), std::mem::size_of::<Self>())?;
                Self::Array {
                    present: true,
                    items: array
                        .into_iter()
                        .map(|value| Self::read(value, work, depth + 1))
                        .collect::<HostResult<_>>()?,
                }
            }
            scalar => Self::Scalar(scalar),
        })
    }
    pub(super) fn copy(&self, work: &mut Work) -> HostResult<Self> {
        self.copy_at(work, 0)
    }
    fn copy_at(&self, work: &mut Work, depth: usize) -> HostResult<Self> {
        work.step(depth, std::mem::size_of::<Self>())?;
        Ok(match self {
            Self::Missing => Self::Missing,
            Self::Scalar(value) => Self::Scalar(work.copy(value)?),
            Self::Object { present, fields } => {
                allocation(
                    work,
                    depth,
                    fields.len(),
                    std::mem::size_of::<(String, Self)>(),
                )?;
                Self::Object {
                    present: *present,
                    fields: fields
                        .iter()
                        .map(|(key, value)| {
                            work.step(depth, key.len())?;
                            Ok((key.clone(), value.copy_at(work, depth + 1)?))
                        })
                        .collect::<HostResult<_>>()?,
                }
            }
            Self::Array { present, items } => {
                allocation(work, depth, items.len(), std::mem::size_of::<Self>())?;
                Self::Array {
                    present: *present,
                    items: items
                        .iter()
                        .map(|value| value.copy_at(work, depth + 1))
                        .collect::<HostResult<_>>()?,
                }
            }
        })
    }
    pub(super) fn present(&self) -> bool {
        match self {
            Self::Missing => false,
            Self::Scalar(_) => true,
            Self::Object { present, .. } | Self::Array { present, .. } => *present,
        }
    }
    pub(super) fn has_proposal(&self, work: &mut Work) -> HostResult<bool> {
        self.has_proposal_at(work, 0)
    }
    fn has_proposal_at(&self, work: &mut Work, depth: usize) -> HostResult<bool> {
        work.step(depth, 0)?;
        if self.present() {
            return Ok(true);
        }
        match self {
            Self::Object { fields, .. } => {
                for value in fields.values() {
                    if value.has_proposal_at(work, depth + 1)? {
                        return Ok(true);
                    }
                }
            }
            Self::Array { items, .. } => {
                for value in items {
                    if value.has_proposal_at(work, depth + 1)? {
                        return Ok(true);
                    }
                }
            }
            _ => {}
        }
        Ok(false)
    }
    pub(super) fn borrow_shape(&mut self, seed: Option<&Self>, work: &mut Work) -> HostResult<()> {
        if !matches!(self, Self::Missing) {
            return Ok(());
        }
        if let Some(seed) = seed.filter(|seed| seed.present()) {
            work.step(0, std::mem::size_of::<Self>())?;
            *self = match seed {
                Self::Object { .. } => Self::Object {
                    present: false,
                    fields: BTreeMap::new(),
                },
                Self::Array { .. } => Self::Array {
                    present: false,
                    items: Vec::new(),
                },
                _ => Self::Missing,
            };
        }
        Ok(())
    }
    pub(super) fn object(&self) -> Option<&BTreeMap<String, Self>> {
        if let Self::Object { fields, .. } = self {
            Some(fields)
        } else {
            None
        }
    }
    pub(super) fn array(&self) -> Option<&[Self]> {
        if let Self::Array { items, .. } = self {
            Some(items)
        } else {
            None
        }
    }
    pub(super) fn context(
        &self,
        seed: Option<&Self>,
        work: &mut Work,
    ) -> HostResult<Option<Value>> {
        self.context_at(seed, work, 0)
    }
    fn context_at(
        &self,
        seed: Option<&Self>,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Option<Value>> {
        work.step(depth, std::mem::size_of::<Value>())?;
        match self {
            Self::Missing => seed.map_or(Ok(None), |seed| seed.context_at(None, work, depth)),
            Self::Scalar(value) => Ok(Some(work.copy(value)?)),
            Self::Object { present, fields } => {
                let seed_fields = seed.and_then(Self::object);
                if !present && !seed.is_some_and(|s| s.present() && s.object().is_some()) {
                    return Ok(None);
                }
                let mut object = Map::new();
                if let Some(seed_fields) = seed_fields {
                    for (key, value) in seed_fields {
                        if !fields.contains_key(key)
                            && let Some(value) = value.context_at(None, work, depth + 1)?
                        {
                            work.step(depth, key.len())?;
                            object.insert(key.clone(), value);
                        }
                    }
                }
                for (key, value) in fields {
                    if let Some(value) =
                        value.context_at(seed_fields.and_then(|s| s.get(key)), work, depth + 1)?
                    {
                        work.step(depth, key.len())?;
                        object.insert(key.clone(), value);
                    }
                }
                Ok(Some(Value::Object(object)))
            }
            Self::Array { present, items } => {
                let seed_items = seed.and_then(Self::array);
                if !present && !seed.is_some_and(|s| s.present() && s.array().is_some()) {
                    return Ok(None);
                }
                let mut array = Vec::new();
                let mut gap = false;
                for index in 0..items.len().max(seed_items.map_or(0, <[Self]>::len)) {
                    let value = items.get(index).unwrap_or(&Self::Missing).context_at(
                        seed_items.and_then(|s| s.get(index)),
                        work,
                        depth + 1,
                    )?;
                    match value {
                        Some(value) if !gap => array.push(value),
                        Some(_) => return Err(invalid()),
                        None => gap = true,
                    }
                }
                Ok(Some(Value::Array(array)))
            }
        }
    }
    pub(super) fn merge(&mut self, other: Self, work: &mut Work) -> HostResult<()> {
        self.merge_at(other, work, 0)
    }
    fn merge_at(&mut self, other: Self, work: &mut Work, depth: usize) -> HostResult<()> {
        work.step(depth, 0)?;
        if !other.has_proposal(work)? {
            return Ok(());
        }
        if !self.has_proposal(work)? {
            *self = other;
            return Ok(());
        }
        match (&mut *self, other) {
            (
                Self::Object { present, fields },
                Self::Object {
                    present: right_present,
                    fields: right,
                },
            ) => {
                *present |= right_present;
                for (key, value) in right {
                    if let Some(existing) = fields.get_mut(&key) {
                        existing.merge_at(value, work, depth + 1)?;
                    } else {
                        fields.insert(key, value);
                    }
                }
            }
            (
                Self::Array { present, items },
                Self::Array {
                    present: right_present,
                    items: right,
                },
            ) => {
                *present |= right_present;
                if right.len() > items.len() {
                    work.charge(
                        depth,
                        right.len() - items.len(),
                        (right.len() - items.len()) * std::mem::size_of::<Self>(),
                    )?;
                    items.resize_with(right.len(), || Self::Missing);
                }
                for (index, value) in right.into_iter().enumerate() {
                    items[index].merge_at(value, work, depth + 1)?;
                }
            }
            (Self::Scalar(left), Self::Scalar(right)) if *left == right => {}
            (left, right) if !left.present() && right.present() => *left = right,
            (left, right) if left.present() && !right.present() => {}
            _ => return Err(invalid()),
        }
        Ok(())
    }
    pub(super) fn agreement(
        base: &Self,
        left: Self,
        right: &Self,
        work: &mut Work,
    ) -> HostResult<Self> {
        Self::agree_at(base, left, right, work, 0)
    }
    fn agree_at(
        base: &Self,
        left: Self,
        right: &Self,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Self> {
        work.step(depth, 0)?;
        if left == *right {
            return Ok(left);
        }
        // 缺失位置的完整字面值须一致；不能由两个不同对象默认值凭空合成空对象。
        if matches!(base, Self::Missing) && left.present() && right.present() {
            return Ok(Self::Missing);
        }
        Ok(match (left, right) {
            (
                Self::Object { present, fields },
                Self::Object {
                    present: right_present,
                    fields: right,
                },
            ) => {
                let mut agreed = BTreeMap::new();
                for (key, value) in fields {
                    let value = Self::agree_at(
                        base.object()
                            .and_then(|b| b.get(&key))
                            .unwrap_or(&Self::Missing),
                        value,
                        right.get(&key).unwrap_or(&Self::Missing),
                        work,
                        depth + 1,
                    )?;
                    if value.has_proposal(work)? {
                        agreed.insert(key, value);
                    }
                }
                Self::Object {
                    present: base.present() || (present && *right_present),
                    fields: agreed,
                }
            }
            (
                Self::Array { present, items },
                Self::Array {
                    present: right_present,
                    items: right,
                },
            ) => {
                let count = base
                    .array()
                    .map_or(0, <[Self]>::len)
                    .max(items.len().min(right.len()));
                let mut agreed = Vec::new();
                for (index, value) in items.into_iter().take(count).enumerate() {
                    agreed.push(Self::agree_at(
                        base.array()
                            .and_then(|b| b.get(index))
                            .unwrap_or(&Self::Missing),
                        value,
                        right.get(index).unwrap_or(&Self::Missing),
                        work,
                        depth + 1,
                    )?);
                }
                Self::Array {
                    present: base.present() || (present && *right_present),
                    items: agreed,
                }
            }
            _ => base.copy(work)?,
        })
    }
    pub(super) fn pointer<'a>(
        &'a self,
        path: &str,
        work: &mut Work,
    ) -> HostResult<Option<&'a Self>> {
        let mut value = self;
        for token in tokens(path, work)? {
            value = match value {
                Self::Object { fields, .. } => match fields.get(&token) {
                    Some(value) => value,
                    None => return Ok(None),
                },
                Self::Array { items, .. } => {
                    match token.parse::<usize>().ok().and_then(|i| items.get(i)) {
                        Some(value) => value,
                        None => return Ok(None),
                    }
                }
                _ => return Ok(None),
            };
        }
        Ok(Some(value))
    }
    pub(super) fn pointer_mut<'a>(
        &'a mut self,
        path: &str,
        context: &Value,
        work: &mut Work,
    ) -> HostResult<&'a mut Self> {
        let mut value = self;
        let mut context = context;
        for token in tokens(path, work)? {
            if matches!(value, Self::Missing) {
                work.step(0, std::mem::size_of::<Self>())?;
                *value = match context {
                    Value::Object(_) => Self::Object {
                        present: false,
                        fields: BTreeMap::new(),
                    },
                    Value::Array(_) => Self::Array {
                        present: false,
                        items: Vec::new(),
                    },
                    _ => return Err(invalid()),
                };
            }
            match (value, context) {
                (Self::Object { fields, .. }, Value::Object(object)) => {
                    context = object.get(&token).ok_or_else(invalid)?;
                    if !fields.contains_key(&token) {
                        work.step(0, std::mem::size_of::<Self>())?;
                    }
                    value = fields.entry(token).or_insert(Self::Missing);
                }
                (Self::Array { items, .. }, Value::Array(array)) => {
                    let index = token.parse::<usize>().map_err(|_| invalid())?;
                    context = array.get(index).ok_or_else(invalid)?;
                    if index >= items.len() {
                        work.charge(
                            0,
                            index + 1 - items.len(),
                            (index + 1 - items.len()) * std::mem::size_of::<Self>(),
                        )?;
                        items.resize_with(index + 1, || Self::Missing);
                    }
                    value = &mut items[index];
                }
                _ => return Err(invalid()),
            }
        }
        Ok(value)
    }
}
fn allocation(work: &mut Work, depth: usize, count: usize, size: usize) -> HostResult<()> {
    // collect可按size_hint预分配；先预留整个集合，再进入逐节点转换或复制。
    work.charge(depth, count, count.checked_mul(size).ok_or_else(limit)?)
}
fn tokens(path: &str, work: &mut Work) -> HostResult<Vec<String>> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    if !path.starts_with('/') {
        return Err(invalid());
    }
    let mut result = Vec::new();
    for token in path[1..].split('/') {
        work.step(0, token.len() * 2 + std::mem::size_of::<String>())?;
        result.push(token.replace("~1", "/").replace("~0", "~"));
    }
    Ok(result)
}
