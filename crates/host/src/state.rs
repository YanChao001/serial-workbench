//! 状态投影、快照接续与每个订阅独立的有界队列。数据库检查不持有投影锁。
use crate::auth::{AuthService, AuthenticatedActor, GrantStamp, HostIdentity};
use serde::Serialize;
use serial_workbench_core::*;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{self, Write},
    sync::{Arc, Mutex, MutexGuard, Weak},
};
use tokio::sync::{Notify, watch};

#[derive(Clone, Copy)]
pub struct ProjectionLimits {
    pub history_items: usize,
    pub history_bytes: usize,
    pub queue_items: usize,
    pub queue_bytes: usize,
}
impl Default for ProjectionLimits {
    fn default() -> Self {
        Self {
            history_items: 256,
            history_bytes: 4 * 1024 * 1024,
            queue_items: 256,
            queue_bytes: 4 * 1024 * 1024,
        }
    }
}
impl ProjectionLimits {
    fn validate(self) -> HostResult<()> {
        if [
            self.history_items,
            self.history_bytes,
            self.queue_items,
            self.queue_bytes,
        ]
        .contains(&0)
        {
            Err(HostError::new(
                "INVALID_ARGUMENT",
                "Projection limits must be positive",
            ))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone)]
pub struct ProjectionStore {
    inner: Arc<ProjectionInner>,
}
struct ProjectionInner {
    identity: HostIdentity,
    auth: AuthService,
    limits: ProjectionLimits,
    scopes: Mutex<BTreeMap<Id, Arc<Scope>>>,
}
struct Scope {
    id: Id,
    permission: String,
    state: Mutex<ScopeState>,
}
struct ScopeState {
    target: Target,
    revision: U64,
    value: JsonObject,
    history: VecDeque<Arc<Entry>>,
    history_bytes: usize,
    readers: BTreeMap<Id, Weak<Reader>>,
}
struct Entry {
    delta: Delta,
    bytes: usize,
}
struct Reader {
    state: Mutex<ReaderState>,
    notify: Notify,
    delivery: watch::Sender<bool>,
}
struct ReaderState {
    queue: VecDeque<Arc<Entry>>,
    bytes: usize,
    terminal: Option<HostError>,
    closed: bool,
}
impl ReaderState {
    fn end(&mut self, error: Option<HostError>, delivery: &watch::Sender<bool>) {
        self.queue.clear();
        self.bytes = 0;
        self.closed = true;
        self.terminal = error;
        delivery.send_replace(false);
    }
}

impl ProjectionStore {
    pub fn new(identity: HostIdentity, auth: AuthService, limits: ProjectionLimits) -> Self {
        Self {
            inner: Arc::new(ProjectionInner {
                identity,
                auth,
                limits,
                scopes: Mutex::new(BTreeMap::new()),
            }),
        }
    }
    /// scope 身份不复用，生产者必须按实际敏感度声明权限并提供安全投影。
    pub fn register_scope(
        &self,
        scope_id: Id,
        target: Target,
        permission: String,
        initial_state: JsonObject,
    ) -> HostResult<()> {
        self.inner.limits.validate()?;
        target.validate()?;
        if target.host_id != self.inner.identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Scope belongs to a different Host",
            ));
        }
        let valid = match scope_id.as_str() {
            "settings:shared" => {
                target.kind.as_str() == "settings"
                    && target.id.as_str() == "shared"
                    && target.session_id.is_none()
                    && target.session_epoch.is_none()
            }
            "host.activity" | "host.operations" | "host.devices" => {
                target.kind.as_str() == "host"
                    && target.session_id.is_none()
                    && target.session_epoch.is_none()
            }
            value if value.starts_with("workspace:") => {
                target.kind.as_str() == "workspace"
                    && value.strip_prefix("workspace:") == Some(target.id.as_str())
                    && target.session_id.is_none()
                    && target.session_epoch.is_none()
            }
            value if value.starts_with("session:") => {
                target.kind.as_str() == "session"
                    && value.strip_prefix("session:") == Some(target.id.as_str())
                    && target.session_id.as_ref() == Some(&target.id)
                    && target.session_epoch.is_some()
            }
            _ => false,
        };
        if !valid || !["metadata.read", "content.read"].contains(&permission.as_str()) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid projection scope or read permission",
            ));
        }
        encoded_length(&initial_state, self.inner.limits.history_bytes)?;
        let mut scopes = lock(&self.inner.scopes)?;
        if scopes.contains_key(&scope_id) {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Projection scope is already registered",
            ));
        }
        // 文档投影工作集有界，达到容量时不会删除持久文档。
        if is_document_scope(&scope_id)
            && scopes.keys().filter(|id| is_document_scope(id)).count() >= 256
        {
            return Err(limit());
        }
        scopes.insert(
            scope_id.clone(),
            Arc::new(Scope {
                id: scope_id,
                permission,
                state: Mutex::new(ScopeState {
                    target,
                    revision: 0.into(),
                    value: initial_state,
                    history: VecDeque::new(),
                    history_bytes: 0,
                    readers: BTreeMap::new(),
                }),
            }),
        );
        Ok(())
    }
    pub fn commit(
        &self,
        scope_id: &Id,
        event_type: Id,
        state: JsonObject,
        payload: JsonObject,
    ) -> HostResult<Delta> {
        self.commit_with_target(scope_id, None, event_type, state, payload)
    }
    /// 同一 session scope 重开：epoch 严格前进，旧 reader/history 同次提交失效。
    pub fn commit_for_target(
        &self,
        scope_id: &Id,
        target: Target,
        event_type: Id,
        state: JsonObject,
        payload: JsonObject,
    ) -> HostResult<Delta> {
        self.commit_with_target(scope_id, Some(target), event_type, state, payload)
    }
    fn commit_with_target(
        &self,
        scope_id: &Id,
        target: Option<Target>,
        event_type: Id,
        state: JsonObject,
        payload: JsonObject,
    ) -> HostResult<Delta> {
        let scope = self.scope(scope_id)?;
        if let Some(target) = &target {
            target.validate()?;
            if target.host_id != self.inner.identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Scope belongs to a different Host",
                ));
            }
        }
        let limits = self.inner.limits;
        encoded_length(&state, limits.history_bytes)?;
        // 计数序列化在锁外完成；持锁时只补十进制水位宽度，不分配序列化副本。
        let zero = self.cursor(scope_id, 0.into());
        let mut delta = Delta {
            cursor: zero.clone(),
            previous_cursor: zero,
            revision: 0.into(),
            event_type,
            payload,
        };
        let base_bytes = encoded_length(&delta, limits.history_bytes.min(limits.queue_bytes))?;
        let mut current = lock(&scope.state)?;
        if let Some(target) = &target {
            let previous = &current.target;
            if previous.kind.as_str() != "session"
                || target.kind != previous.kind
                || target.host_id != previous.host_id
                || target.id != previous.id
                || target.session_id != previous.session_id
                || target.session_epoch.is_none()
            {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Retarget requires the same session identity",
                ));
            }
            if target.session_epoch <= previous.session_epoch {
                return Err(epoch_changed());
            }
        }
        let next = current.revision.checked_next()?;
        let extra = 2 * (digits(next) - 1) + digits(current.revision) - 1;
        let bytes = base_bytes.checked_add(extra).ok_or_else(limit)?;
        if bytes > limits.history_bytes || bytes > limits.queue_bytes {
            return Err(limit());
        }
        let history_bytes = if target.is_some() {
            0
        } else {
            current.history_bytes.checked_add(bytes).ok_or_else(limit)?
        };
        delta.previous_cursor.position = current.revision;
        delta.cursor.position = next;
        delta.revision = next;
        let entry = Arc::new(Entry {
            delta: delta.clone(),
            bytes,
        });
        current.value = state;
        current.revision = next;
        if let Some(target) = target {
            current.target = target;
            // 重开提交成为新 snapshot 起点；旧 cursor 不能补读跨 epoch 的边界事件。
            current.history.clear();
            current.history_bytes = 0;
            for weak in current.readers.values() {
                if let Some(reader) = weak.upgrade() {
                    if let Ok(mut pending) = reader.state.lock() {
                        pending.end(Some(epoch_changed()), &reader.delivery);
                    }
                    reader.notify.notify_one();
                }
            }
            current.readers.clear();
            return Ok(delta);
        }
        current.history.push_back(entry.clone());
        current.history_bytes = history_bytes;
        while current.history.len() > limits.history_items
            || current.history_bytes > limits.history_bytes
        {
            let removed = current.history.pop_front().expect("history has an item");
            current.history_bytes -= removed.bytes;
        }
        let oldest = oldest_cursor(&current, &delta.cursor);
        current.readers.retain(|_, weak| {
            let Some(reader) = weak.upgrade() else {
                return false;
            };
            let Ok(mut pending) = reader.state.lock() else {
                return false;
            };
            if pending.closed {
                return false;
            }
            if pending.queue.len() >= limits.queue_items
                || pending
                    .bytes
                    .checked_add(bytes)
                    .is_none_or(|total| total > limits.queue_bytes)
            {
                pending.end(Some(expired(&scope.id, oldest.clone())), &reader.delivery);
                reader.notify.notify_one();
                return false;
            }
            pending.queue.push_back(entry.clone());
            pending.bytes += bytes;
            reader.notify.notify_one();
            true
        });
        Ok(delta)
    }
    pub async fn snapshot(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
    ) -> HostResult<Snapshot> {
        self.snapshot_target(actor, scope_id, None).await
    }
    pub(crate) async fn snapshot_for(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
        target: &Target,
    ) -> HostResult<Snapshot> {
        self.snapshot_target(actor, scope_id, Some(target)).await
    }
    async fn snapshot_target(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
        expected: Option<&Target>,
    ) -> HostResult<Snapshot> {
        let scope = self.scope(scope_id)?;
        let target = lock(&scope.state)?.target.clone();
        verify_target(expected, &target)?;
        let stamp = check(&self.inner.auth, actor, &target, &scope.permission).await?;
        let snapshot = {
            let current = lock(&scope.state)?;
            same_target(&current, &target)?;
            Snapshot {
                host_id: self.inner.identity.host_id.clone(),
                instance_epoch: self.inner.identity.instance_epoch,
                revision: current.revision,
                cursor: self.cursor(scope_id, current.revision),
                state: current.value.clone(),
            }
        };
        recheck(&self.inner.auth, actor, &target, &scope.permission, stamp).await?;
        same_target(&*lock(&scope.state)?, &target)?;
        Ok(snapshot)
    }
    pub async fn subscribe(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
        after: &Cursor,
    ) -> HostResult<Subscription> {
        self.subscribe_target(actor, scope_id, after, None).await
    }
    pub(crate) async fn subscribe_for(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
        after: &Cursor,
        target: &Target,
    ) -> HostResult<Subscription> {
        self.subscribe_target(actor, scope_id, after, Some(target))
            .await
    }
    async fn subscribe_target(
        &self,
        actor: &AuthenticatedActor,
        scope_id: &Id,
        after: &Cursor,
        expected: Option<&Target>,
    ) -> HostResult<Subscription> {
        let scope = self.scope(scope_id)?;
        let target = lock(&scope.state)?.target.clone();
        verify_target(expected, &target)?;
        // 先订阅变更再读授权，不能漏掉 check 与等待之间发生的撤权。
        let changes = self.inner.auth.subscribe_changes();
        let stamp = check(&self.inner.auth, actor, &target, &scope.permission).await?;
        if after.host_id != self.inner.identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Cursor belongs to a different Host",
            ));
        }
        if after.instance_epoch != self.inner.identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Cursor belongs to a different instance",
            ));
        }
        if &after.scope_id != scope_id {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Cursor belongs to a different scope",
            ));
        }
        let subscription_id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let reader = {
            let mut current = lock(&scope.state)?;
            same_target(&current, &target)?;
            if after.position > current.revision {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Cursor is ahead of the current projection",
                ));
            }
            let oldest = oldest_cursor(&current, &self.cursor(scope_id, current.revision));
            if after.position < oldest.position {
                return Err(expired(scope_id, oldest));
            }
            let mut queue = VecDeque::new();
            let mut bytes = 0usize;
            for entry in current
                .history
                .iter()
                .filter(|entry| entry.delta.cursor.position > after.position)
            {
                bytes = bytes.checked_add(entry.bytes).ok_or_else(limit)?;
                if queue.len() >= self.inner.limits.queue_items
                    || bytes > self.inner.limits.queue_bytes
                {
                    return Err(expired(scope_id, oldest));
                }
                queue.push_back(entry.clone());
            }
            let reader = Arc::new(Reader {
                state: Mutex::new(ReaderState {
                    queue,
                    bytes,
                    terminal: None,
                    closed: false,
                }),
                notify: Notify::new(),
                delivery: watch::channel(true).0,
            });
            current
                .readers
                .insert(subscription_id.clone(), Arc::downgrade(&reader));
            reader
        };
        let subscription = Subscription {
            id: subscription_id,
            target: target.clone(),
            permission: scope.permission.clone(),
            actor: actor.clone(),
            auth: self.inner.auth.clone(),
            scope: Arc::downgrade(&scope),
            reader,
            changes,
            grant_stamp: stamp.clone(),
        };
        recheck(&self.inner.auth, actor, &target, &scope.permission, stamp).await?;
        same_target(&*lock(&scope.state)?, &target)?;
        Ok(subscription)
    }
    pub(crate) async fn list_scopes(
        &self,
        actor: &AuthenticatedActor,
    ) -> HostResult<StateScopesResult> {
        let scopes: Vec<_> = lock(&self.inner.scopes)?.values().cloned().collect();
        let mut visible = Vec::new();
        for scope in scopes {
            let target = lock(&scope.state)?.target.clone();
            let stamp = match check(&self.inner.auth, actor, &target, &scope.permission).await {
                Ok(stamp) => stamp,
                Err(error) if error.code == "PERMISSION_DENIED" => continue,
                Err(error) => return Err(error),
            };
            visible.push((scope, target, stamp));
        }
        let mut refs = Vec::new();
        for (scope, target, stamp) in visible {
            match recheck(&self.inner.auth, actor, &target, &scope.permission, stamp).await {
                Ok(()) => {}
                Err(error) if error.code == "PERMISSION_DENIED" => continue,
                Err(error) => return Err(error),
            }
            same_target(&*lock(&scope.state)?, &target)?;
            refs.push(StateScopeRef {
                scope_id: scope.id.clone(),
                target,
            });
        }
        Ok(StateScopesResult { scopes: refs })
    }
    /// 持有对应文档协调锁时，在 Store CAS 之前预检发布预算与计数。
    pub(crate) fn preflight_document(
        &self,
        scope_id: &Id,
        event_type: Id,
        state: &JsonObject,
    ) -> HostResult<()> {
        let scope = self.scope(scope_id)?;
        let current = lock(&scope.state)?;
        let next = current.revision.checked_next()?;
        let delta = Delta {
            cursor: self.cursor(scope_id, next),
            previous_cursor: self.cursor(scope_id, current.revision),
            revision: next,
            event_type,
            payload: state.clone(),
        };
        encoded_length(state, self.inner.limits.history_bytes)?;
        encoded_length(
            &delta,
            self.inner
                .limits
                .history_bytes
                .min(self.inner.limits.queue_bytes),
        )?;
        Ok(())
    }
    /// 读取修复以持久文档为准，投影不是第二份状态来源。
    pub(crate) fn synchronize_document(
        &self,
        reference: &StateScopeRef,
        event_type: Id,
        state: JsonObject,
    ) -> HostResult<()> {
        match self.scope(&reference.scope_id) {
            Ok(scope) => {
                let current = lock(&scope.state)?;
                verify_target(Some(&reference.target), &current.target)?;
                if current.value == state {
                    return Ok(());
                }
                drop(current);
                self.commit(&reference.scope_id, event_type, state.clone(), state)?;
                Ok(())
            }
            Err(error) if error.code == "NOT_FOUND" => self.register_scope(
                reference.scope_id.clone(),
                reference.target.clone(),
                "metadata.read".into(),
                state,
            ),
            Err(error) => Err(error),
        }
    }
    pub fn reader_count(&self) -> usize {
        let Ok(scopes) = self.inner.scopes.lock() else {
            return 0;
        };
        scopes
            .values()
            .filter_map(|scope| scope.state.lock().ok())
            .map(|scope| scope.readers.len())
            .sum()
    }
    fn scope(&self, id: &Id) -> HostResult<Arc<Scope>> {
        lock(&self.inner.scopes)?
            .get(id)
            .cloned()
            .ok_or_else(|| HostError::new("NOT_FOUND", "Projection scope is not registered"))
    }
    fn cursor(&self, scope_id: &Id, position: U64) -> Cursor {
        Cursor {
            host_id: self.inner.identity.host_id.clone(),
            instance_epoch: self.inner.identity.instance_epoch,
            scope_id: scope_id.clone(),
            position,
        }
    }
}

pub struct Subscription {
    id: Id,
    target: Target,
    permission: String,
    actor: AuthenticatedActor,
    auth: AuthService,
    scope: Weak<Scope>,
    reader: Arc<Reader>,
    changes: watch::Receiver<U64>,
    grant_stamp: Option<GrantStamp>,
}
impl Subscription {
    pub fn id(&self) -> &Id {
        &self.id
    }
    pub fn target(&self) -> &Target {
        &self.target
    }
    pub fn permission(&self) -> &str {
        &self.permission
    }
    pub(crate) fn grant_stamp(&self) -> Option<GrantStamp> {
        self.grant_stamp.clone()
    }
    pub(crate) fn delivery_liveness(&self) -> watch::Receiver<bool> {
        self.reader.delivery.subscribe()
    }
    /// 取消等待不消费队列头；正文只在最终授权复核之后移出队列。
    pub async fn next(&mut self) -> HostResult<Option<Delta>> {
        loop {
            if let Some(result) = self.ended()? {
                return result;
            }
            let Some(_scope) = self.scope.upgrade() else {
                self.close();
                return Ok(None);
            };
            self.changes.borrow_and_update();
            // 授权变更的 watch 可合并；始终验证创建代次，不能用重授权复活旧队列。
            if let Err(error) = recheck(
                &self.auth,
                &self.actor,
                &self.target,
                &self.permission,
                self.grant_stamp(),
            )
            .await
            {
                return self.fail(error);
            }
            let notified = self.reader.notify.notified();
            let candidate = lock(&self.reader.state)?.queue.front().cloned();
            if candidate.is_some() {
                if let Err(error) = recheck(
                    &self.auth,
                    &self.actor,
                    &self.target,
                    &self.permission,
                    self.grant_stamp(),
                )
                .await
                {
                    return self.fail(error);
                }
                if let Some(result) = self.ended()? {
                    return result;
                }
                let mut pending = lock(&self.reader.state)?;
                if let Some(entry) = pending.queue.pop_front() {
                    pending.bytes -= entry.bytes;
                    return Ok(Some(entry.delta.clone()));
                }
                continue;
            }
            if let Some(result) = self.ended()? {
                return result;
            }
            tokio::select! {
                _ = notified => {},
                changed = self.changes.changed() => {
                    if changed.is_err() { return self.fail(HostError::new("STORAGE_UNAVAILABLE", "Authorization notifications are unavailable")); }
                },
                _ = self.auth.wait_grant_expiry(self.grant_stamp.as_ref()) => {},
            }
        }
    }
    pub fn close(&mut self) {
        if let Ok(mut pending) = self.reader.state.lock() {
            pending.end(None, &self.reader.delivery);
        }
        self.detach();
        self.reader.notify.notify_one();
    }
    fn detach(&self) {
        if let Some(scope) = self.scope.upgrade()
            && let Ok(mut current) = scope.state.lock()
        {
            current.readers.remove(&self.id);
        }
    }
    fn ended(&self) -> HostResult<Option<HostResult<Option<Delta>>>> {
        let mut pending = lock(&self.reader.state)?;
        if let Some(error) = pending.terminal.take() {
            return Ok(Some(Err(error)));
        }
        Ok(pending.closed.then_some(Ok(None)))
    }
    fn fail(&self, error: HostError) -> HostResult<Option<Delta>> {
        lock(&self.reader.state)?.end(None, &self.reader.delivery);
        self.detach();
        Err(error)
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.close();
    }
}

fn is_document_scope(id: &Id) -> bool {
    id.as_str() == "settings:shared" || id.as_str().starts_with("workspace:")
}
fn verify_target(expected: Option<&Target>, actual: &Target) -> HostResult<()> {
    if let Some(expected) = expected
        && expected != actual
    {
        if expected.kind == actual.kind
            && expected.id == actual.id
            && expected.session_epoch != actual.session_epoch
        {
            return Err(epoch_changed());
        }
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Scope target does not match its registered resource",
        ));
    }
    Ok(())
}
async fn check(
    auth: &AuthService,
    actor: &AuthenticatedActor,
    target: &Target,
    permission: &str,
) -> HostResult<Option<GrantStamp>> {
    let auth = auth.clone();
    let actor = actor.clone();
    let target = target.clone();
    let permission = permission.to_owned();
    tokio::task::spawn_blocking(move || {
        let stamp = auth.capture_grants(&actor)?;
        auth.require(&actor, &permission, &target)?;
        if let Some(stamp) = &stamp {
            auth.validate_grants(stamp)?;
        }
        Ok(stamp)
    })
    .await
    .map_err(|_| unavailable())?
}
async fn recheck(
    auth: &AuthService,
    actor: &AuthenticatedActor,
    target: &Target,
    permission: &str,
    stamp: Option<GrantStamp>,
) -> HostResult<()> {
    let auth = auth.clone();
    let actor = actor.clone();
    let target = target.clone();
    let permission = permission.to_owned();
    tokio::task::spawn_blocking(move || {
        if let Some(stamp) = &stamp {
            auth.validate_grants(stamp)?;
        }
        auth.require(&actor, &permission, &target)?;
        if let Some(stamp) = &stamp {
            auth.validate_grants(stamp)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| unavailable())?
}
fn oldest_cursor(current: &ScopeState, fallback: &Cursor) -> Cursor {
    current.history.front().map_or_else(
        || fallback.clone(),
        |entry| entry.delta.previous_cursor.clone(),
    )
}
fn same_target(current: &ScopeState, target: &Target) -> HostResult<()> {
    if &current.target == target {
        Ok(())
    } else {
        Err(epoch_changed())
    }
}
fn epoch_changed() -> HostError {
    HostError::new(
        "EPOCH_MISMATCH",
        "Session projection changed epoch; a new snapshot is required",
    )
}
fn expired(scope: &Id, oldest: Cursor) -> HostError {
    let mut error = HostError::new("CURSOR_EXPIRED", "A new projection snapshot is required");
    error.details = Some(Box::new(
        [
            ("scopeId".into(), JsonValue::String(scope.to_string())),
            (
                "oldestCursor".into(),
                JsonValue::Object(
                    [
                        (
                            "hostId".into(),
                            JsonValue::String(oldest.host_id.to_string()),
                        ),
                        (
                            "instanceEpoch".into(),
                            JsonValue::String(oldest.instance_epoch.to_string()),
                        ),
                        (
                            "scopeId".into(),
                            JsonValue::String(oldest.scope_id.to_string()),
                        ),
                        (
                            "position".into(),
                            JsonValue::String(oldest.position.to_string()),
                        ),
                    ]
                    .into(),
                ),
            ),
            ("snapshotRequired".into(), JsonValue::Bool(true)),
        ]
        .into(),
    ));
    error
}
fn digits(value: U64) -> usize {
    value
        .get()
        .checked_ilog10()
        .map_or(1, |width| width as usize + 1)
}
fn lock<T>(mutex: &Mutex<T>) -> HostResult<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| unavailable())
}
fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Projection byte capacity exceeded")
}
fn unavailable() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Projection state is unavailable")
}
struct ByteCounter {
    bytes: usize,
    limit: usize,
}
impl Write for ByteCounter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let total = self
            .bytes
            .checked_add(buffer.len())
            .filter(|total| *total <= self.limit)
            .ok_or_else(|| io::Error::other("Projection byte capacity exceeded"))?;
        self.bytes = total;
        Ok(buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encoded_length(value: &impl Serialize, limit_bytes: usize) -> HostResult<usize> {
    let mut counter = ByteCounter {
        bytes: 0,
        limit: limit_bytes,
    };
    serde_json::to_writer(&mut counter, value).map_err(|_| limit())?;
    Ok(counter.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Store;
    use std::time::Duration;
    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }
    fn delivery_fixture() -> (
        tempfile::TempDir,
        ProjectionStore,
        AuthService,
        AuthenticatedActor,
        Target,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let auth = AuthService::new(
            store,
            ContextToken::try_from("delivery-user-control").unwrap(),
        );
        let actor = auth
            .authenticate(&id("delivery-reader"), None)
            .unwrap()
            .actor;
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: id("delivery-session"),
            session_id: Some(id("delivery-session")),
            session_epoch: Some(1.into()),
        };
        let projections = ProjectionStore::new(
            identity,
            auth.clone(),
            ProjectionLimits {
                queue_items: 1,
                ..ProjectionLimits::default()
            },
        );
        projections
            .register_scope(
                id("session:delivery-session"),
                target.clone(),
                "metadata.read".into(),
                JsonObject::new(),
            )
            .unwrap();
        (directory, projections, auth, actor, target)
    }
    #[tokio::test]
    async fn delivery_liveness_rebind_invalidates_old_guard_before_next_and_new_reader_is_live() {
        let (_directory, projections, _auth, actor, mut target) = delivery_fixture();
        let scope = id("session:delivery-session");
        let cursor = projections.snapshot(&actor, &scope).await.unwrap().cursor;
        let mut old = projections
            .subscribe(&actor, &scope, &cursor)
            .await
            .unwrap();
        let old_guard = old.delivery_liveness();
        assert!(*old_guard.borrow());
        target.session_epoch = Some(2.into());
        projections
            .commit_for_target(
                &scope,
                target,
                id("session.opened"),
                JsonObject::new(),
                JsonObject::new(),
            )
            .unwrap();
        assert!(!*old_guard.borrow());
        assert_eq!(old.next().await.unwrap_err().code, "EPOCH_MISMATCH");
        let cursor = projections.snapshot(&actor, &scope).await.unwrap().cursor;
        let fresh = projections
            .subscribe(&actor, &scope, &cursor)
            .await
            .unwrap();
        let fresh_guard = fresh.delivery_liveness();
        assert!(*fresh_guard.borrow());
        assert!(!*old_guard.borrow());
        drop(fresh);
        assert!(!*fresh_guard.borrow());
    }
    #[tokio::test]
    async fn delivery_liveness_is_sticky_false_on_close_drop_overflow_and_authorization_failure() {
        for reason in ["close", "drop", "overflow", "revoke"] {
            let (_directory, projections, auth, actor, target) = delivery_fixture();
            let scope = id("session:delivery-session");
            let cursor = projections.snapshot(&actor, &scope).await.unwrap().cursor;
            let mut reader = projections
                .subscribe(&actor, &scope, &cursor)
                .await
                .unwrap();
            let guard = reader.delivery_liveness();
            assert!(*guard.borrow());
            match reason {
                "close" => reader.close(),
                "drop" => {
                    drop(reader);
                    assert!(!*guard.borrow());
                    continue;
                }
                "overflow" => {
                    for _ in 0..2 {
                        projections
                            .commit(
                                &scope,
                                id("session.changed"),
                                JsonObject::new(),
                                JsonObject::new(),
                            )
                            .unwrap();
                    }
                    assert!(!*guard.borrow());
                    assert_eq!(reader.next().await.unwrap_err().code, "CURSOR_EXPIRED");
                }
                _ => {
                    let control = auth
                        .authenticate_user_control(
                            &id("delivery-control"),
                            &ContextToken::try_from("delivery-user-control").unwrap(),
                        )
                        .unwrap();
                    auth.revoke(
                        &control,
                        RevokeParams {
                            actor_id: actor.id().clone(),
                            permissions: vec!["metadata.read".into()],
                            targets: vec![target],
                        },
                    )
                    .unwrap();
                    assert_eq!(reader.next().await.unwrap_err().code, "PERMISSION_DENIED");
                }
            }
            assert!(!*guard.borrow());
            assert!(reader.next().await.unwrap().is_none());
            assert!(!*guard.borrow());
        }
    }
    #[test]
    fn exhausted_commit_preserves_revision_and_rejects_wraparound() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let auth = AuthService::new(store, ContextToken::try_from("projection-secret").unwrap());
        let projections = ProjectionStore::new(identity, auth, ProjectionLimits::default());
        projections
            .register_scope(
                id("host.devices"),
                target,
                "metadata.read".into(),
                JsonObject::new(),
            )
            .unwrap();
        let scope = projections.inner.scopes.lock().unwrap()[&id("host.devices")].clone();
        scope.state.lock().unwrap().revision = u64::MAX.into();
        let error = projections
            .commit(
                &id("host.devices"),
                id("devices.changed"),
                JsonObject::new(),
                JsonObject::new(),
            )
            .unwrap_err();
        assert_eq!(error.code, "COUNTER_EXHAUSTED");
        let state = scope.state.lock().unwrap();
        assert_eq!(state.revision.get(), u64::MAX);
        assert!(state.value.is_empty());
        assert!(state.history.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn idle_grant_wait_tracks_clock_jump_without_repeating_authorization_queries() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        struct JumpClock {
            runtime: std::thread::ThreadId,
            now: AtomicU64,
            worker_reads: AtomicU64,
            armed: AtomicBool,
            sampled: Notify,
        }
        impl Clock for JumpClock {
            fn mono_ns(&self) -> u64 {
                if std::thread::current().id() == self.runtime && self.armed.load(Ordering::SeqCst)
                {
                    self.sampled.notify_one();
                } else {
                    self.worker_reads.fetch_add(1, Ordering::SeqCst);
                }
                self.now.load(Ordering::SeqCst)
            }
            fn wall_time(&self) -> Timestamp {
                Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
            }
        }
        let clock = Arc::new(JumpClock {
            runtime: std::thread::current().id(),
            now: AtomicU64::new(0),
            worker_reads: AtomicU64::new(0),
            armed: AtomicBool::new(false),
            sampled: Notify::new(),
        });
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("clock-jump-user-control").unwrap();
        let auth = AuthService::with_clock(store, secret.clone(), clock.clone());
        let actor = auth
            .authenticate(&id("clock-jump-reader"), None)
            .unwrap()
            .actor;
        let control = auth
            .authenticate_user_control(&id("clock-jump-control"), &secret)
            .unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
                expires_at: Some(Timestamp::try_from("2026-11-07T00:01:00Z").unwrap()),
            },
        )
        .unwrap();
        let projections = ProjectionStore::new(identity, auth, ProjectionLimits::default());
        let scope = id("host.devices");
        projections
            .register_scope(
                scope.clone(),
                target,
                "content.read".into(),
                JsonObject::new(),
            )
            .unwrap();
        let cursor = projections.snapshot(&actor, &scope).await.unwrap().cursor;
        let mut reader = projections
            .subscribe(&actor, &scope, &cursor)
            .await
            .unwrap();
        clock.armed.store(true, Ordering::SeqCst);
        let mut task = tokio::spawn(async move { reader.next().await });
        tokio::time::timeout(Duration::from_secs(1), clock.sampled.notified())
            .await
            .unwrap();
        let worker_reads = clock.worker_reads.load(Ordering::SeqCst);
        // 等待中间 tick 的实际采样；每 tick 若重返外层 recheck 会增加 worker_reads。
        for _ in 0..3 {
            if tokio::time::timeout(Duration::from_millis(500), clock.sampled.notified())
                .await
                .is_err()
            {
                task.abort();
                panic!("long runtime sleep ignored native clock updates");
            }
            assert_eq!(clock.worker_reads.load(Ordering::SeqCst), worker_reads);
            assert!(!task.is_finished());
        }
        // 无 delta、无授权写入或 watch 通知；只推进注入的单调时间。
        clock.now.store(60_000_000_000, Ordering::SeqCst);
        let completed = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
        if completed.is_err() {
            task.abort();
        }
        assert_eq!(
            completed.unwrap().unwrap().unwrap_err().code,
            "PERMISSION_DENIED"
        );
        assert_eq!(projections.reader_count(), 0);
    }
}
