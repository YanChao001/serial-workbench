//! 共享文档协调；Store 领域服务仍是唯一解码与 CAS 写入入口。
use crate::{
    auth::{AuthService, AuthenticatedActor},
    settings::{SettingsService, import_document},
    state::ProjectionStore,
    storage::{Settlement, Store},
    workspace::WorkspaceService,
};
use serde::{Serialize, de::DeserializeOwned};
use serial_workbench_core::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

pub(crate) struct DocumentService {
    store: Store,
    auth: AuthService,
    projections: ProjectionStore,
    locks: Mutex<HashMap<Id, Weak<Mutex<()>>>>,
}
enum Document {
    Settings(SettingsDocumentResult),
    Workspace(WorkspaceDocumentResult),
}
impl Document {
    fn state(&self) -> HostResult<JsonObject> {
        match self {
            Self::Settings(value) => object(value),
            Self::Workspace(value) => object(value),
        }
    }
    fn reference(&self) -> &StateScopeRef {
        match self {
            Self::Settings(value) => &value.scope,
            Self::Workspace(value) => &value.scope,
        }
    }
    fn event(&self) -> Id {
        Id::try_from(match self {
            Self::Settings(_) => "settings.changed",
            Self::Workspace(_) => "workspace.changed",
        })
        .expect("event")
    }
    fn query(self) -> QueryResult {
        match self {
            Self::Settings(value) => QueryResult::Settings(value),
            Self::Workspace(value) => QueryResult::Workspace(value),
        }
    }
    fn result(self) -> ActionResult {
        match self {
            Self::Settings(value) => ActionResult::Settings(value),
            Self::Workspace(value) => ActionResult::Workspace(value),
        }
    }
}
impl DocumentService {
    pub(crate) fn resolve_device_binding(
        &self,
        actor: &AuthenticatedActor,
        reference: &DeviceBindingReference,
    ) -> HostResult<DeviceBinding> {
        let identity = self.store.identity()?;
        let target = Target {
            host_id: identity.host_id,
            kind: ResourceKind::try_from("workspace")?,
            id: reference.workspace_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let stamp = self.auth.capture_grants(actor)?;
        self.auth.require(actor, "metadata.read", &target)?;
        let document =
            WorkspaceService::new(self.store.clone(), reference.workspace_id.clone()).read()?;
        let binding = document
            .value
            .bindings
            .into_iter()
            .find(|binding| binding.binding_id == reference.binding_id)
            .ok_or_else(|| HostError::new("NOT_FOUND", "Workspace device binding was not found"))?;
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", &target)?;
        Ok(binding)
    }
    pub(crate) fn new(store: Store, auth: AuthService, projections: ProjectionStore) -> Self {
        Self {
            store,
            auth,
            projections,
            locks: Mutex::new(HashMap::new()),
        }
    }
    pub(crate) fn reference(target: &Target) -> HostResult<StateScopeRef> {
        if target.session_id.is_some() || target.session_epoch.is_some() {
            return Err(invalid());
        }
        let scope = match target.kind.as_str() {
            "settings" if target.id.as_str() == "shared" => "settings:shared".to_owned(),
            "workspace" => format!("workspace:{}", target.id),
            _ => return Err(invalid()),
        };
        Ok(StateScopeRef {
            scope_id: Id::try_from(scope.as_str())?,
            target: target.clone(),
        })
    }
    fn document_lock(&self, reference: &StateScopeRef) -> HostResult<Arc<Mutex<()>>> {
        // 锁表只保护身份查找；获取文档锁与数据库 IO 之前释放全局表锁。
        let mut locks = self.locks.lock().map_err(|_| unavailable())?;
        locks.retain(|_, value| value.strong_count() > 0);
        if let Some(existing) = locks.get(&reference.scope_id).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        if locks.len() >= crate::limits::NORMAL_OPERATIONS {
            return Err(HostError::new(
                "HOST_BUSY",
                "Document coordination capacity is exhausted",
            ));
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(reference.scope_id.clone(), Arc::downgrade(&lock));
        Ok(lock)
    }
    fn load(&self, reference: StateScopeRef) -> HostResult<Document> {
        match reference.target.kind.as_str() {
            "settings" => Ok(Document::Settings(SettingsDocumentResult {
                document: SettingsService::new(self.store.clone()).read()?,
                scope: reference,
            })),
            "workspace" => Ok(Document::Workspace(WorkspaceDocumentResult {
                document: WorkspaceService::new(self.store.clone(), reference.target.id.clone())
                    .read()?,
                scope: reference,
            })),
            _ => Err(invalid()),
        }
    }
    fn synchronize(&self, document: &Document) -> HostResult<()> {
        let state = document.state()?;
        wire_budget(&state)?;
        self.projections
            .synchronize_document(document.reference(), document.event(), state)
    }
    pub(crate) fn preview_workspace_import(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: DocumentImportParams,
    ) -> HostResult<WorkspaceDocument> {
        if target.kind.as_str() != "workspace" {
            return Err(invalid());
        }
        Self::reference(target)?;
        let stamp = self.auth.capture_grants(actor)?;
        self.auth.require(actor, "metadata.read", target)?;
        let value = import_document::<WorkspaceDocument>(&params.json)?;
        value.validate()?;
        wire_budget(&value)?;
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", target)?;
        Ok(value)
    }
    pub(crate) fn query(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        action: BuiltinAction,
    ) -> HostResult<QueryResult> {
        let _: EmptyParams = decode(&query.params)?;
        let reference = Self::reference(&query.target)?;
        let lock = self.document_lock(&reference)?;
        let _document = lock.lock().map_err(|_| unavailable())?;
        let stamp = self.auth.capture_grants(actor)?;
        self.auth.require(actor, "metadata.read", &query.target)?;
        let document = self.load(reference)?;
        self.synchronize(&document)?;
        let result = match action {
            BuiltinAction::SettingsRead | BuiltinAction::WorkspaceRead => document.query(),
            BuiltinAction::SettingsExport => QueryResult::DocumentJson(DocumentJsonResult {
                json: SettingsService::new(self.store.clone()).export_json()?,
            }),
            BuiltinAction::WorkspaceExport => QueryResult::DocumentJson(DocumentJsonResult {
                json: WorkspaceService::new(self.store.clone(), query.target.id.clone())
                    .export_json()?,
            }),
            _ => return Err(invalid()),
        };
        wire_budget(&result)?;
        if let Some(stamp) = &stamp {
            self.auth.validate_grants(stamp)?;
        }
        self.auth.require(actor, "metadata.read", &query.target)?;
        Ok(result)
    }
    pub(crate) fn execute(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        action: BuiltinAction,
        descriptor: Option<DeviceDescriptor>,
    ) -> Settlement {
        match self.save(actor, call, action, descriptor) {
            Ok((result, error)) => Settlement {
                state: if error.is_some() {
                    OperationState::Failed
                } else {
                    OperationState::Succeeded
                },
                result: Some(result),
                error,
            },
            Err(error) => Settlement {
                state: OperationState::Failed,
                result: None,
                error: Some(error),
            },
        }
    }
    fn save(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        action: BuiltinAction,
        descriptor: Option<DeviceDescriptor>,
    ) -> HostResult<(ActionResult, Option<HostError>)> {
        let reference = Self::reference(&call.target)?;
        let lock = self.document_lock(&reference)?;
        let _document = lock.lock().map_err(|_| unavailable())?;
        let expected = call.expected_revision.ok_or_else(invalid)?;
        // 先识别持久文档版本与损坏，再解析替换数据，避免覆盖无法读取的原件。
        let current = self.load(reference.clone())?;
        self.synchronize(&current)?;
        let next = expected.checked_next()?;
        let candidate = match action {
            BuiltinAction::DeviceRebind | BuiltinAction::FavoritesSave => {
                let Document::Workspace(current) = &current else {
                    return Err(invalid());
                };
                let mut value = current.document.value.clone();
                if action == BuiltinAction::FavoritesSave {
                    value.favorite_binding_ids =
                        decode::<FavoritesSaveParams>(&call.params)?.binding_ids;
                } else {
                    let params: RebindParams = decode(&call.params)?;
                    let descriptor = descriptor.ok_or_else(invalid)?;
                    if descriptor.device_id != params.device_id
                        || descriptor.host_id != call.target.host_id
                    {
                        return Err(invalid());
                    }
                    let binding = value
                        .bindings
                        .iter_mut()
                        .find(|binding| binding.binding_id == params.binding_id)
                        .ok_or_else(invalid)?;
                    binding.host_id = descriptor.host_id;
                    binding.device_id = descriptor.device_id;
                    binding.fingerprint = descriptor.fingerprint;
                }
                value.validate()?;
                Document::Workspace(WorkspaceDocumentResult {
                    document: WorkspaceSnapshot {
                        revision: next,
                        value,
                    },
                    scope: reference,
                })
            }
            BuiltinAction::SettingsSave | BuiltinAction::SettingsImport => {
                let value: SharedSettings = if action == BuiltinAction::SettingsSave {
                    decode::<SettingsSaveParams>(&call.params)?.value
                } else {
                    import_document(&decode::<DocumentImportParams>(&call.params)?.json)?
                };
                Document::Settings(SettingsDocumentResult {
                    document: SettingsSnapshot {
                        revision: next,
                        value,
                    },
                    scope: reference,
                })
            }
            BuiltinAction::WorkspaceSave | BuiltinAction::WorkspaceImport => {
                let value: WorkspaceDocument = if action == BuiltinAction::WorkspaceSave {
                    decode::<WorkspaceSaveParams>(&call.params)?.value
                } else {
                    import_document(&decode::<DocumentImportParams>(&call.params)?.json)?
                };
                value.validate()?;
                Document::Workspace(WorkspaceDocumentResult {
                    document: WorkspaceSnapshot {
                        revision: next,
                        value,
                    },
                    scope: reference,
                })
            }
            _ => return Err(invalid()),
        };
        let state = candidate.state()?;
        wire_budget(&state)?;
        self.projections.preflight_document(
            &candidate.reference().scope_id,
            candidate.event(),
            &state,
        )?;
        // 等待文档锁后，在唯一持久修改前复查权限与实例代次。
        for permission in &action.spec().permissions {
            self.auth.require(actor, permission, &call.target)?;
        }
        if self.store.identity()?.instance_epoch != call.instance_epoch {
            return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
        }
        let saved = match candidate {
            Document::Settings(mut result) => {
                result.document = SettingsService::new(self.store.clone())
                    .save(expected, result.document.value)?;
                Document::Settings(result)
            }
            Document::Workspace(mut result) => {
                result.document = WorkspaceService::new(self.store.clone(), call.target.id.clone())
                    .save(expected, result.document.value)?;
                Document::Workspace(result)
            }
        };
        let error = self.projections.commit(&saved.reference().scope_id, saved.event(), state.clone(), state).err().map(|mut error| {
            error.message = "Document persisted, but projection publication failed; read the document to recover".into();
            error.details = Some(Box::new([("documentPersisted".into(), JsonValue::Bool(true))].into()));
            error
        });
        Ok((saved.result(), error))
    }
}
pub(crate) fn normalize(action: BuiltinAction, call: &Call) -> HostResult<JsonObject> {
    DocumentService::reference(&call.target)?;
    call.expected_revision.ok_or_else(invalid)?;
    match action {
        BuiltinAction::DeviceRebind => object(&decode::<RebindParams>(&call.params)?),
        BuiltinAction::FavoritesSave => object(&decode::<FavoritesSaveParams>(&call.params)?),
        BuiltinAction::SettingsSave => object(&decode::<SettingsSaveParams>(&call.params)?),
        BuiltinAction::WorkspaceSave => {
            let params: WorkspaceSaveParams = decode(&call.params)?;
            params.value.validate()?;
            object(&params)
        }
        BuiltinAction::SettingsImport | BuiltinAction::WorkspaceImport => {
            object(&decode::<DocumentImportParams>(&call.params)?)
        }
        _ => Err(invalid()),
    }
}
fn decode<T: DeserializeOwned>(params: &JsonObject) -> HostResult<T> {
    serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn object(value: &impl Serialize) -> HostResult<JsonObject> {
    serde_json::from_value(serde_json::to_value(value).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn wire_budget(value: &impl Serialize) -> HostResult<()> {
    // 为 RpcReply/Operation 信封预留空间；大结果的 ObjectRef 导出由后续 FileService 集成接入。
    if serde_json::to_vec(value).map_err(|_| invalid())?.len()
        > serial_workbench_ipc::frame::MAX_FRAME_BYTES - 16 * 1024
    {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Document result exceeds the inline response budget",
        ));
    }
    Ok(())
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Document action parameters or target are invalid",
    )
}
fn unavailable() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Document coordination is unavailable",
    )
}
