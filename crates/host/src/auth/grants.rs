use super::{AuthenticatedActor, HostIdentity};
use crate::storage::{DocumentRead, Store};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use serial_workbench_ipc::identity::{credential_verifier, random_token, verify_credential};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

type GrantSnapshot = (U64, Arc<GrantDocument>);

pub struct Authentication {
    pub actor: AuthenticatedActor,
    pub issued_credential: Option<ContextToken>,
}
#[derive(Clone)]
pub(crate) struct GrantStamp {
    client_id: Id,
    actor_id: Id,
    revision: U64,
    deadline_ns: Option<u64>,
}
#[derive(Clone)]
pub struct AuthService {
    store: Store,
    control_verifier: ContextToken,
    serial: Arc<Mutex<()>>,
    clock: Arc<dyn Clock>,
    changes: tokio::sync::watch::Sender<U64>,
    cached: Arc<Mutex<Option<GrantSnapshot>>>,
    #[cfg(test)]
    document_reads: Arc<std::sync::atomic::AtomicUsize>,
}
/// 单次同步验权视图；后续交付或写入必须重新载入当前授权。
pub(crate) struct AuthorizationSnapshot {
    identity: HostIdentity,
    actor: AuthenticatedActor,
    grants: Option<ClientGrants>,
    clock: Arc<dyn Clock>,
}
struct ClientGrants {
    document: Arc<GrantDocument>,
    client_id: Id,
}
impl ClientGrants {
    fn record(&self) -> &ClientRecord {
        self.document
            .clients
            .get(&self.client_id)
            .expect("validated client record")
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantDocument {
    format_version: U64,
    clients: BTreeMap<Id, ClientRecord>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientRecord {
    actor_id: Id,
    grant_revision: U64,
    verifier: ContextToken,
    rules: Vec<Rule>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rule {
    permission: String,
    target: Target,
    allowed: bool,
    expires_at: Option<Timestamp>,
    epoch: Option<U64>,
    deadline_ns: Option<U64>,
}
const PERMISSIONS: &[&str] = &[
    "client.window.modify",
    "client.clipboard.read",
    "client.clipboard.write",
    "client.system.modify",
    "metadata.read",
    "content.read",
    "device.modify",
    "code.execute",
    "plugins.manage",
    "workspace.modify",
    "settings.modify",
];
// 会话代次及历史结果需要保留精确授权；容量不能只够数十次连接。
const MAX_CLIENT_RULES: usize = 4096;
const MAX_TOTAL_RULES: usize = 32768;
impl AuthService {
    pub fn new(store: Store, control: ContextToken) -> Self {
        Self::with_clock(
            store,
            control,
            Arc::new(crate::clock::SystemClock::default()),
        )
    }
    pub fn with_clock(store: Store, control: ContextToken, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            control_verifier: credential_verifier(&control),
            serial: Arc::new(Mutex::new(())),
            clock,
            changes: tokio::sync::watch::channel(U64::from(0)).0,
            cached: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            document_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
    fn load(&self) -> HostResult<GrantSnapshot> {
        #[cfg(test)]
        self.document_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut cached = self.cached.lock().map_err(|_| corrupt())?;
        let document = match self.store.read_document_if_changed(
            &document_id(),
            cached.as_ref().map(|(revision, _)| *revision),
        )? {
            DocumentRead::Unchanged => return cached.clone().ok_or_else(corrupt),
            DocumentRead::Missing => {
                let empty = Arc::new(GrantDocument {
                    format_version: 1.into(),
                    clients: BTreeMap::new(),
                });
                *cached = Some((0.into(), empty.clone()));
                return Ok((0.into(), empty));
            }
            DocumentRead::Changed(document) => document,
        };
        let data: GrantDocument =
            serde_json::from_value(serde_json::to_value(document.value).map_err(|_| corrupt())?)
                .map_err(|_| corrupt())?;
        if data.format_version != 1.into() {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "Unsupported authorization format",
            ));
        }
        let data = Arc::new(data);
        *cached = Some((document.revision, data.clone()));
        Ok((document.revision, data))
    }
    fn save(&self, revision: U64, document: GrantDocument) -> HostResult<U64> {
        let count = document
            .clients
            .values()
            .map(|record| record.rules.len())
            .sum::<usize>();
        if count > MAX_TOTAL_RULES {
            let cached = self.cached.lock().map_err(|_| corrupt())?;
            let previous =
                cached
                    .as_ref()
                    .filter(|(known, _)| *known == revision)
                    .map(|(_, document)| {
                        document
                            .clients
                            .values()
                            .map(|record| record.rules.len())
                            .sum::<usize>()
                    });
            // 已存在的大存档仍可撤权；容量限制只禁止继续增长。
            if previous.is_none_or(|previous| count > previous) {
                return Err(limit());
            }
        }
        let value = serde_json::from_value(serde_json::to_value(document).map_err(|_| corrupt())?)
            .map_err(|_| corrupt())?;
        Ok(self
            .store
            .compare_and_swap_document(&document_id(), revision, value)?
            .revision)
    }
    pub fn authenticate(
        &self,
        client_id: &Id,
        credential: Option<&ContextToken>,
    ) -> HostResult<Authentication> {
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        let (revision, document) = self.load()?;
        if let Some(record) = document.clients.get(client_id) {
            if !credential.is_some_and(|credential| verify_credential(&record.verifier, credential))
            {
                return Err(unauthenticated());
            }
            return Ok(Authentication {
                actor: AuthenticatedActor::from_verified(
                    record.actor_id.clone(),
                    client_id.clone(),
                    record.grant_revision,
                    false,
                ),
                issued_credential: None,
            });
        }
        // 提供未知凭据不触发注册，避免错误身份悄悄变成新 actor。
        if credential.is_some() {
            return Err(unauthenticated());
        }
        if document.clients.len() >= 1024 {
            return Err(limit());
        }
        let mut document = (*document).clone();
        let identity = self.store.identity()?;
        let credential = random_token();
        let actor_id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        document.clients.insert(
            client_id.clone(),
            ClientRecord {
                actor_id: actor_id.clone(),
                grant_revision: 1.into(),
                verifier: credential_verifier(&credential),
                rules: vec![Rule {
                    permission: "metadata.read".into(),
                    target: host_target(identity.host_id),
                    allowed: true,
                    expires_at: None,
                    epoch: None,
                    deadline_ns: None,
                }],
            },
        );
        self.save(revision, document)?;
        Ok(Authentication {
            actor: AuthenticatedActor::from_verified(actor_id, client_id.clone(), 1.into(), false),
            issued_credential: Some(credential),
        })
    }
    pub fn authenticate_user_control(
        &self,
        client_id: &Id,
        credential: &ContextToken,
    ) -> HostResult<AuthenticatedActor> {
        if !verify_credential(&self.control_verifier, credential) {
            return Err(unauthenticated());
        }
        Ok(AuthenticatedActor::from_verified(
            self.operator_id()?,
            client_id.clone(),
            self.current_revision()?,
            true,
        ))
    }
    fn operator_id(&self) -> HostResult<Id> {
        self.operator_id_for(&self.store.identity()?.host_id)
    }
    fn operator_id_for(&self, host_id: &Id) -> HostResult<Id> {
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(
            format!("{}:{}", host_id, self.control_verifier.as_str()).as_bytes(),
        );
        let mut bytes: [u8; 16] = digest[..16].try_into().expect("digest prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Id::try_from(uuid::Uuid::from_bytes(bytes).to_string().as_str())
    }
    fn require_control(&self, actor: &AuthenticatedActor) -> HostResult<()> {
        if actor.is_user_control() && actor.id() == &self.operator_id()? {
            Ok(())
        } else {
            Err(denied())
        }
    }
    pub fn current_revision(&self) -> HostResult<U64> {
        self.load().map(|(revision, _)| revision)
    }
    /// 通知只负责唤醒；调用方仍从持久授权重新检查。
    pub fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<U64> {
        self.changes.subscribe()
    }
    pub(crate) fn snapshot(&self, actor: &AuthenticatedActor) -> HostResult<AuthorizationSnapshot> {
        let identity = self.store.identity()?;
        self.snapshot_with_identity(actor, identity)
    }
    fn snapshot_with_identity(
        &self,
        actor: &AuthenticatedActor,
        identity: HostIdentity,
    ) -> HostResult<AuthorizationSnapshot> {
        let grants = if actor.is_user_control() {
            if actor.id() != &self.operator_id_for(&identity.host_id)? {
                return Err(denied());
            }
            None
        } else {
            let (_, document) = self.load()?;
            document
                .clients
                .get(actor.client_id())
                .filter(|record| &record.actor_id == actor.id())
                .ok_or_else(denied)?;
            Some(ClientGrants {
                client_id: actor.client_id().clone(),
                document,
            })
        };
        Ok(AuthorizationSnapshot {
            identity,
            actor: actor.clone(),
            grants,
            clock: self.clock.clone(),
        })
    }
    #[cfg(test)]
    pub(crate) fn document_reads(&self) -> usize {
        self.document_reads
            .load(std::sync::atomic::Ordering::Relaxed)
    }
    /// 仅判断动作能力是否可发现，不公开授权范围或资源是否存在。
    pub fn can_discover(
        &self,
        actor: &AuthenticatedActor,
        permission: &str,
        target_kinds: &[ResourceKind],
    ) -> HostResult<bool> {
        Ok(self.snapshot(actor)?.can_discover(permission, target_kinds))
    }
    /// 持有创建时的期限快照；中间唤醒只读 Clock，不重新查询授权或存储。
    pub(crate) async fn wait_grant_expiry(&self, stamp: Option<&GrantStamp>) {
        match stamp.and_then(|stamp| stamp.deadline_ns) {
            Some(deadline) => crate::clock::wait_until(self.clock.as_ref(), deadline).await,
            None => std::future::pending().await,
        }
    }
    pub fn grant_revision(&self, actor: &AuthenticatedActor) -> HostResult<U64> {
        Ok(self.snapshot(actor)?.grant_revision())
    }
    pub(crate) fn capture_grants(
        &self,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<GrantStamp>> {
        Ok(self.snapshot(actor)?.capture_grants())
    }
    pub(crate) fn validate_grants(&self, stamp: &GrantStamp) -> HostResult<()> {
        let (_, document) = self.load()?;
        let unchanged = document
            .clients
            .get(&stamp.client_id)
            .is_some_and(|record| {
                record.actor_id == stamp.actor_id && record.grant_revision == stamp.revision
            });
        if !unchanged
            || stamp
                .deadline_ns
                .is_some_and(|deadline| self.clock.mono_ns() >= deadline)
        {
            Err(denied())
        } else {
            Ok(())
        }
    }
    pub fn require(
        &self,
        actor: &AuthenticatedActor,
        permission: &str,
        target: &Target,
    ) -> HostResult<()> {
        target.validate()?;
        let identity = self.store.identity()?;
        verify_host(&identity, target)?;
        self.snapshot_with_identity(actor, identity)?
            .require(permission, target)
    }
    pub fn authorize(
        &self,
        actor: &AuthenticatedActor,
        params: AuthorizeParams,
    ) -> HostResult<U64> {
        self.require_control(actor)?;
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        self.validate_scopes(&params.permissions, &params.targets)?;
        let deadline = params
            .expires_at
            .as_ref()
            .map(|expires| {
                let now = chrono::DateTime::parse_from_rfc3339(self.clock.wall_time().as_str())
                    .map_err(|_| corrupt())?;
                let end = chrono::DateTime::parse_from_rfc3339(expires.as_str())
                    .map_err(|_| invalid())?;
                let nanos = (end - now)
                    .num_nanoseconds()
                    .filter(|value| *value > 0)
                    .ok_or_else(invalid)? as u64;
                self.clock
                    .mono_ns()
                    .checked_add(nanos)
                    .map(U64::from)
                    .ok_or_else(|| {
                        HostError::new("COUNTER_EXHAUSTED", "Authorization deadline overflow")
                    })
            })
            .transpose()?;
        let epoch = deadline
            .map(|_| {
                self.store
                    .identity()
                    .map(|identity| identity.instance_epoch)
            })
            .transpose()?;
        let (revision, document) = self.load()?;
        let mut document = (*document).clone();
        let record = document
            .clients
            .get_mut(&params.client_id)
            .ok_or_else(denied)?;
        let mut changed = false;
        for permission in params.permissions {
            for target in &params.targets {
                changed |= set_rule(
                    record,
                    Rule {
                        permission: permission.clone(),
                        target: target.clone(),
                        allowed: true,
                        expires_at: params.expires_at.clone(),
                        epoch,
                        deadline_ns: deadline,
                    },
                )?;
            }
        }
        if !changed {
            return Ok(record.grant_revision);
        }
        record.grant_revision = record.grant_revision.checked_next()?;
        let grant_revision = record.grant_revision;
        let committed = self.save(revision, document)?;
        self.changes.send_replace(committed);
        Ok(grant_revision)
    }
    pub fn revoke(&self, actor: &AuthenticatedActor, params: RevokeParams) -> HostResult<U64> {
        self.require_control(actor)?;
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        self.validate_scopes(&params.permissions, &params.targets)?;
        let (revision, document) = self.load()?;
        let mut document = (*document).clone();
        let record = document
            .clients
            .values_mut()
            .find(|record| record.actor_id == params.actor_id)
            .ok_or_else(denied)?;
        let mut changed = false;
        for permission in params.permissions {
            for target in &params.targets {
                changed |= set_rule(
                    record,
                    Rule {
                        permission: permission.clone(),
                        target: target.clone(),
                        allowed: false,
                        expires_at: None,
                        epoch: None,
                        deadline_ns: None,
                    },
                )?;
            }
        }
        if !changed {
            return Ok(record.grant_revision);
        }
        record.grant_revision = record.grant_revision.checked_next()?;
        let grant_revision = record.grant_revision;
        let committed = self.save(revision, document)?;
        self.changes.send_replace(committed);
        Ok(grant_revision)
    }
    fn validate_scopes(&self, permissions: &[String], targets: &[Target]) -> HostResult<()> {
        if permissions.is_empty()
            || permissions.len() > PERMISSIONS.len()
            || targets.is_empty()
            || targets.len() > 64
            || permissions
                .iter()
                .any(|p| !PERMISSIONS.contains(&p.as_str()))
        {
            return Err(invalid());
        }
        let identity = self.store.identity()?;
        for target in targets {
            target.validate()?;
            if target.host_id != identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Authorization scope belongs to another Host",
                ));
            }
        }
        Ok(())
    }
}
impl AuthorizationSnapshot {
    pub(crate) fn grant_revision(&self) -> U64 {
        self.grants
            .as_ref()
            .map_or(0.into(), |grants| grants.record().grant_revision)
    }
    pub(crate) fn capture_grants(&self) -> Option<GrantStamp> {
        let grants = self.grants.as_ref()?;
        let now = self.clock.mono_ns();
        let deadline_ns = grants
            .record()
            .rules
            .iter()
            .filter(|rule| rule.allowed && rule.epoch == Some(self.identity.instance_epoch))
            .filter_map(|rule| rule.deadline_ns.map(U64::get))
            .filter(|deadline| *deadline > now)
            .min();
        Some(GrantStamp {
            client_id: self.actor.client_id().clone(),
            actor_id: self.actor.id().clone(),
            revision: grants.record().grant_revision,
            deadline_ns,
        })
    }
    pub(crate) fn validate_grants(&self, stamp: &GrantStamp) -> HostResult<()> {
        if self.actor.client_id() != &stamp.client_id
            || self.actor.id() != &stamp.actor_id
            || self.grant_revision() != stamp.revision
            || stamp
                .deadline_ns
                .is_some_and(|deadline| self.clock.mono_ns() >= deadline)
        {
            Err(denied())
        } else {
            Ok(())
        }
    }
    pub(crate) fn require(&self, permission: &str, target: &Target) -> HostResult<()> {
        target.validate()?;
        verify_host(&self.identity, target)?;
        let Some(grants) = &self.grants else {
            return if ["auth.manage", "metadata.read"].contains(&permission) {
                Ok(())
            } else {
                Err(denied())
            };
        };
        // 最新匹配规则生效；失效的窄规则仍遮蔽更旧的宽授权。
        for rule in grants.record().rules.iter().rev() {
            if rule.permission != permission || !scope_matches(&rule.target, target) {
                continue;
            }
            if let Some(deadline) = rule.deadline_ns
                && (rule.epoch != Some(self.identity.instance_epoch)
                    || self.clock.mono_ns() >= deadline.get())
            {
                return Err(denied());
            }
            return if rule.allowed { Ok(()) } else { Err(denied()) };
        }
        Err(denied())
    }
    pub(crate) fn can_discover(&self, permission: &str, target_kinds: &[ResourceKind]) -> bool {
        let Some(grants) = &self.grants else {
            return ["auth.manage", "metadata.read"].contains(&permission);
        };
        grants.record().rules.iter().any(|rule| {
            rule.permission == permission
                && rule.allowed
                && (rule.target.kind.as_str() == "host" || target_kinds.contains(&rule.target.kind))
                && self.require(permission, &rule.target).is_ok()
        })
    }
}
fn verify_host(identity: &HostIdentity, target: &Target) -> HostResult<()> {
    if target.host_id != identity.host_id {
        Err(HostError::new(
            "HOST_ID_MISMATCH",
            "Target belongs to a different Host",
        ))
    } else {
        Ok(())
    }
}
fn document_id() -> Id {
    Id::try_from("auth:grants").expect("static Id")
}
fn host_target(host_id: Id) -> Target {
    Target {
        id: host_id.clone(),
        host_id,
        kind: ResourceKind::try_from("host").expect("host kind"),
        session_id: None,
        session_epoch: None,
    }
}
fn scope_matches(scope: &Target, target: &Target) -> bool {
    scope.host_id == target.host_id && (scope.kind.as_str() == "host" || scope == target)
}
fn set_rule(record: &mut ClientRecord, rule: Rule) -> HostResult<bool> {
    if let Some(index) = record
        .rules
        .iter()
        .rposition(|old| old.permission == rule.permission && old.target == rule.target)
    {
        let shadowed = record.rules[index + 1..].iter().any(|later| {
            later.permission == rule.permission
                && later.target.host_id == rule.target.host_id
                && (later.target.kind.as_str() == "host"
                    || rule.target.kind.as_str() == "host"
                    || later.target == rule.target)
        });
        if record.rules[index] == rule && !shadowed {
            return Ok(false);
        }
    }
    record
        .rules
        .retain(|old| old.permission != rule.permission || old.target != rule.target);
    if record.rules.len() >= MAX_CLIENT_RULES {
        return Err(limit());
    }
    record.rules.push(rule);
    Ok(true)
}
fn unauthenticated() -> HostError {
    HostError::new("UNAUTHENTICATED", "Client credential is invalid")
}
fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Current authorization does not permit this operation",
    )
}
fn corrupt() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Authorization storage is unavailable",
    )
}
fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid authorization scope or expiry")
}
fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Authorization capacity exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }
    fn setup() -> (tempfile::TempDir, AuthService, Target) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: identity.host_id,
            session_id: None,
            session_epoch: None,
        };
        (
            directory,
            AuthService::new(
                store,
                ContextToken::try_from("independent-user-control-secret").unwrap(),
            ),
            target,
        )
    }
    #[test]
    fn unchanged_grants_reuse_authority_but_later_overlapping_rules_still_require_regrant() {
        let (_directory, auth, host) = setup();
        let client = auth.authenticate(&id("steady"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("COM3"),
            ..host.clone()
        };
        let params = AuthorizeParams {
            client_id: client.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![device.clone()],
            expires_at: None,
        };
        let revision = auth.authorize(&control, params.clone()).unwrap();
        let stamp = auth.capture_grants(&client).unwrap().unwrap();
        let before = auth.load().unwrap().1;
        assert_eq!(auth.authorize(&control, params.clone()).unwrap(), revision);
        assert!(Arc::ptr_eq(&before, &auth.load().unwrap().1));
        auth.validate_grants(&stamp).unwrap();
        auth.revoke(
            &control,
            RevokeParams {
                actor_id: client.id().clone(),
                permissions: params.permissions.clone(),
                targets: vec![host.clone()],
            },
        )
        .unwrap();
        assert!(auth.require(&client, "content.read", &device).is_err());
        assert!(auth.authorize(&control, params).unwrap() > revision);
        auth.require(&client, "content.read", &device).unwrap();
        assert!(auth.validate_grants(&stamp).is_err());
        // 重新授予宽范围必须覆盖更晚的窄撤权，不能错误地当作幂等。
        let broad = AuthorizeParams {
            client_id: client.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![host],
            expires_at: None,
        };
        auth.authorize(&control, broad.clone()).unwrap();
        auth.revoke(
            &control,
            RevokeParams {
                actor_id: client.id().clone(),
                permissions: broad.permissions.clone(),
                targets: vec![device.clone()],
            },
        )
        .unwrap();
        assert!(auth.require(&client, "content.read", &device).is_err());
        auth.authorize(&control, broad).unwrap();
        auth.require(&client, "content.read", &device).unwrap();
    }
    #[test]
    fn device_connection_can_add_exact_permissions_after_many_previous_sessions() {
        let (_directory, auth, target) = setup();
        let client = auth.authenticate(&id("desktop"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        for first in (0..254).step_by(64) {
            auth.authorize(
                &control,
                AuthorizeParams {
                    client_id: client.client_id().clone(),
                    permissions: vec!["metadata.read".into()],
                    targets: (first..(first + 64).min(254))
                        .map(|index| Target {
                            host_id: target.host_id.clone(),
                            kind: ResourceKind::try_from("device").unwrap(),
                            id: id(&format!("previous-{index}")),
                            session_id: None,
                            session_epoch: None,
                        })
                        .collect(),
                    expires_at: None,
                },
            )
            .unwrap();
        }
        let selected = Target {
            host_id: target.host_id,
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("selected-COM3"),
            session_id: None,
            session_epoch: None,
        };
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: client.client_id().clone(),
                permissions: vec!["metadata.read".into(), "device.modify".into()],
                targets: vec![selected.clone()],
                expires_at: None,
            },
        )
        .expect("A normal connection must not exhaust permission records after prior sessions");
        auth.require(&client, "device.modify", &selected).unwrap();
        let other = Target {
            id: id("unselected-COM5"),
            ..selected
        };
        assert_eq!(
            auth.require(&client, "device.modify", &other)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
    }
    #[test]
    fn new_client_is_metadata_only_and_credential_is_required_on_reconnect() {
        let (_directory, auth, target) = setup();
        let registered = auth.authenticate(&id("mcp-client"), None).unwrap();
        assert!(!registered.actor.is_user_control());
        auth.require(&registered.actor, "metadata.read", &target)
            .unwrap();
        assert_eq!(
            auth.require(&registered.actor, "content.read", &target)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        assert!(auth.authenticate(&id("mcp-client"), None).is_err());
        assert!(
            auth.authenticate(
                &id("mcp-client"),
                Some(&ContextToken::try_from("wrong").unwrap())
            )
            .is_err()
        );
        let again = auth
            .authenticate(&id("mcp-client"), registered.issued_credential.as_ref())
            .unwrap();
        assert_eq!(again.actor.id(), registered.actor.id());
    }
    #[test]
    fn revoke_rechecks_old_actor_and_reference_scope() {
        let (_directory, auth, target) = setup();
        let client = auth.authenticate(&id("desktop-claim"), None).unwrap().actor;
        let params = AuthorizeParams {
            client_id: client.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        };
        assert_eq!(
            auth.authorize(&client, params.clone()).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        let control = auth
            .authenticate_user_control(
                &id("explicit-cli"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let revision = auth.authorize(&control, params).unwrap();
        assert!(revision > client.grant_revision());
        auth.require(&client, "content.read", &target).unwrap();
        auth.revoke(
            &control,
            RevokeParams {
                actor_id: client.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
        assert_eq!(
            auth.require(&client, "content.read", &target)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
    }
    #[test]
    fn host_pin_or_wrong_credential_does_not_create_user_control() {
        let (_directory, auth, _) = setup();
        assert!(
            auth.authenticate_user_control(
                &id("forged"),
                &ContextToken::try_from("host-pin-is-not-admin").unwrap()
            )
            .is_err()
        );
    }
    #[test]
    fn foreign_host_and_expired_grant_are_denied() {
        let (_directory, auth, target) = setup();
        let client = auth.authenticate(&id("reader"), None).unwrap().actor;
        let mut foreign = target.clone();
        foreign.host_id = id("other-host");
        foreign.id = id("other-host");
        assert!(auth.require(&client, "metadata.read", &foreign).is_err());
        let control = auth
            .authenticate_user_control(
                &id("explicit-cli"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let result = auth.authorize(
            &control,
            AuthorizeParams {
                client_id: client.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
                expires_at: Some(Timestamp::try_from("2000-01-01T00:00:00Z").unwrap()),
            },
        );
        assert!(result.is_err());
        assert_eq!(
            auth.require(&client, "content.read", &target)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
    }
    struct ManualClock(std::sync::atomic::AtomicU64);
    impl Clock for ManualClock {
        fn mono_ns(&self) -> u64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2000-01-01T00:00:00Z").unwrap()
        }
    }
    #[test]
    fn one_phase_reads_once_but_new_phases_recheck_revocation_and_regrant() {
        let (_directory, auth, target) = setup();
        let client = auth.authenticate(&id("phase-reader"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let params = AuthorizeParams {
            client_id: client.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        };
        auth.authorize(&control, params.clone()).unwrap();
        let before = auth.document_reads();
        let stamp = {
            let phase = auth.snapshot(&client).unwrap();
            let stamp = phase.capture_grants().unwrap();
            phase.require("content.read", &target).unwrap();
            phase.validate_grants(&stamp).unwrap();
            assert!(phase.can_discover("content.read", &[]));
            assert_eq!(auth.document_reads() - before, 1);
            stamp
        };
        auth.revoke(
            &control,
            RevokeParams {
                actor_id: client.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
        let revoked = auth.snapshot(&client).unwrap();
        assert!(revoked.validate_grants(&stamp).is_err());
        assert!(revoked.require("content.read", &target).is_err());
        drop(revoked);
        auth.authorize(&control, params).unwrap();
        let regranted = auth.snapshot(&client).unwrap();
        regranted.require("content.read", &target).unwrap();
        assert!(regranted.validate_grants(&stamp).is_err());
    }
    #[test]
    fn snapshot_rechecks_clock_and_keeps_expired_narrow_rule_shadowing() {
        let (_directory, initial, host) = setup();
        let clock = Arc::new(ManualClock(std::sync::atomic::AtomicU64::new(0)));
        let auth = AuthService::with_clock(
            initial.store.clone(),
            ContextToken::try_from("independent-user-control-secret").unwrap(),
            clock.clone(),
        );
        let (client, resource, other) = temporary_resource_regrant(&auth, &host);
        let before = auth.document_reads();
        let phase = auth.snapshot(&client).unwrap();
        let stamp = phase.capture_grants().unwrap();
        phase.require("content.read", &resource).unwrap();
        clock
            .0
            .store(10_000_000_000, std::sync::atomic::Ordering::SeqCst);
        assert!(phase.require("content.read", &resource).is_err());
        assert!(phase.validate_grants(&stamp).is_err());
        phase.require("content.read", &other).unwrap();
        assert_eq!(auth.document_reads() - before, 1);
    }
    #[test]
    fn expired_resource_regrant_still_masks_permanent_host_grant() {
        let (_directory, initial, host) = setup();
        let clock = Arc::new(ManualClock(std::sync::atomic::AtomicU64::new(0)));
        let auth = AuthService::with_clock(
            initial.store.clone(),
            ContextToken::try_from("independent-user-control-secret").unwrap(),
            clock.clone(),
        );
        let (client, resource, other) = temporary_resource_regrant(&auth, &host);
        clock
            .0
            .store(10_000_000_000, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            auth.require(&client, "content.read", &resource)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        auth.require(&client, "content.read", &other).unwrap();
    }
    #[test]
    fn prior_epoch_resource_regrant_still_masks_permanent_host_grant() {
        let (directory, initial, host) = setup();
        let clock = Arc::new(ManualClock(std::sync::atomic::AtomicU64::new(0)));
        let secret = ContextToken::try_from("independent-user-control-secret").unwrap();
        let auth = AuthService::with_clock(initial.store.clone(), secret.clone(), clock.clone());
        let (client, resource, other) = temporary_resource_regrant(&auth, &host);
        drop(auth);
        drop(initial);
        let store = Store::open(directory.path()).unwrap();
        store.begin_instance().unwrap();
        // 单调时钟仍在期限内，单独验证新 epoch 使临时规则失效。
        let restarted = AuthService::with_clock(store, secret, clock);
        assert_eq!(
            restarted
                .require(&client, "content.read", &resource)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        restarted.require(&client, "content.read", &other).unwrap();
    }
    fn temporary_resource_regrant(
        auth: &AuthService,
        host: &Target,
    ) -> (AuthenticatedActor, Target, Target) {
        let client = auth.authenticate(&id("scoped-reader"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(
                &id("cli"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let resource = Target {
            kind: ResourceKind::try_from("workspace").unwrap(),
            id: id("resource-s"),
            ..host.clone()
        };
        let other = Target {
            id: id("resource-t"),
            ..resource.clone()
        };
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: client.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![host.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        auth.revoke(
            &control,
            RevokeParams {
                actor_id: client.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![resource.clone()],
            },
        )
        .unwrap();
        assert_eq!(
            auth.require(&client, "content.read", &resource)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        auth.require(&client, "content.read", &other).unwrap();
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: client.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![resource.clone()],
                expires_at: Some(Timestamp::try_from("2000-01-01T00:00:10Z").unwrap()),
            },
        )
        .unwrap();
        auth.require(&client, "content.read", &resource).unwrap();
        auth.require(&client, "content.read", &other).unwrap();
        (client, resource, other)
    }
    #[test]
    fn finite_grant_uses_monotonic_deadline_and_does_not_survive_new_epoch() {
        let (directory, initial, target) = setup();
        let store = initial.store.clone();
        let clock = Arc::new(ManualClock(std::sync::atomic::AtomicU64::new(0)));
        let secret = ContextToken::try_from("independent-user-control-secret").unwrap();
        let auth = AuthService::with_clock(store.clone(), secret.clone(), clock.clone());
        let client = auth.authenticate(&id("finite-reader"), None).unwrap().actor;
        let control = auth.authenticate_user_control(&id("cli"), &secret).unwrap();
        let grant = AuthorizeParams {
            client_id: client.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: Some(Timestamp::try_from("2000-01-01T00:00:10Z").unwrap()),
        };
        auth.authorize(&control, grant.clone()).unwrap();
        auth.require(&client, "content.read", &target).unwrap();
        // 墙钟保持原值；只推进单调时钟也必须按原截止点失效。
        clock
            .0
            .store(10_000_000_000, std::sync::atomic::Ordering::SeqCst);
        assert!(auth.require(&client, "content.read", &target).is_err());
        auth.authorize(&control, grant).unwrap();
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: client.client_id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        drop(auth);
        drop(initial);
        drop(store);
        let restarted_store = Store::open(directory.path()).unwrap();
        restarted_store.begin_instance().unwrap();
        let restarted = AuthService::new(restarted_store, secret);
        assert!(restarted.require(&client, "content.read", &target).is_err());
        restarted
            .require(&client, "device.modify", &target)
            .unwrap();
    }
    #[test]
    fn failed_persistent_grant_does_not_enable_content() {
        let (directory, auth, target) = setup();
        let client = auth.authenticate(&id("reader"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(
                &id("cli"),
                &ContextToken::try_from("independent-user-control-secret").unwrap(),
            )
            .unwrap();
        let database =
            rusqlite::Connection::open(directory.path().join("host-v0/state.sqlite3")).unwrap();
        database.execute_batch("CREATE TRIGGER reject_grant BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT, 'test write failure'); END;").unwrap();
        let error = auth
            .authorize(
                &control,
                AuthorizeParams {
                    client_id: client.client_id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "STORAGE_UNAVAILABLE");
        assert!(auth.require(&client, "content.read", &target).is_err());
    }
}
