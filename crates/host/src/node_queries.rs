//! 公共动态查询复用原始Query与真实登记，名额随实际阻塞工作持有。
use super::*;
use crate::auth::AuthorizationSnapshot;

pub(super) struct QueryAuthority {
    host: Host,
    actor: AuthenticatedActor,
    target: Target,
    binding: Arc<crate::node_backend::RegisteredHandler>,
    stamp: Option<GrantStamp>,
    cached: Mutex<(AuthorizationSnapshot, tokio::sync::watch::Receiver<U64>)>,
}
impl QueryAuthority {
    pub(super) fn new(
        host: Host,
        actor: AuthenticatedActor,
        target: Target,
        binding: Arc<crate::node_backend::RegisteredHandler>,
    ) -> HostResult<Self> {
        let mut changes = host.inner.auth.subscribe_changes();
        changes.borrow_and_update();
        let snapshot = host.inner.auth.snapshot(&actor)?;
        let stamp = snapshot.capture_grants();
        let authority = Self {
            host,
            actor,
            target,
            binding,
            stamp,
            cached: Mutex::new((snapshot, changes)),
        };
        authority.check()?;
        Ok(authority)
    }
    pub(super) fn check(&self) -> HostResult<()> {
        if self.host.inner.jobs.lock().map_err(|_| busy())?.closing {
            return Err(HostError::new("HOST_CLOSING", "Host is closing"));
        }
        // 动作只要求声明的业务权限；空权限也必须复核父任务当前性和目标范围。
        self.actor.check_task_target(&self.target)?;
        let mut cached = self.cached.lock().map_err(|_| busy())?;
        if cached.1.has_changed().unwrap_or(true) {
            cached.1.borrow_and_update();
            cached.0 = self.host.inner.auth.snapshot(&self.actor)?;
        }
        if let Some(stamp) = &self.stamp {
            cached.0.validate_grants(stamp)?;
        }
        if self.binding.spec().kind == ActionKind::Query {
            cached.0.require("metadata.read", &self.target)?;
        }
        for permission in &self.binding.spec().permissions {
            cached.0.require(permission, &self.target)?;
        }
        if self.target.kind.as_str() == "session" {
            self.host.inner.devices.session(&self.target)?;
        }
        // 物理登记仍可存续至dispose；接纳与交付还必须属于当前公开的同一绑定。
        self.host
            .inner
            .registry
            .runtime
            .validate_binding(&self.binding)
    }
}
impl Host {
    pub(super) async fn ensure_extension_active(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
        budget: Arc<tokio::sync::OwnedSemaphorePermit>,
    ) -> HostResult<()> {
        let host = self.clone();
        let caller = actor.clone();
        let request = query.clone();
        let inspection_budget = budget.clone();
        let missing = blocking(move || {
            let _budget = inspection_budget;
            host.extension_identity(&caller, &request)?;
            match host.inner.registry.runtime.resolve(&request.action_id) {
                Ok(_) => Ok(false),
                Err(error) if error.code == "UNSUPPORTED_CAPABILITY" => Ok(true),
                Err(error) => Err(error),
            }
        })
        .await?;
        if !missing {
            return Ok(());
        }
        let result = self
            .inner
            .node_packages
            .activate_contribution(actor, query, kind, budget.clone())
            .await;
        if let Err(error) = &result
            && error.code == "UNSUPPORTED_CAPABILITY"
        {
            let host = self.clone();
            let id = query.action_id.clone();
            // 另一个请求可能在预核期间完成登记；仍须由原调用路径重验实际绑定和业务权限。
            if blocking(move || {
                let _budget = budget;
                host.inner.registry.runtime.resolve(&id).map(|_| ())
            })
            .await
            .is_ok()
            {
                return Ok(());
            }
        }
        result
    }
    pub(super) fn extension_identity(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
    ) -> HostResult<()> {
        if &query.actor_id != actor.id() {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Actor does not match authentication",
            ));
        }
        query.target.validate()?;
        let identity = self.inner.store.identity()?;
        if query.host_id != identity.host_id || query.target.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Target belongs to another Host",
            ));
        }
        if query.instance_epoch != identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Host instance has changed",
            ));
        }
        if query.target.kind.as_str() == "host" && query.target.id != identity.host_id {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) async fn query_extension(
        &self,
        actor: &AuthenticatedActor,
        mut query: Query,
    ) -> HostResult<QueryResult> {
        let permit = self
            .inner
            .node_query_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let permit = Arc::new(permit);
        self.ensure_extension_active(actor, &query, ActionKind::Query, permit.clone())
            .await?;
        let host = self.clone();
        let actor = actor.clone();
        blocking(move || {
            let _permit = permit;
            host.extension_identity(&actor, &query)?;
            let binding = host.inner.registry.runtime.resolve(&query.action_id)?;
            #[cfg(test)]
            host.inner.node_test_gates.query_resolved.arrive();
            if query.reveal_target.page_id != binding.spec().reveal_target.page_id
                || query.reveal_target.panel_id != binding.spec().reveal_target.panel_id
            {
                return Err(invalid());
            }
            let authority = Arc::new(QueryAuthority::new(
                host.clone(),
                actor.clone(),
                query.target.clone(),
                binding.clone(),
            )?);
            let current = authority.clone();
            let reveal = binding.spec().reveal_target.clone();
            query.params = binding.normalize_parameters(&query.params)?;
            let output = binding.execute(
                query,
                move || current.check(),
                |query| host.activity_with_reveal(&actor, query, reveal),
            )?;
            let value: QueryValue = serde_json::from_value(output).map_err(|_| {
                HostError::new("NODE_QUERY_FAILED", "Query returned an invalid wire value")
            })?;
            binding.current()?;
            authority.check()?;
            Ok(QueryResult::Extension(value))
        })
        .await
    }
    pub(super) async fn check_extension_query(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: ActionCheckParams,
    ) -> HostResult<ActionCheckResult> {
        let permit = self
            .inner
            .node_query_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let host = self.clone();
        let actor = actor.clone();
        let target = target.clone();
        blocking(move || {
            let _permit = permit;
            let identity = host.inner.store.identity()?;
            let binding = host.inner.registry.runtime.resolve(&params.action_id)?;
            let mut query = Query {
                protocol_version: ProtocolVersion::V0_1,
                host_id: identity.host_id,
                instance_epoch: identity.instance_epoch,
                actor_id: actor.id().clone(),
                request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
                action_id: params.action_id.clone(),
                target: target.clone(),
                params: params.params,
                reveal_target: binding.spec().reveal_target.clone(),
            };
            host.extension_identity(&actor, &query)?;
            let authorization =
                QueryAuthority::new(host.clone(), actor, target.clone(), binding.clone());
            let allowed = match authorization {
                Ok(authority) => {
                    query.params = binding.normalize_parameters(&query.params)?;
                    binding.validate_check(&query)?;
                    authority.check()?;
                    true
                }
                Err(error) if error.code == "PERMISSION_DENIED" => false,
                Err(error) => return Err(error),
            };
            binding.current()?;
            host.inner.registry.runtime.validate_binding(&binding)?;
            Ok(ActionCheckResult {
                action_id: params.action_id,
                target,
                allowed,
            })
        })
        .await
    }
}

#[cfg(test)]
#[path = "node_queries/native_tests.rs"]
mod native_tests;
