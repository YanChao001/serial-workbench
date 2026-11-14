use crate::{
    auth::{AuthService, AuthenticatedActor, AuthorizationSnapshot, GrantStamp, hash},
    storage::Store,
};
use serial_workbench_core::*;
use std::{collections::VecDeque, sync::Mutex};

pub struct Registry {
    store: Store,
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
}
pub(crate) struct CatalogVisibility {
    pub version: U64,
    pub token: Digest,
    pub stamp: Option<GrantStamp>,
}
impl Registry {
    pub fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        let bytes = serde_json::to_vec(builtin_catalog()).map_err(|_| invalid())?;
        store.synchronize_catalog(&hash(&bytes))?;
        Ok(Self {
            store,
            auth,
            pages: Mutex::new(VecDeque::new()),
        })
    }
    pub fn list(
        &self,
        actor: &AuthenticatedActor,
        params: CatalogListParams,
    ) -> HostResult<CatalogListResult> {
        let size = usize::try_from(params.page_size.get()).map_err(|_| invalid())?;
        if !(1..=100).contains(&size) {
            return Err(invalid());
        }
        let version = self.store.identity()?.catalog_version;
        let authorization = self.auth.snapshot(actor)?;
        let grant_revision = authorization.grant_revision();
        let stamp = authorization.capture_grants();
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
            if &page.actor_id != actor.id() || page.size != params.page_size {
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
        let items = self.visible_actions(&authorization)?;
        let has_more = items.len() > offset.saturating_add(size);
        let items = items.into_iter().skip(offset).take(size).cloned().collect();
        if let Some(stamp) = &stamp {
            self.auth.validate_grants(stamp).map_err(|_| changed())?;
        }
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
    fn visible_actions(
        &self,
        authorization: &AuthorizationSnapshot,
    ) -> HostResult<Vec<&'static ActionSpec>> {
        let mut items = Vec::new();
        let catalog = builtin_catalog();
        let operation_resources: Vec<ResourceKind> = catalog
            .iter()
            .filter(|spec| spec.kind == ActionKind::Action)
            .flat_map(|spec| spec.target_kinds.iter().cloned())
            .collect();
        for spec in catalog {
            let mut visible = true;
            for permission in &spec.permissions {
                let action = BuiltinAction::find(spec.action_id.as_str())?;
                let target_kinds = if matches!(
                    action,
                    BuiltinAction::OperationGet | BuiltinAction::OperationInput
                ) {
                    // Inspection permissions apply to the original resource, not its lookup envelope.
                    operation_resources.clone()
                } else if action.is_capture_api() {
                    vec![ResourceKind::try_from(
                        if action == BuiltinAction::CaptureStart && permission == "content.read" {
                            "session"
                        } else {
                            "file"
                        },
                    )?]
                } else if matches!(
                    spec.action_id.as_str(),
                    "transfer.file" | "transfer.receiptsRead"
                ) && permission == "content.read"
                {
                    vec![ResourceKind::try_from("file")?]
                } else {
                    spec.target_kinds.clone()
                };
                visible &= authorization.can_discover(permission, &target_kinds);
            }
            if visible {
                items.push(spec);
            }
        }
        items.sort_by(|left, right| left.action_id.as_str().cmp(right.action_id.as_str()));
        Ok(items)
    }
    pub(crate) fn visibility(&self, actor: &AuthenticatedActor) -> HostResult<CatalogVisibility> {
        let authorization = self.auth.snapshot(actor)?;
        let stamp = authorization.capture_grants();
        let version = self.store.identity()?.catalog_version;
        let items = self.visible_actions(&authorization)?;
        if let Some(stamp) = &stamp {
            self.auth.validate_grants(stamp).map_err(|_| changed())?;
        }
        let bytes = serde_json::to_vec(&items).map_err(|_| invalid())?;
        Ok(CatalogVisibility {
            version,
            token: hash(&bytes),
            stamp,
        })
    }
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
