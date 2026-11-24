use crate::{
    auth::{AuthService, AuthenticatedActor, AuthorizationSnapshot, GrantStamp, hash},
    storage::Store,
};
use serial_workbench_core::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
mod node_catalog;
pub(crate) use node_catalog::RuntimeCatalog;

pub struct Registry {
    pub(crate) runtime: Arc<RuntimeCatalog>,
    auth: AuthService,
    pages: Mutex<VecDeque<(String, Page)>>,
}
struct Page {
    actor_id: Id,
    version: U64,
    grant_revision: U64,
    stamp: Option<GrantStamp>,
    size: U64,
    offset: usize,
    supports_events: bool,
}
pub(crate) struct CatalogVisibility {
    pub version: U64,
    pub token: Digest,
    pub stamp: Option<GrantStamp>,
}
impl Registry {
    pub fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        Ok(Self {
            runtime: Arc::new(RuntimeCatalog::new(store)?),
            auth,
            pages: Mutex::new(VecDeque::new()),
        })
    }
    pub fn list(
        &self,
        actor: &AuthenticatedActor,
        params: CatalogListParams,
    ) -> HostResult<CatalogListResult> {
        self.list_for_delivery(actor, params, true)
    }

    pub(crate) fn list_for_delivery(
        &self,
        actor: &AuthenticatedActor,
        params: CatalogListParams,
        supports_events: bool,
    ) -> HostResult<CatalogListResult> {
        let size = usize::try_from(params.page_size.get()).map_err(|_| invalid())?;
        if !(1..=100).contains(&size) {
            return Err(invalid());
        }
        let (version, extensions) = self.runtime.snapshot()?;
        let authorization = self.auth.snapshot(actor)?;
        let grant_revision = authorization.grant_revision();
        let stamp = authorization.capture_catalog_grants();
        if params
            .catalog_version
            .is_some_and(|expected| expected != version)
        {
            return Err(changed());
        }
        let offset = if let Some(token) = &params.page_token {
            let pages = self.pages.lock().map_err(|_| invalid())?;
            let page = pages
                .iter()
                .find(|(key, _)| key == token)
                .map(|(_, page)| page)
                .ok_or_else(invalid)?;
            if &page.actor_id != actor.id()
                || page.size != params.page_size
                || page.supports_events != supports_events
            {
                return Err(invalid());
            }
            if page.version != version || page.grant_revision != grant_revision {
                return Err(changed());
            }
            if let Some(stamp) = &page.stamp {
                authorization
                    .validate_grants(stamp)
                    .map_err(|_| changed())?;
            }
            page.offset
        } else {
            0
        };
        let mut items = self.visible_actions(&authorization, &extensions)?;
        if !supports_events {
            items.retain(|spec| !requires_events(spec.action_id.as_str()));
        }
        let has_more = items.len() > offset.saturating_add(size);
        let items = items.into_iter().skip(offset).take(size).collect();
        if let Some(stamp) = &stamp {
            self.auth.validate_grants(stamp).map_err(|_| changed())?;
        }
        self.runtime.validate_version(version)?;
        let next_page_token = if has_more {
            let token = uuid::Uuid::new_v4().to_string();
            let mut pages = self.pages.lock().map_err(|_| invalid())?;
            if pages.len() == 256 {
                pages.pop_front();
            }
            pages.push_back((
                token.clone(),
                Page {
                    actor_id: actor.id().clone(),
                    version,
                    grant_revision,
                    stamp,
                    size: params.page_size,
                    offset: offset + size,
                    supports_events,
                },
            ));
            Some(token)
        } else {
            None
        };
        Ok(CatalogListResult {
            catalog_version: version,
            items,
            next_page_token,
        })
    }
    pub(crate) fn node_themes(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
    ) -> HostResult<NodeThemesResult> {
        let authorize = || {
            let authorization = self.auth.snapshot(actor)?;
            if authorization.is_lan_peer() {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Themes belong to the local Host",
                ));
            }
            authorization.require("metadata.read", target)
        };
        authorize()?;
        let (version, handlers) = self.runtime.snapshot()?;
        let mut themes = Vec::new();
        for handler in handlers {
            let mut entries = handler.themes().peekable();
            if entries.peek().is_some() && handler.current().is_ok() {
                themes.extend(entries.cloned());
            }
        }
        self.runtime.validate_version(version)?;
        authorize()?;
        Ok(NodeThemesResult { themes })
    }

    fn visible_actions(
        &self,
        authorization: &AuthorizationSnapshot,
        extensions: &[Arc<crate::node_backend::RegisteredHandler>],
    ) -> HostResult<Vec<ActionSpec>> {
        let mut items = Vec::new();
        let catalog: Vec<&ActionSpec> = builtin_catalog()
            .iter()
            .chain(extensions.iter().map(|query| query.spec()))
            .collect();
        let operation_resources: Vec<ResourceKind> = catalog
            .iter()
            .filter(|spec| spec.kind == ActionKind::Action)
            .flat_map(|spec| spec.target_kinds.iter().cloned())
            .collect();
        for spec in catalog {
            let mut visible = true;
            let action = BuiltinAction::find(spec.action_id.as_str()).ok();
            if action == Some(BuiltinAction::ToolHandoff) && !cfg!(windows) {
                continue;
            }
            if action == Some(BuiltinAction::NodeThemesList) && authorization.is_lan_peer() {
                continue;
            }
            if matches!(
                action,
                Some(BuiltinAction::StateScopes | BuiltinAction::DeviceList)
            ) && authorization.is_lan_peer()
            {
                // 配对身份调用此目录时，逐项查看已共享的投影。
                items.push(spec.clone());
                continue;
            }
            for permission in &spec.permissions {
                if matches!(
                    action,
                    Some(BuiltinAction::FileMetadata | BuiltinAction::FileRead)
                ) {
                    // 历史插件结果沿用原动作资源的权限，其类型可不同于结果引用。
                    visible &= authorization.can_discover_on(permission, |_| true);
                    continue;
                }
                let target_kinds = if matches!(
                    action,
                    Some(BuiltinAction::OperationGet | BuiltinAction::OperationInput)
                ) {
                    // Inspection permissions apply to the original resource, not its lookup envelope.
                    operation_resources.clone()
                } else if action.is_some_and(BuiltinAction::is_capture_api) {
                    vec![ResourceKind::try_from(
                        if action == Some(BuiltinAction::CaptureStart)
                            && permission == "content.read"
                        {
                            "session"
                        } else {
                            "file"
                        },
                    )?]
                } else if matches!(
                    action,
                    Some(BuiltinAction::TransferReceiptsRead | BuiltinAction::TransferReadProgress)
                ) && permission == "content.read"
                {
                    ["file", "session"]
                        .into_iter()
                        .map(ResourceKind::try_from)
                        .collect::<HostResult<Vec<_>>>()?
                } else if matches!(
                    spec.action_id.as_str(),
                    "transfer.file" | "node.packages.install"
                ) && permission == "content.read"
                {
                    vec![ResourceKind::try_from("file")?]
                } else {
                    spec.target_kinds.clone()
                };
                visible &= authorization.can_discover(permission, &target_kinds);
            }
            if visible {
                items.push(spec.clone());
            }
        }
        items.sort_by(|left, right| left.action_id.as_str().cmp(right.action_id.as_str()));
        Ok(items)
    }
    pub(crate) fn visibility(&self, actor: &AuthenticatedActor) -> HostResult<CatalogVisibility> {
        let authorization = self.auth.snapshot(actor)?;
        let stamp = authorization.capture_catalog_grants();
        let (version, extensions) = self.runtime.snapshot()?;
        let items = self.visible_actions(&authorization, &extensions)?;
        if let Some(stamp) = &stamp {
            self.auth.validate_grants(stamp).map_err(|_| changed())?;
        }
        self.runtime.validate_version(version)?;
        let bytes = serde_json::to_vec(&items).map_err(|_| invalid())?;
        Ok(CatalogVisibility {
            version,
            token: hash(&bytes),
            stamp,
        })
    }
}
pub(crate) fn requires_events(action_id: &str) -> bool {
    matches!(
        action_id,
        "state.subscribe" | "stream.subscribe" | "stream.credit" | "subscription.close"
    )
}

fn invalid() -> HostError {
    HostError::new(
        "INVALID_PAGE_TOKEN",
        "Invalid catalog page parameters or token",
    )
}
fn changed() -> HostError {
    HostError::new(
        "CATALOG_CHANGED",
        "Catalog or current authorization changed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_filtering_shares_one_snapshot_and_keeps_final_persistent_check() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store.begin_instance().unwrap();
        let auth = AuthService::new(
            store.clone(),
            ContextToken::try_from("catalog-control").unwrap(),
        );
        let actor = auth
            .authenticate(&Id::try_from("catalog-reader").unwrap(), None)
            .unwrap()
            .actor;
        let registry = Registry::new(store, auth.clone()).unwrap();
        let before = auth.document_reads();
        let result = registry
            .list(
                &actor,
                CatalogListParams {
                    page_size: 100.into(),
                    page_token: None,
                    catalog_version: None,
                },
            )
            .unwrap();
        assert!(!result.items.is_empty());
        assert_eq!(auth.document_reads() - before, 2);
        let before = auth.document_reads();
        registry.visibility(&actor).unwrap();
        assert_eq!(auth.document_reads() - before, 2);
    }
}
