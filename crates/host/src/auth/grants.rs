use super::AuthenticatedActor;
use crate::storage::Store;
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use serial_workbench_ipc::identity::{credential_verifier, random_token, verify_credential};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

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
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantDocument {
    format_version: U64,
    clients: BTreeMap<Id, ClientRecord>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientRecord {
    actor_id: Id,
    grant_revision: U64,
    verifier: ContextToken,
    rules: Vec<Rule>,
}
#[derive(Serialize, Deserialize)]
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
    "metadata.read",
    "content.read",
    "device.modify",
    "code.execute",
    "plugins.manage",
    "workspace.modify",
    "settings.modify",
];
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
        }
    }
    fn load(&self) -> HostResult<(U64, GrantDocument)> {
        let Some(document) = self.store.read_document(&document_id())? else {
            return Ok((
                0.into(),
                GrantDocument {
                    format_version: 1.into(),
                    clients: BTreeMap::new(),
                },
            ));
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
        Ok((document.revision, data))
    }
    fn save(&self, revision: U64, document: GrantDocument) -> HostResult<U64> {
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
        let (revision, mut document) = self.load()?;
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
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(
            format!(
                "{}:{}",
                self.store.identity()?.host_id,
                self.control_verifier.as_str()
            )
            .as_bytes(),
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
    /// 仅判断动作能力是否可发现，不公开授权范围或资源是否存在。
    pub fn can_discover(
        &self,
        actor: &AuthenticatedActor,
        permission: &str,
        target_kinds: &[ResourceKind],
    ) -> HostResult<bool> {
        if actor.is_user_control() {
            self.require_control(actor)?;
            return Ok(["auth.manage", "metadata.read"].contains(&permission));
        }
        let (_, document) = self.load()?;
        let record = document
            .clients
            .get(actor.client_id())
            .filter(|record| &record.actor_id == actor.id())
            .ok_or_else(denied)?;
        for rule in &record.rules {
            if rule.permission != permission || !rule.allowed {
                continue;
            }
            if rule.target.kind.as_str() == "host" {
                // host范围允许该能力；具体资源上的窄拒绝仍在真正调用时复核。
                if self.require(actor, permission, &rule.target).is_ok() {
                    return Ok(true);
                }
            } else if target_kinds.contains(&rule.target.kind)
                && self.require(actor, permission, &rule.target).is_ok()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// 持有创建时的期限快照；中间唤醒只读 Clock，不重新查询授权或存储。
    pub(crate) async fn wait_grant_expiry(&self, stamp: Option<&GrantStamp>) {
        match stamp.and_then(|stamp| stamp.deadline_ns) {
            Some(deadline) => crate::clock::wait_until(self.clock.as_ref(), deadline).await,
            None => std::future::pending().await,
        }
    }
    pub fn grant_revision(&self, actor: &AuthenticatedActor) -> HostResult<U64> {
        if actor.is_user_control() {
            self.require_control(actor)?;
            return Ok(0.into());
        }
        self.load()?
            .1
            .clients
            .get(actor.client_id())
            .filter(|record| &record.actor_id == actor.id())
            .map(|record| record.grant_revision)
            .ok_or_else(denied)
    }
    pub(crate) fn capture_grants(
        &self,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<GrantStamp>> {
        if actor.is_user_control() {
            self.require_control(actor)?;
            return Ok(None);
        }
        let (_, document) = self.load()?;
        let record = document
            .clients
            .get(actor.client_id())
            .filter(|record| &record.actor_id == actor.id())
            .ok_or_else(denied)?;
        let epoch = self.store.identity()?.instance_epoch;
        let now = self.clock.mono_ns();
        let deadline_ns = record
            .rules
            .iter()
            .filter(|rule| rule.allowed && rule.epoch == Some(epoch))
            .filter_map(|rule| rule.deadline_ns.map(U64::get))
            .filter(|deadline| *deadline > now)
            .min();
        Ok(Some(GrantStamp {
            client_id: actor.client_id().clone(),
            actor_id: actor.id().clone(),
            revision: record.grant_revision,
            deadline_ns,
        }))
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
        if target.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Target belongs to a different Host",
            ));
        }
        if actor.is_user_control() {
            self.require_control(actor)?;
            return if ["auth.manage", "metadata.read"].contains(&permission) {
                Ok(())
            } else {
                Err(denied())
            };
        }
        let (_, document) = self.load()?;
        let record = document
            .clients
            .get(actor.client_id())
            .filter(|record| &record.actor_id == actor.id())
            .ok_or_else(denied)?;
        // 最新匹配规则生效。撤销可覆盖较宽的授权，但不会改变其他资源。
        for rule in record.rules.iter().rev() {
            if rule.permission != permission || !scope_matches(&rule.target, target) {
                continue;
            }
            if let Some(deadline) = rule.deadline_ns
                && (rule.epoch != Some(identity.instance_epoch)
                    || self.clock.mono_ns() >= deadline.get())
            {
                // 最新匹配规则失效后仍遮蔽该范围，不能重新继承更旧的宽授权。
                return Err(denied());
            }
            return if rule.allowed { Ok(()) } else { Err(denied()) };
        }
        Err(denied())
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
        let (revision, mut document) = self.load()?;
        let record = document
            .clients
            .get_mut(&params.client_id)
            .ok_or_else(denied)?;
        for permission in params.permissions {
            for target in &params.targets {
                set_rule(
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
        let (revision, mut document) = self.load()?;
        let record = document
            .clients
            .values_mut()
            .find(|record| record.actor_id == params.actor_id)
            .ok_or_else(denied)?;
        for permission in params.permissions {
            for target in &params.targets {
                set_rule(
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
fn set_rule(record: &mut ClientRecord, rule: Rule) -> HostResult<()> {
    record
        .rules
        .retain(|old| old.permission != rule.permission || old.target != rule.target);
    if record.rules.len() >= 256 {
        return Err(limit());
    }
    record.rules.push(rule);
    Ok(())
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
