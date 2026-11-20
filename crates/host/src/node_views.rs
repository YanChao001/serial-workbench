//! 视图读取以实际打开动作和当前 Node 登记为依据。
use super::*;
use crate::{node_backend::RegisteredHandler, node_packages::ui_assets::VerifiedUiAssets};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use node_queries::QueryAuthority;

struct ViewAccess {
    _permit: tokio::sync::OwnedSemaphorePermit,
    authority: QueryAuthority,
    binding: Arc<RegisteredHandler>,
    target: Target,
    view: NodePackageView,
    assets: Arc<VerifiedUiAssets>,
    version: NodePackageVersion,
}

impl ViewAccess {
    fn check(&self, host: &Host, actor: &AuthenticatedActor) -> HostResult<()> {
        self.binding.current()?;
        host.inner
            .auth
            .require(actor, "metadata.read", &self.target)?;
        self.authority.check()
    }
}

impl Host {
    fn node_view_access(
        &self,
        actor: &AuthenticatedActor,
        operation_target: &Target,
        params: &NodeViewAssetReadParams,
    ) -> HostResult<ViewAccess> {
        let permit = self
            .inner
            .node_view_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let operation_id = &operation_target.id;
        let (operation, _) = self.inner.store.retained_operation(operation_id)?;
        self.inner
            .auth
            .require(actor, "metadata.read", &operation.target)?;
        if !matches!(
            operation.state,
            OperationState::Running | OperationState::Succeeded
        ) || operation.owner.kind != OwnerKind::Plugin
        {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Operation did not open a plugin view",
            ));
        }
        let retained = self.inner.store.plugin_operation(operation_id)?;
        retained.validate_operation(&operation)?;
        let binding = self.inner.registry.runtime.resolve(&operation.action_id)?;
        if binding.package() != &retained.package
            || binding.archive_sha256() != &retained.archive_sha256
            || binding.instance_id() != &retained.instance_id
        {
            return Err(HostError::new(
                "CATALOG_CHANGED",
                "Plugin view activation changed",
            ));
        }
        let authority = QueryAuthority::new(
            self.clone(),
            actor.clone(),
            operation.target.clone(),
            binding.clone(),
        )?;
        let (view, assets) = binding.view_assets(&params.view_id).ok_or_else(|| {
            HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Plugin view is not registered for this action",
            )
        })?;
        if operation.state == OperationState::Running
            && view.feed != Some(NodePackageViewFeed::Derived)
        {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Operation did not open a plugin view",
            ));
        }
        let access = ViewAccess {
            _permit: permit,
            target: operation.target,
            view: view.clone(),
            assets,
            authority,
            binding,
            version: retained.version,
        };
        access.check(self, actor)?;
        Ok(access)
    }

    pub(super) async fn check_node_view_asset(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
    ) -> HostResult<()> {
        let params: NodeViewAssetReadParams = decode(&query.params)?;
        let host = self.clone();
        let actor = actor.clone();
        let target = query.target.clone();
        blocking(move || {
            let access = host.node_view_access(&actor, &target, &params)?;
            access.assets.check_range(
                params.path.as_ref().unwrap_or(access.assets.entry()),
                params.offset,
            )?;
            Ok(())
        })
        .await
    }

    pub(super) async fn read_node_view_asset(
        &self,
        actor: &AuthenticatedActor,
        operation_target: Target,
        params: NodeViewAssetReadParams,
    ) -> HostResult<NodeViewAssetReadResult> {
        let host = self.clone();
        let actor = actor.clone();
        blocking(move || {
            let access = host.node_view_access(&actor, &operation_target, &params)?;
            let entry = access.assets.entry().clone();
            let chunk = access
                .assets
                .read(params.path.as_ref().unwrap_or(&entry), params.offset)?;
            let bytes_base64 = Bytes::try_from(STANDARD.encode(chunk.bytes).as_str())?;
            access.check(&host, &actor)?;
            Ok(NodeViewAssetReadResult {
                package_id: access.binding.package().clone(),
                version: access.version,
                archive_sha256: access.binding.archive_sha256().clone(),
                activation_id: access.binding.instance_id().clone(),
                view: access.view,
                target: access.target,
                entry,
                path: chunk.path,
                offset: params.offset,
                total_bytes: chunk.total_bytes,
                sha256: chunk.sha256,
                bytes_base64,
            })
        })
        .await
    }
}
