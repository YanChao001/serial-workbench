use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp, hash},
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
impl Registry {
    pub fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        let bytes = serde_json::to_vec(&builtin_catalog()).map_err(|_| invalid())?;
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
        let grant_revision = self.auth.grant_revision(actor)?;
        let stamp = self.auth.capture_grants(actor)?;
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
                self.auth.validate_grants(stamp).map_err(|_| changed())?;
            }
            page.offset
        } else {
            0
        };
        let mut items = Vec::new();
        for spec in builtin_catalog() {
            let mut visible = true;
            for permission in &spec.permissions {
                visible &= self
                    .auth
                    .can_discover(actor, permission, &spec.target_kinds)?;
            }
            if visible {
                items.push(spec);
            }
        }
        items.sort_by(|left, right| left.action_id.as_str().cmp(right.action_id.as_str()));
        let has_more = items.len() > offset.saturating_add(size);
        let items = items.into_iter().skip(offset).take(size).collect();
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
