//! Retained operation inspection uses current resource read rights, never creator identity.
use super::*;

impl Host {
    pub(super) async fn inspect_operation(
        &self,
        actor: &AuthenticatedActor,
        request_target: &Target,
        selector: OperationGetParams,
        include_input: bool,
    ) -> HostResult<(Operation, OperationInput)> {
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let reader = actor.clone();
        let (mut operation, params, source, stamp) = blocking(move || {
            let stamp = auth.capture_grants(&reader)?;
            let record = match &selector {
                OperationGetParams::ById { operation_id, .. } => {
                    match store.retained_operation(operation_id) {
                        Err(error) if error.code == "NOT_FOUND" => {
                            // Preserve request-context validation for missing IDs.
                            store.get_selected(&reader, &selector)?;
                            return Err(error);
                        }
                        result => result?,
                    }
                }
                _ => {
                    let selected = store.get_selected(&reader, &selector)?;
                    store.retained_operation(&selected.operation_id)?
                }
            };
            let source = if matches!(
                record.0.action_id.as_str(),
                "capture.recover"
                    | "replay.control"
                    | "replay.close"
                    | "session.close"
                    | "replay.peer.open"
                    | "replay.peer.submit"
            ) {
                match store.operation_source_authority(&record.0.operation_id) {
                    Ok(source) => Some(source),
                    Err(error)
                        if error.code == "SOURCE_AUTHORITY_UNAVAILABLE"
                            && record.0.action_id.as_str() == "session.close" =>
                    {
                        None
                    }
                    Err(error) if error.code == "SOURCE_AUTHORITY_UNAVAILABLE" => {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Retained source authority is unavailable",
                        ));
                    }
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            Ok((record.0, record.1, source, stamp))
        })
        .await?;
        if request_target.kind.as_str() == "operation"
            && request_target.id != operation.operation_id
        {
            return Err(invalid());
        }
        let replay = matches!(
            operation.action_id.as_str(),
            "replay.control" | "replay.close" | "replay.peer.open" | "replay.peer.submit"
        ) || (operation.action_id.as_str() == "session.close" && source.is_some());
        let auth = self.inner.auth.clone();
        let files = self.inner.files.clone();
        let reader = actor.clone();
        let store = self.inner.store.clone();
        blocking(move || {
            if operation.owner.kind == OwnerKind::Plugin {
                store.plugin_operation(&operation.operation_id)?;
            }
            if let Some(source) = &source {
                auth.require(&reader, "metadata.read", source)?;
                auth.require(&reader, "content.read", source)?;
            }
            authorize_inspection(
                &auth,
                &files,
                &reader,
                &operation,
                params.as_ref(),
                replay,
                include_input,
            )?;
            let input = if include_input {
                typed_input(&operation, params.as_ref())
            } else {
                OperationInput::Redacted {
                    reason: OperationInputRedaction::UnsupportedAction,
                }
            };
            redact_error_details(&mut operation);
            if let Some(stamp) = &stamp {
                auth.validate_grants(stamp)?;
            }
            Ok((operation, input))
        })
        .await
    }
}

pub(super) fn redact_error_details(operation: &mut Operation) {
    // 查询和同键重放保持同一公开投影，持久证据中的私有诊断仍保留。
    if let Some(error) = operation.error.as_mut() {
        let public_open_detail = operation.action_id.as_str() == "device.open"
            && error.code == "PLUGIN_TRANSPORT_OPEN_FAILED"
            && error
                .details
                .as_deref()
                .is_some_and(crate::device::plugin_transport::is_public_rfc2217_open_detail);
        let peer_position = operation.action_id.as_str() == "replay.peer.submit"
            && error.code == "REPLAY_PEER_MISMATCH"
            && error.details.as_deref().is_some_and(|details| {
                details.len() == 3
                    && ["turn", "matchedBytes", "mismatchOffset"]
                        .iter()
                        .all(|key| {
                            details
                                .get(*key)
                                .and_then(|value| serde_json::to_value(value).ok())
                                .and_then(|value| value.as_u64())
                                .is_some_and(|value| value <= 512 * 1024)
                        })
            });
        if !public_open_detail && !peer_position {
            error.details = None;
        }
    }
}

fn authorize_inspection(
    auth: &AuthService,
    files: &crate::files::FileService,
    actor: &AuthenticatedActor,
    operation: &Operation,
    params: Option<&JsonObject>,
    replay: bool,
    include_input: bool,
) -> HostResult<()> {
    let action = operation.action_id.as_str();
    let file_read = |reference: &ObjectRef| {
        files.require_inspection_reference(reference, actor, "metadata.read")?;
        files.require_inspection_reference(reference, actor, "content.read")
    };
    let stored = || {
        params.ok_or_else(|| {
            HostError::new(
                "PERMISSION_DENIED",
                "Stored resource authority is unavailable",
            )
        })
    };
    match action {
        "node.packages.install" => {
            auth.require(actor, "metadata.read", &operation.target)?;
            if include_input {
                let input: NodePackageInstallParams = decode(stored()?)?;
                files.require_inspection_reference(&input.archive_ref, actor, "content.read")?;
            }
        }
        "capture.start" => {
            let input: CaptureStartParams = decode(stored()?)?;
            file_read(&input.target_ref)?;
            for source in input.session_refs {
                auth.require(actor, "metadata.read", &source)?;
                auth.require(actor, "content.read", &source)?;
            }
        }
        "capture.stop" | "capture.verify" => {
            let input: CaptureVerifyParams = decode(stored()?)?;
            file_read(&input.capture_ref)?;
        }
        "capture.export" => {
            let input: TextExportParams = decode(stored()?)?;
            file_read(&input.capture_ref)?;
            file_read(&input.target_ref)?;
        }
        "capture.recover" => {
            let input: RecoverPrefixParams = decode(stored()?)?;
            file_read(&input.target_ref)?;
        }
        "replay.open" => {
            let input: ReplayOpenParams = decode(stored()?)?;
            file_read(&input.capture_ref)?;
        }
        "replay.transmit" => {
            let input: ReplayTransmitParams = decode(stored()?)?;
            auth.require(actor, "metadata.read", &operation.target)?;
            file_read(&input.selection.capture_ref)?;
            authorize_transfer_result(files, actor, operation)?;
        }
        "replay.peer.open" => {
            let input: ReplayPeerOpenParams = decode(stored()?)?;
            file_read(&input.capture_ref)?;
        }
        "replay.control" | "replay.close" | "replay.peer.submit" => {} // Current rights on the persisted source were checked above.
        "replay.peer.close" => {
            if actor.id() != &operation.actor_id {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "The recorded peer belongs to another actor",
                ));
            }
        }
        "workspace.commands.export" => {
            auth.require(actor, "metadata.read", &operation.target)?;
            auth.require(actor, "content.read", &operation.target)?;
            if let Some(ActionResult::Reference(value)) = &operation.result
                && file_read(&value.result_ref).is_ok()
            {
                return Ok(());
            }
            // 保存授权可观察自己选择的目的地回执，读取归档仍需独立权限。
            let input: CommandLibraryFileParams = decode(stored()?)?;
            files.require_reference(&input.file_ref, actor, "workspace.modify")?;
            return Ok(());
        }
        "file.register" => {
            if let Some(ActionResult::FileMetadata(metadata)) = &operation.result {
                files.require_inspection_reference(&metadata.file_ref, actor, "metadata.read")?;
            } else {
                auth.require(actor, "metadata.read", &operation.target)?;
            }
        }
        "session.toolHandoff" => auth.require_control(actor)?,
        _ if replay => {}
        _ => {
            auth.require(actor, "metadata.read", &operation.target)?;
            if matches!(action, "session.tx" | "transfer.file" | "transfer.paste")
                || matches!(
                    operation.result,
                    Some(ActionResult::Tx(_) | ActionResult::Reference(_))
                )
            {
                auth.require(actor, "content.read", &operation.target)?;
            }
            if action == "transfer.file" {
                if matches!(operation.result, Some(ActionResult::FileTransfer(_))) {
                    authorize_transfer_result(files, actor, operation)?;
                } else {
                    let input: FileTransferParams = decode(stored()?)?;
                    files.require_inspection_reference(&input.source_ref, actor, "content.read")?;
                }
            }
            if let Some(capability) = ClientCapability::find(action) {
                match capability {
                    ClientCapability::ClipboardReadText => {
                        auth.require(actor, "client.clipboard.read", &operation.target)?;
                    }
                    ClientCapability::ClipboardWriteText if include_input => {
                        auth.require(actor, "client.clipboard.read", &operation.target)?;
                    }
                    ClientCapability::DiagnosticsRead => {
                        auth.require(actor, "content.read", &operation.target)?;
                    }
                    _ => {}
                }
            }
        }
    }
    // Derived result references carry their saved parent's rights, not the outer call target.
    match &operation.result {
        Some(ActionResult::CaptureStatus(value)) => file_read(&value.capture_ref)?,
        Some(ActionResult::Reference(value))
            if matches!(
                value.result_ref.kind.as_str(),
                "file" | "capture" | "capture_record" | "plugin_result"
            ) =>
        {
            file_read(&value.result_ref)?
        }
        _ => {}
    }
    Ok(())
}

fn typed_input(operation: &Operation, params: Option<&JsonObject>) -> OperationInput {
    let redacted = |reason| OperationInput::Redacted { reason };
    if operation.action_id.as_str() == "file.register" {
        return redacted(OperationInputRedaction::SensitivePath);
    }
    let Some(params) = params else {
        return redacted(OperationInputRedaction::InvalidStoredInput);
    };
    let decoded = match operation.action_id.as_str() {
        "device.open" => decode(params).map(OperationInput::Open),
        "session.tx" => decode(params).map(OperationInput::Tx),
        "transfer.file" => decode(params).map(OperationInput::FileTransfer),
        "transfer.paste" => decode(params).map(OperationInput::PasteTransfer),
        "capture.start" => decode(params).map(OperationInput::CaptureStart),
        "session.configure" => decode(params).map(OperationInput::Configure),
        "session.control" => decode(params).map(OperationInput::Control),
        "session.break" => decode(params).map(OperationInput::Break),
        "settings.save" if operation.state == OperationState::Succeeded => {
            decode(params).map(OperationInput::SettingsSave)
        }
        "workspace.save" if operation.state == OperationState::Succeeded => {
            decode(params).map(OperationInput::WorkspaceSave)
        }
        action => {
            if let Some(capability) = ClientCapability::find(action) {
                ClientEffectAction::from_params(capability, params).map(OperationInput::Client)
            } else {
                return redacted(
                    if matches!(action, "auth.authorize" | "auth.revoke" | "host.shutdown") {
                        OperationInputRedaction::Management
                    } else {
                        OperationInputRedaction::UnsupportedAction
                    },
                );
            }
        }
    };
    decoded.unwrap_or_else(|_| redacted(OperationInputRedaction::InvalidStoredInput))
}
