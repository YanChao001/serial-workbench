use crate::host_bridge::DesktopHostBridge;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_client::{HostClient, RawConnection};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::time::Duration;

pub(super) struct ViewHost {
    bridge: DesktopHostBridge,
    window: String,
    generation: U64,
    attachment: AttachResult,
    operation: Target,
    view_id: Id,
    pub(super) entry: NodeViewAssetReadResult,
}

fn failure() -> HostError {
    HostError::new("PROTOCOL_ERROR", "Invalid plugin view response")
}

fn unpack(reply: RpcReply) -> HostResult<RpcResult> {
    match reply {
        RpcReply::Success { result, .. } => Ok(*result),
        RpcReply::Failure { error, .. } => Err(error),
    }
}

fn query(
    attachment: &AttachResult,
    target: Target,
    action: BuiltinAction,
    params: impl serde::Serialize,
) -> HostResult<Query> {
    Ok(Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: crate::host_bridge::local_request_id()?,
        action_id: action.spec().action_id.clone(),
        target,
        params: serde_json::from_value(serde_json::to_value(params).map_err(|_| failure())?)
            .map_err(|_| failure())?,
        reveal_target: action.spec().reveal_target.clone(),
    })
}

impl ViewHost {
    pub(super) async fn attach(
        bridge: DesktopHostBridge,
        window: String,
        generation: U64,
        operation_id: Id,
        view_id: Id,
    ) -> HostResult<Self> {
        let attachment = bridge.attachment_at_generation(&window, generation).await?;
        let operation = Target {
            host_id: attachment.host_id.clone(),
            kind: ResourceKind::try_from("operation")?,
            id: operation_id,
            session_id: None,
            session_epoch: None,
        };
        let request = query(
            &attachment,
            operation.clone(),
            BuiltinAction::NodeViewAssetRead,
            NodeViewAssetReadParams {
                view_id: view_id.clone(),
                offset: 0.into(),
                path: None,
            },
        )?;
        let RpcResult::Query(QueryResult::NodeViewAsset(entry)) = unpack(
            bridge
                .request_at_generation(&window, generation, RpcRequest::Query(request))
                .await?,
        )?
        else {
            return Err(failure());
        };
        if entry.view.id != view_id
            || entry.path != entry.entry
            || entry.offset.get() != 0
            || entry.target.kind.as_str() != "session"
            || entry.target.host_id != attachment.host_id
        {
            return Err(failure());
        }
        Ok(Self {
            bridge,
            window,
            generation,
            attachment,
            operation,
            view_id,
            entry: *entry,
        })
    }

    async fn page(
        &self,
        path: NodePackagePath,
        offset: U64,
    ) -> HostResult<NodeViewAssetReadResult> {
        let request = query(
            &self.attachment,
            self.operation.clone(),
            BuiltinAction::NodeViewAssetRead,
            NodeViewAssetReadParams {
                view_id: self.view_id.clone(),
                offset,
                path: Some(path.clone()),
            },
        )?;
        let RpcResult::Query(QueryResult::NodeViewAsset(page)) = unpack(
            self.bridge
                .request_at_generation(&self.window, self.generation, RpcRequest::Query(request))
                .await?,
        )?
        else {
            return Err(failure());
        };
        if page.activation_id != self.entry.activation_id
            || page.package_id != self.entry.package_id
            || page.archive_sha256 != self.entry.archive_sha256
            || page.version != self.entry.version
            || page.entry != self.entry.entry
            || page.view != self.entry.view
            || page.target != self.entry.target
            || page.path != path
            || page.offset != offset
        {
            return Err(failure());
        }
        Ok(*page)
    }

    pub(super) async fn authorize(&self) -> HostResult<()> {
        let page = self
            .page(self.entry.entry.clone(), self.entry.total_bytes)
            .await?;
        if page.total_bytes != self.entry.total_bytes
            || page.sha256 != self.entry.sha256
            || !page.bytes_base64.as_str().is_empty()
        {
            return Err(failure());
        }
        Ok(())
    }

    async fn sampling(&self) -> HostResult<bool> {
        let request = query(
            &self.attachment,
            self.operation.clone(),
            BuiltinAction::OperationGet,
            OperationGetParams::ById {
                operation_id: self.operation.id.clone(),
                request_context: None,
            },
        )?;
        let RpcResult::Operation(result) = unpack(
            self.bridge
                .request_at_generation(
                    &self.window,
                    self.generation,
                    RpcRequest::OperationGet(request),
                )
                .await?,
        )?
        else {
            return Err(failure());
        };
        if result.operation.operation_id != self.operation.id
            || result.operation.target != self.entry.target
        {
            return Err(failure());
        }
        Ok(result.operation.state == OperationState::Running)
    }

    pub(super) async fn snapshot(&self) -> HostResult<SessionSnapshot> {
        self.authorize().await?;
        let request = query(
            &self.attachment,
            self.entry.target.clone(),
            BuiltinAction::SessionGet,
            EmptyParams {},
        )?;
        let RpcResult::Query(QueryResult::Session(snapshot)) = unpack(
            self.bridge
                .request_at_generation(&self.window, self.generation, RpcRequest::Query(request))
                .await?,
        )?
        else {
            return Err(failure());
        };
        if self.entry.target.session_id.as_ref() != Some(&snapshot.session_id)
            || self.entry.target.session_epoch != Some(snapshot.session_epoch)
        {
            return Err(failure());
        }
        self.authorize().await?;
        Ok(snapshot)
    }

    pub(super) async fn asset(&self, path: NodePackagePath) -> HostResult<Vec<u8>> {
        let mut page = self.page(path.clone(), 0.into()).await?;
        let length = page.total_bytes.get();
        if length > 64 * 1024 * 1024 {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Plugin asset exceeds the display limit",
            ));
        }
        let digest = page.sha256.clone();
        let mut bytes = Vec::with_capacity(length as usize);
        loop {
            let chunk = STANDARD
                .decode(page.bytes_base64.as_str())
                .map_err(|_| failure())?;
            let remaining = length - bytes.len() as u64;
            if chunk.len() as u64 != remaining.min(NODE_VIEW_ASSET_CHUNK_BYTES as u64)
                || page.total_bytes.get() != length
                || page.sha256 != digest
            {
                return Err(failure());
            }
            bytes.extend(chunk);
            if bytes.len() as u64 == length {
                break;
            }
            page = self.page(path.clone(), (bytes.len() as u64).into()).await?;
        }
        if format!("{:x}", Sha256::digest(&bytes)) != digest.as_str() {
            return Err(HostError::new(
                "INTEGRITY_FAILED",
                "Plugin view asset changed",
            ));
        }
        self.authorize().await?;
        Ok(bytes)
    }

    pub(super) async fn subscribe(&self) -> HostResult<ViewReader> {
        let (connection, control) = self
            .bridge
            .connect_node_view_raw(&self.window, self.generation)
            .await?;
        let request = query(
            &self.attachment,
            self.entry.target.clone(),
            BuiltinAction::StreamCursor,
            EmptyParams {},
        )?;
        let RpcResult::Query(QueryResult::StreamCursor(reference)) =
            unpack(connection.request(RpcRequest::Query(request)).await?)?
        else {
            return Err(failure());
        };
        if reference.target != self.entry.target
            || reference.cursor.host_id != self.attachment.host_id
            || reference.cursor.instance_epoch != self.attachment.instance_epoch
        {
            return Err(failure());
        }
        // 从留存窗口开头恢复，保留 Host 报告的被覆盖前缀。
        let mut after = reference.cursor;
        after.position = 0.into();
        let beginning = after.clone();
        let credit = self
            .attachment
            .limits
            .max_reader_queue_bytes
            .get()
            .min(512 * 1024);
        for _ in 0..3 {
            let request = query(
                &self.attachment,
                self.entry.target.clone(),
                BuiltinAction::StreamSubscribe,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after: after.clone(),
                    queue_bytes: credit.into(),
                    initial_credit_bytes: credit.into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )?;
            let receipt = unpack(
                connection
                    .request(RpcRequest::StreamSubscribe(request))
                    .await?,
            );
            match receipt {
                Ok(RpcResult::Subscription(result)) => {
                    self.authorize().await?;
                    let gap = initial_gap(
                        &self.entry.target,
                        &result.subscription_id,
                        beginning,
                        &after,
                    )?;
                    return Ok(ViewReader {
                        connection,
                        _control: control,
                        subscription: result.subscription_id,
                        cursor: after,
                        window_bytes: credit,
                        granted: credit,
                        pending: false,
                        #[cfg(feature = "e2e")]
                        e2e_trace: None,
                        gap,
                    });
                }
                Err(error) if error.code == "CURSOR_EXPIRED" => {
                    let data = error.details.as_deref().ok_or_else(failure)?;
                    let oldest: Cursor = serde_json::from_value(
                        serde_json::to_value(data)
                            .map_err(|_| failure())?
                            .get("oldestCursor")
                            .cloned()
                            .ok_or_else(failure)?,
                    )
                    .map_err(|_| failure())?;
                    if !same_scope(&oldest, &after) || oldest.position <= after.position {
                        return Err(failure());
                    }
                    after = oldest;
                }
                Ok(_) => return Err(failure()),
                Err(error) => return Err(error),
            }
        }
        Err(HostError::new(
            "CURSOR_EXPIRED",
            "Retained window moved during view setup",
        ))
    }

    pub(super) async fn open_stream(&self) -> HostResult<ViewStream> {
        if self.entry.view.feed == Some(NodePackageViewFeed::Derived) {
            self.authorize().await?;
            Ok(ViewStream::Derived(DerivedReader { position: 0.into() }))
        } else {
            Ok(ViewStream::Raw(Box::new(self.subscribe().await?)))
        }
    }
}

pub(super) enum ViewStream {
    Raw(Box<ViewReader>),
    Derived(DerivedReader),
}

impl ViewStream {
    #[cfg(feature = "e2e")]
    pub(super) fn with_e2e_label(mut self, label: String) -> Self {
        if let Self::Raw(reader) = &mut self {
            reader.e2e_trace = Some(RawTrace {
                label,
                digest: Sha256::default(),
            });
        }
        self
    }

    pub(super) async fn next(&mut self, host: &ViewHost) -> HostResult<serde_json::Value> {
        match self {
            Self::Raw(reader) => reader
                .next(host)
                .await
                .map(|frame| serde_json::json!({"frame": frame})),
            Self::Derived(reader) => Ok(reader.next(host).await?.map_or(
                serde_json::Value::Null,
                |(previous, after, page)| {
                    serde_json::json!({"derived": {
                        "previousPosition": previous,
                        "after": after,
                        "reply": {"ok":true, "result": QueryResult::StreamDerivedRead(page)}
                    }})
                },
            )),
        }
    }
}

pub(super) struct DerivedReader {
    position: U64,
}

impl DerivedReader {
    async fn next(&mut self, host: &ViewHost) -> HostResult<Option<(U64, U64, DerivedReadResult)>> {
        host.authorize().await?;
        let mut after = self.position;
        let waiting_for_first_sample = after.get() == 0 && host.sampling().await?;
        for _ in 0..3 {
            let request = query(
                &host.attachment,
                host.entry.target.clone(),
                BuiltinAction::StreamDerivedRead,
                DerivedReadParams {
                    operation_id: host.operation.id.clone(),
                    after,
                    max_samples: 32.into(),
                    max_bytes: (DERIVED_PAGE_MAX_BYTES as u64).into(),
                },
            )?;
            let reply = host
                .bridge
                .raw_request_at_generation(
                    &host.window,
                    host.generation,
                    RpcRequest::Query(request),
                )
                .await?;
            match unpack(reply) {
                Ok(RpcResult::Query(QueryResult::StreamDerivedRead(page))) => {
                    let count = page.samples.len() as u64;
                    if page.operation_id != host.operation.id
                        || page.instance_epoch != host.attachment.instance_epoch
                        || after.get().checked_add(count) != Some(page.next_position.get())
                        || (count == 0 && page.has_more)
                    {
                        return Err(failure());
                    }
                    host.authorize().await?;
                    if count == 0 {
                        return Ok(None);
                    }
                    let previous = self.position;
                    self.position = page.next_position;
                    return Ok(Some((previous, after, page)));
                }
                Err(error) if error.code == "NOT_FOUND" && waiting_for_first_sample => {
                    return Ok(None);
                }
                Err(error) if error.code == "CURSOR_EXPIRED" => {
                    let Some(oldest) = error
                        .details
                        .as_deref()
                        .and_then(|details| details.get("oldestPosition"))
                        .and_then(|value| serde_json::to_value(value).ok())
                        .and_then(|value| serde_json::from_value::<U64>(value).ok())
                    else {
                        return Err(error);
                    };
                    let Some(current) = oldest
                        .get()
                        .checked_sub(1)
                        .filter(|position| *position > after.get())
                    else {
                        return Err(failure());
                    };
                    after = current.into();
                }
                Err(error) => return Err(error),
                Ok(_) => return Err(failure()),
            }
        }
        Err(HostError::new(
            "CURSOR_EXPIRED",
            "Derived view retention moved during pagination",
        ))
    }
}

pub(super) struct ViewReader {
    connection: RawConnection,
    _control: HostClient,
    subscription: Id,
    cursor: Cursor,
    window_bytes: u64,
    granted: u64,
    pending: bool,
    #[cfg(feature = "e2e")]
    e2e_trace: Option<RawTrace>,
    gap: Option<WireFrame>,
}

#[cfg(feature = "e2e")]
struct RawTrace {
    label: String,
    digest: Sha256,
}

impl ViewReader {
    async fn credit(&self, host: &ViewHost, granted: u64) -> HostResult<StreamCreditResult> {
        let request = query(
            &host.attachment,
            host.entry.target.clone(),
            BuiltinAction::StreamCredit,
            StreamCreditParams {
                subscription_id: self.subscription.clone(),
                ack_cursor: self.cursor.clone(),
                granted_bytes_total: granted.into(),
            },
        )?;
        let RpcResult::StreamCredit(result) = unpack(
            self.connection
                .request(RpcRequest::StreamCredit(request))
                .await?,
        )?
        else {
            return Err(failure());
        };
        if result.ack_cursor != self.cursor
            || result.granted_bytes_total.get() != granted
            || result.acknowledged_bytes_total > result.sent_bytes_total
            || result.sent_bytes_total.get() > granted
        {
            return Err(failure());
        }
        Ok(result)
    }

    pub(super) async fn next(&mut self, host: &ViewHost) -> HostResult<Option<WireFrame>> {
        host.authorize().await?;
        if let Some(gap) = self.gap.take() {
            return Ok(Some(gap));
        }
        if self.pending {
            let receipt = self.credit(host, self.granted).await?;
            #[cfg(feature = "e2e")]
            if let Some(trace) = &self.e2e_trace {
                super::trace_terminal_view(
                    &trace.label,
                    "ack",
                    receipt.ack_cursor.position.get(),
                    0,
                    None,
                );
            }
            let next = receipt
                .acknowledged_bytes_total
                .get()
                .checked_add(self.window_bytes)
                .ok_or_else(failure)?;
            if next > self.granted {
                self.credit(host, next).await?;
                self.granted = next;
            }
            self.pending = false;
        }
        let frame =
            match tokio::time::timeout(Duration::from_millis(300), self.connection.next_event())
                .await
            {
                Err(_) => return Ok(None),
                Ok(reply) => reply?.ok_or_else(|| {
                    HostError::new("BACKEND_DISCONNECTED", "Raw view connection closed")
                })?,
            };
        match &frame.body {
            IpcMessage::RawBatch { batch }
                if batch.subscription_id == self.subscription
                    && batch.previous_cursor == self.cursor
                    && same_scope(&batch.cursor, &self.cursor)
                    && batch.cursor.position > self.cursor.position =>
            {
                host.authorize().await?;
                self.cursor = batch.cursor.clone();
                self.pending = true;
                #[cfg(feature = "e2e")]
                self.trace_rx(batch);
            }
            IpcMessage::SubscriptionEnded {
                subscription_id, ..
            } if subscription_id == &self.subscription => {}
            _ => return Err(failure()),
        }
        Ok(Some(frame))
    }

    #[cfg(feature = "e2e")]
    fn trace_rx(&mut self, batch: &RawBatch) {
        let Some(trace) = &mut self.e2e_trace else {
            return;
        };
        let bytes: usize = batch
            .items
            .iter()
            .filter_map(|item| {
                let StreamItem::Source { event } = item else {
                    return None;
                };
                let RawPayload::Rx(rx) = &event.payload else {
                    return None;
                };
                STANDARD.decode(rx.bytes_base64.as_str()).ok()
            })
            .map(|value| {
                trace.digest.update(&value);
                value.len()
            })
            .sum();
        if bytes != 0 {
            let digest = format!("{:x}", trace.digest.clone().finalize());
            super::trace_terminal_view(
                &trace.label,
                "rx",
                batch.cursor.position.get(),
                bytes,
                Some(&digest),
            );
        }
    }
}

fn same_scope(left: &Cursor, right: &Cursor) -> bool {
    left.host_id == right.host_id
        && left.instance_epoch == right.instance_epoch
        && left.scope_id == right.scope_id
}

fn initial_gap(
    target: &Target,
    subscription: &Id,
    previous: Cursor,
    after: &Cursor,
) -> HostResult<Option<WireFrame>> {
    if previous.position == after.position {
        return Ok(None);
    }
    let gap = ReaderGap {
        host_id: after.host_id.clone(),
        instance_epoch: after.instance_epoch,
        session_id: target.session_id.clone().ok_or_else(failure)?,
        session_epoch: target.session_epoch.ok_or_else(failure)?,
        reason: ReaderGapReason::ReaderOverflow,
        missing_event_range: ByteRange {
            start: previous
                .position
                .get()
                .checked_add(1)
                .ok_or_else(failure)?
                .into(),
            end: after
                .position
                .get()
                .checked_add(1)
                .ok_or_else(failure)?
                .into(),
        },
        missing_byte_ranges: None,
    };
    Ok(Some(WireFrame {
        request_id: crate::host_bridge::local_request_id()?,
        channel: IpcChannel::Raw,
        body: IpcMessage::RawBatch {
            batch: Box::new(RawBatch {
                subscription_id: subscription.clone(),
                cursor: after.clone(),
                previous_cursor: previous,
                items: vec![StreamItem::ReaderGap { gap }],
            }),
        },
    }))
}
