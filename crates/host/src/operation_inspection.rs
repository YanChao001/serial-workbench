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
                "capture.recover" | "replay.control" | "replay.close" | "session.close"
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
            "replay.control" | "replay.close"
        ) || (operation.action_id.as_str() == "session.close" && source.is_some());
        let auth = self.inner.auth.clone();
        let files = self.inner.files.clone();
        let reader = actor.clone();
        blocking(move || {
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
            if let Some(error) = operation.error.as_mut() {
                error.details = None;
            }
            if let Some(stamp) = &stamp {
                auth.validate_grants(stamp)?;
            }
            Ok((operation, input))
        })
        .await
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
        "replay.control" | "replay.close" => {} // Current rights on the persisted source were checked above.
        "file.register" => {
            if let Some(ActionResult::FileMetadata(metadata)) = &operation.result {
                files.require_inspection_reference(&metadata.file_ref, actor, "metadata.read")?;
            } else {
                auth.require(actor, "metadata.read", &operation.target)?;
            }
        }
        _ if replay => {}
        _ => {
            auth.require(actor, "metadata.read", &operation.target)?;
            if matches!(action, "session.tx" | "transfer.file")
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
                "file" | "capture" | "capture_record"
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
