use super::{ReplayArchive, ReplayService, replay_busy, replay_closed, search::ReplaySearch};
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp},
    ipc::ConnectionContext,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{Arc, Mutex},
};

const MAX_ACTIVE_SEARCHES: usize = 32;
type SearchKey = (Id, Id);

#[derive(Clone, Default)]
pub(super) struct ReplaySearches {
    active: Arc<Mutex<HashMap<SearchKey, Arc<ActiveSearch>>>>,
}

#[derive(PartialEq, Eq)]
struct SearchSpec {
    id: RequestId,
    bytes_base64: Bytes,
    direction: Option<Direction>,
}

struct ActiveSearch {
    spec: SearchSpec,
    grant: Option<GrantStamp>,
    progress: Mutex<SearchProgress>,
}

struct SearchProgress {
    cursor: ReplaySearch,
    last_page: Option<(PositiveU64, ReplaySearchPage)>,
}

impl ReplaySearches {
    pub(super) fn release_session(&self, id: &Id) -> HostResult<()> {
        self.active
            .lock()
            .map_err(|_| replay_busy())?
            .retain(|(session_id, _), _| session_id != id);
        Ok(())
    }

    pub(super) fn release_connection(&self, id: &Id) -> HostResult<()> {
        self.active
            .lock()
            .map_err(|_| replay_busy())?
            .retain(|(_, connection_id), _| connection_id != id);
        Ok(())
    }

    fn release_revoked(&self, key: &SearchKey, auth: &AuthService) -> HostResult<()> {
        let candidates = {
            let active = self.active.lock().map_err(|_| replay_busy())?;
            let at_capacity = active.len() >= MAX_ACTIVE_SEARCHES;
            active
                .iter()
                .filter(|(other, search)| (*other == key || at_capacity) && search.grant.is_some())
                .map(|(key, search)| (key.clone(), search.clone()))
                .collect::<Vec<_>>()
        };
        for (key, search) in candidates {
            if search.grant.as_ref().is_some_and(|stamp| {
                auth.validate_grants(stamp)
                    .is_err_and(|error| error.code == "PERMISSION_DENIED")
            }) {
                // 验权在搜索表锁外进行，晚到的清理只撤销原有游标。
                let mut active = self.active.lock().map_err(|_| replay_busy())?;
                if let Entry::Occupied(entry) = active.entry(key)
                    && Arc::ptr_eq(entry.get(), &search)
                {
                    entry.remove();
                }
            }
        }
        Ok(())
    }

    fn start(
        &self,
        key: &SearchKey,
        connection: &ConnectionContext,
        archive: &Arc<ReplayArchive>,
        spec: SearchSpec,
        grant: Option<GrantStamp>,
    ) -> HostResult<Arc<ActiveSearch>> {
        let mut active = self.active.lock().map_err(|_| replay_busy())?;
        ensure_connected(connection)?;
        let at_capacity = active.len() >= MAX_ACTIVE_SEARCHES;
        match active.entry(key.clone()) {
            Entry::Occupied(entry) => {
                let search = entry.get();
                if search.spec != spec {
                    return Err(HostError::new(
                        "REQUEST_CONFLICT",
                        "Stop the active search or reuse the exact start request",
                    ));
                }
                Ok(search.clone())
            }
            Entry::Vacant(entry) => {
                if at_capacity {
                    return Err(HostError::new(
                        "LIMIT_EXCEEDED",
                        "Replay search budget exhausted",
                    ));
                }
                let bytes = STANDARD.decode(spec.bytes_base64.as_str()).map_err(|_| {
                    HostError::new("INVALID_ARGUMENT", "Invalid replay search bytes")
                })?;
                let cursor = archive.start_search(bytes, spec.direction)?;
                Ok(entry
                    .insert(Arc::new(ActiveSearch {
                        spec,
                        grant,
                        progress: Mutex::new(SearchProgress {
                            cursor,
                            last_page: None,
                        }),
                    }))
                    .clone())
            }
        }
    }

    fn next(&self, key: &SearchKey, id: &RequestId) -> HostResult<Arc<ActiveSearch>> {
        self.active
            .lock()
            .map_err(|_| replay_busy())?
            .get(key)
            .filter(|search| &search.spec.id == id)
            .cloned()
            .ok_or_else(|| HostError::new("NOT_FOUND", "Replay search was not found"))
    }

    fn stop(&self, key: &SearchKey, id: &RequestId) -> HostResult<bool> {
        let mut active = self.active.lock().map_err(|_| replay_busy())?;
        if let Entry::Occupied(entry) = active.entry(key.clone())
            && &entry.get().spec.id == id
        {
            entry.remove();
            return Ok(true);
        }
        Ok(false)
    }

    fn with_current<T>(
        &self,
        key: &SearchKey,
        connection: &ConnectionContext,
        search: &Arc<ActiveSearch>,
        commit: impl FnOnce() -> T,
    ) -> HostResult<T> {
        let active = self.active.lock().map_err(|_| replay_busy())?;
        ensure_connected(connection)?;
        if !active
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, search))
        {
            return Err(HostError::new("NOT_FOUND", "Replay search was stopped"));
        }
        Ok(commit())
    }
}

fn ensure_connected(connection: &ConnectionContext) -> HostResult<()> {
    if connection.channel != IpcChannel::Raw || connection.is_closed() {
        return Err(HostError::new(
            "BACKEND_DISCONNECTED",
            "Replay search requires a live raw connection",
        ));
    }
    Ok(())
}

impl ReplayService {
    pub(crate) fn release_search_connection(&self, id: &Id) {
        let _ = self.searches.release_connection(id);
    }

    pub(crate) async fn search(
        &self,
        params: ReplaySearchParams,
        actor: &AuthenticatedActor,
        connection: &ConnectionContext,
        auth: &AuthService,
        grant: Option<GrantStamp>,
    ) -> HostResult<ReplaySearchResult> {
        let service = self.clone();
        let actor = actor.clone();
        let connection = connection.clone();
        let auth = auth.clone();
        crate::capture::blocking(move || {
            ensure_connected(&connection)?;
            let target = service.target(&params.session_id, params.session_epoch)?;
            let session = service.find(&target)?;
            let session = session.lock().map_err(|_| replay_busy())?;
            service.authorize(&session, &target, &actor, "content.read")?;
            let source = session.source.clone();
            let key = (params.session_id, connection.connection_id.clone());
            if let ReplaySearchCommand::Stop { search_id } = params.command {
                return Ok(ReplaySearchResult::Stopped {
                    stopped: service.searches.stop(&key, &search_id)?,
                    search_id,
                });
            }
            let archive = session
                .reader
                .as_ref()
                .ok_or_else(replay_closed)?
                .archive
                .clone();
            let first = PositiveU64::try_from(U64::from(1)).expect("positive page");
            let (search, page) = match params.command {
                ReplaySearchCommand::Start {
                    search_id,
                    bytes_base64,
                    direction,
                } => {
                    service.searches.release_revoked(&key, &auth)?;
                    let search = service.searches.start(
                        &key,
                        &connection,
                        &archive,
                        SearchSpec {
                            id: search_id,
                            bytes_base64,
                            direction,
                        },
                        grant,
                    )?;
                    (search, first)
                }
                ReplaySearchCommand::Next { search_id, page } => {
                    (service.searches.next(&key, &search_id)?, page)
                }
                ReplaySearchCommand::Stop { .. } => unreachable!("stop already returned"),
            };
            // Registration and lookup are ordered with replay closing. Reading holds no
            // playback or global search lock. A stop/disconnect is visible between records.
            drop(session);
            let mut progress = search.progress.lock().map_err(|_| replay_busy())?;
            if let Some(stamp) = &search.grant {
                auth.validate_grants(stamp)?;
            }
            let check = || {
                service
                    .searches
                    .with_current(&key, &connection, &search, || ())
            };
            let mut advanced = None;
            let result = match progress.last_page.as_ref() {
                Some((last, result)) if *last == page => {
                    archive.ensure_directory()?;
                    result.clone()
                }
                last => {
                    let expected = last.map_or(1, |(page, _)| page.get().saturating_add(1));
                    if page.get() != expected || last.is_some_and(|(_, page)| page.complete) {
                        return Err(HostError::new(
                            "INVALID_ARGUMENT",
                            "Invalid replay search page",
                        ));
                    }
                    let mut cursor = progress.cursor.clone();
                    let result = archive.search_page(&mut cursor, check)?;
                    advanced = Some(cursor);
                    result
                }
            };
            service
                .files
                .authorization_target(&source, &actor, "content.read")?;
            let commit = || {
                service
                    .searches
                    .with_current(&key, &connection, &search, || {
                        if let Some(cursor) = advanced {
                            progress.cursor = cursor;
                            progress.last_page = Some((page, result.clone()));
                        }
                        ReplaySearchResult::Page {
                            search_id: search.spec.id.clone(),
                            page,
                            result,
                        }
                    })
            };
            match &search.grant {
                Some(stamp) => auth.commit_grant_stamp(stamp, commit),
                None => commit(),
            }
        })
        .await
    }
}
