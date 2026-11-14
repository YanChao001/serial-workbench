use super::*;
impl TransmissionService {
    pub(super) async fn control_action(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Arc<Runtime>,
        configuration_change: &mut Option<ConfigurationChange>,
    ) -> HostResult<Completion> {
        let action = accepted.call.action_id.as_str();
        if action == "session.close" {
            if let Err(error) = self.dispatch(accepted, token, session).await {
                runtime.closing.store(false, Ordering::SeqCst);
                runtime.changed.notify_waiters();
                return Err(error);
            }
            {
                let mut state = session.snapshot.lock().map_err(|_| invalid())?;
                state.state = SessionState::Closing;
                if state.tx_gate != TxGate::ControlUnknown {
                    state.tx_gate = TxGate::Closing;
                }
                state.revision = state.revision.checked_next()?;
            }
            self.devices.persist(session).await?;
            loop {
                let wake = self.ready.notified();
                let remaining = {
                    let tokens = self.tokens.lock().map_err(|_| invalid())?;
                    tokens
                        .values()
                        .filter(|other| {
                            other.session_id.as_ref() == Some(&accepted.call.target.id)
                                && !other.is_close
                        })
                        .map(|other| {
                            other.cancel();
                            1usize
                        })
                        .sum::<usize>()
                };
                if remaining == 0 && self.admissions.load(Ordering::SeqCst) == 0 {
                    break;
                }
                tokio::select! {_=wake=>{},_=tokio::time::sleep(Duration::from_millis(20))=>{}}
            }
            session.close().await?;
            {
                let mut state = session.snapshot.lock().map_err(|_| invalid())?;
                state.revision = state.revision.checked_next()?;
            }
            self.devices.persist(session).await?;
            return Ok(Completion::success(ActionResult::Session(
                session.snapshot()?,
            )));
        }
        if action == "tx.waitBoundary" {
            return self.wait_boundary(accepted, token, session, runtime).await;
        }
        if action == "session.purge" {
            return self.purge(accepted, token, session, runtime).await;
        }
        if action == "session.takeover" {
            return self.takeover(accepted, token, session, runtime).await;
        }
        let _turn = self
            .acquire(accepted, token, session, runtime, 0, None)
            .await?;
        self.dispatch(accepted, token, session).await?;
        match action {
            "session.configure" => {
                self.configure(accepted, token, session, runtime, configuration_change)
                    .await
            }
            "session.control" => {
                let params: ControlParams = decode(&accepted.call.params)?;
                let snapshot = session.snapshot()?;
                if (params.line == ControlLine::Rts
                    && snapshot.configuration.flow_control == FlowControl::RtsCts)
                    || (params.line == ControlLine::Dtr
                        && snapshot.configuration.flow_control == FlowControl::DsrDtr)
                {
                    return Err(HostError::new(
                        "CONTROL_CONFLICT",
                        "Flow control owns this line",
                    ));
                }
                match session
                    .control(
                        ControlCommand::SetLine {
                            line: params.line,
                            value: params.value,
                        },
                        Some(self.backend_admission(accepted, token, runtime)),
                    )
                    .await
                {
                    Ok(ControlResult::Line { line, value }) if line == params.line => {
                        Ok(Completion::success(ActionResult::Control(ControlReceipt {
                            line,
                            requested: params.value,
                            status: ControlStatus::Confirmed,
                            actual: Some(value),
                        })))
                    }
                    Ok(_) => Err(invalid()),
                    Err(error) => Err(*error.error),
                }
            }
            "session.break" => self.break_signal(accepted, token, session, runtime).await,
            "session.setReadOnly" => {
                let params: SetReadOnlyParams = decode(&accepted.call.params)?;
                {
                    let mut state = session.snapshot.lock().map_err(|_| invalid())?;
                    state.read_only = params.read_only;
                    state.revision = state.revision.checked_next()?;
                }
                self.devices.persist(session).await?;
                Ok(Completion::success(ActionResult::Session(
                    session.snapshot()?,
                )))
            }
            "tx.drain" => {
                let params: DrainParams = decode(&accepted.call.params)?;
                match session
                    .drain(
                        DrainRequest {
                            wait: Duration::from_millis(params.write_wait_ms.get()),
                            cancelled: token.cancelled.clone(),
                            closing: session.closing.clone(),
                        },
                        self.backend_admission(accepted, token, runtime),
                    )
                    .await
                {
                    Ok(ControlResult::Drained { status, error }) => {
                        if status == ControlStatus::Unknown {
                            session.snapshot.lock().map_err(|_| invalid())?.tx_gate =
                                TxGate::ControlUnknown;
                            self.devices.persist(session).await?;
                        }
                        Ok(Completion {
                            state: match status {
                                ControlStatus::Confirmed => OperationState::Succeeded,
                                ControlStatus::Failed => OperationState::Failed,
                                ControlStatus::Unknown => OperationState::Unknown,
                            },
                            result: ActionResult::Drained(DrainReceipt { status }),
                            error,
                        })
                    }
                    Ok(_) => Err(invalid()),
                    Err(error) => Err(*error.error),
                }
            }
            _ => Err(invalid()),
        }
    }
    async fn purge(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Arc<Runtime>,
    ) -> HostResult<Completion> {
        let params: PurgeParams = decode(&accepted.call.params)?;
        self.dispatch(accepted, token, session).await?;
        let mut receipt = PurgeReceipt {
            direction: params.direction,
            scope: params.scope,
            outcome: PurgeOutcome::Completed,
            affected_operation_ids: vec![],
            ranges: vec![],
            unknown_extent: false,
        };
        if matches!(params.scope, PurgeScope::Application | PurgeScope::Both)
            && matches!(params.direction, PurgeDirection::Tx | PurgeDirection::Both)
        {
            // 在同一队列锁下只取消尚未成为 active 的 TX，避免把已提交驱动的写当成应用队列。
            let queue = runtime.queue.lock().map_err(|_| invalid())?;
            let tokens = self.tokens.lock().map_err(|_| invalid())?;
            for entry in &queue.entries {
                if let Some(other) = tokens.get(&entry.id).filter(|other| other.is_tx) {
                    other.cancel();
                    receipt.affected_operation_ids.push(entry.id.clone());
                }
            }
        }
        let mut error = self
            .wait_control_settlement(&receipt.affected_operation_ids)
            .await
            .err();
        if error.is_some() {
            receipt.outcome = PurgeOutcome::Unknown;
        }
        let mut _driver_turn = None;
        if params.scope != PurgeScope::Application && error.is_none() {
            let ready = async {
                _driver_turn = Some(
                    self.acquire(accepted, token, session, runtime, 0, None)
                        .await?,
                );
                if token.cancelled.load(Ordering::SeqCst) {
                    return Err(cancelled());
                }
                self.require_token(accepted, token).await?;
                self.gate(session, accepted)
            }
            .await;
            match ready {
                Err(failure) => {
                    // 应用队列的终结已经发生，即使驱动阶段未开始也保留这些事实。
                    receipt.outcome = PurgeOutcome::Partial;
                    error = Some(failure);
                }
                Ok(()) => {
                    match session
                        .control(
                            ControlCommand::Purge {
                                direction: params.direction,
                            },
                            Some(self.backend_admission(accepted, token, runtime)),
                        )
                        .await
                    {
                        Ok(ControlResult::Purged {
                            ranges,
                            unknown_extent,
                        }) => {
                            receipt.ranges = ranges;
                            receipt.unknown_extent = unknown_extent;
                        }
                        Ok(_) => {
                            receipt.unknown_extent = true;
                            error = Some(invalid());
                        }
                        Err(backend) => {
                            receipt.unknown_extent = true;
                            error = Some(*backend.error);
                        }
                    }
                    receipt.outcome = if receipt.unknown_extent {
                        PurgeOutcome::Unknown
                    } else {
                        PurgeOutcome::Completed
                    };
                    self.purge_gaps(session, &receipt)?;
                }
            }
        }
        // RX 没有独立的应用待处理队列；应用 purge 不删源历史，也不触发驱动。
        session.source.append_boundary(
            self.devices.meta(session)?,
            SourceBoundary::Control(object(&receipt)?),
        )?;
        Ok(Completion {
            state: if error.is_some() {
                OperationState::Unknown
            } else {
                OperationState::Succeeded
            },
            result: ActionResult::Purged(receipt),
            error,
        })
    }
    async fn wait_control_settlement(&self, ids: &[Id]) -> HostResult<()> {
        loop {
            let wake = self.ready.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            if !self
                .tokens
                .lock()
                .map_err(|_| invalid())?
                .keys()
                .any(|id| ids.contains(id))
            {
                break;
            }
            wake.await;
        }
        let store = self.devices.inner.store.clone();
        let ids = ids.to_vec();
        blocking(move || {
            for id in ids {
                if !store.operation_state(&id)?.is_terminal() {
                    return Err(HostError::new(
                        "OWNER_UNAVAILABLE",
                        "Operation owner did not retain a terminal settlement",
                    ));
                }
            }
            Ok(())
        })
        .await
    }
    fn purge_gaps(&self, session: &Session, receipt: &PurgeReceipt) -> HostResult<()> {
        for range in &receipt.ranges {
            session.source.append_boundary(
                self.devices.meta(session)?,
                SourceBoundary::Gap(SourceGap {
                    reason: SourceGapReason::Purge,
                    known_extent: true,
                    missing_event_range: None,
                    missing_byte_range: Some(range.clone()),
                    direction: Some(range.direction),
                }),
            )?;
        }
        if receipt.unknown_extent {
            session.source.append_boundary(
                self.devices.meta(session)?,
                SourceBoundary::Gap(SourceGap {
                    reason: SourceGapReason::Purge,
                    known_extent: false,
                    missing_event_range: None,
                    missing_byte_range: None,
                    direction: match receipt.direction {
                        PurgeDirection::Rx => Some(Direction::Rx),
                        PurgeDirection::Tx => Some(Direction::Tx),
                        PurgeDirection::Both => None,
                    },
                }),
            )?;
        }
        Ok(())
    }
    async fn configure(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Runtime,
        configuration_change: &mut Option<ConfigurationChange>,
    ) -> HostResult<Completion> {
        let params: ConfigureParams = decode(&accepted.call.params)?;
        let requested = object(&params.requested)?;
        {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            if state.tx_gate != TxGate::ControlUnknown {
                state.tx_gate = TxGate::ConfigurationPending;
            }
        }
        // 在可能部分修改硬件前保留未确认状态；错误不能被解释成未应用。
        self.devices.persist(session).await?;
        let change = configuration_change.insert(
            session
                .configure(
                    params.requested.clone(),
                    self.backend_admission(accepted, token, runtime),
                )
                .await,
        );
        let (mut application, error) = match change.take_result() {
            Ok(application) => (application, None),
            Err(error) => (
                ConfigApplication {
                    fields: vec![],
                    readback: JsonObject::default(),
                },
                Some(*error.error),
            ),
        };
        for field in requested.keys() {
            if !application.fields.iter().any(|value| &value.field == field) {
                application.fields.push(ConfigField {
                    field: field.clone(),
                    status: FieldStatus::Unknown,
                    actual: None,
                });
            }
        }
        let all = requested.iter().all(|(key, value)| {
            application
                .fields
                .iter()
                .any(|field| &field.field == key && field.status == FieldStatus::Applied)
                && application.readback.get(key) == Some(value)
        });
        let unknown = application
            .fields
            .iter()
            .any(|field| field.status == FieldStatus::Unknown);
        let (revision, gate) = {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            state.revision = state.revision.checked_next()?;
            state.configuration_revision = state.revision;
            if state.tx_gate != TxGate::ControlUnknown {
                state.tx_gate = if all {
                    TxGate::Ready
                } else {
                    TxGate::ConfigurationPending
                };
            }
            (state.revision, state.tx_gate)
        };
        let boundary = session.source.append_boundary(
            self.devices.meta(session)?,
            SourceBoundary::Configuration(ConfigurationBoundary {
                revision,
                certainty: if all {
                    Certainty::Confirmed
                } else {
                    Certainty::Uncertain
                },
                receipt_ref: ObjectRef {
                    host_id: accepted.operation.execution_host_id.clone(),
                    kind: ResourceKind::try_from("operation")?,
                    id: accepted.operation.operation_id.clone(),
                    revision: None,
                },
            }),
        );
        let boundary = match boundary {
            Ok(boundary) => boundary,
            Err(error) => {
                change.stop();
                self.fail_configuration(session, &error).await;
                return Err(error);
            }
        };
        if all {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            state.configuration = params.requested.clone();
        }
        if let Err(error) = self.devices.persist(session).await {
            change.stop();
            self.fail_configuration(session, &error).await;
            return Err(error);
        }
        Ok(Completion {
            state: if unknown {
                OperationState::Unknown
            } else {
                OperationState::Succeeded
            },
            result: ActionResult::Configuration(ConfigReceipt {
                requested: params.requested,
                fields: application.fields,
                readback: application.readback,
                revision,
                boundary_event_seq: boundary,
                tx_gate: gate,
            }),
            error,
        })
    }
    pub(super) async fn fail_configuration(&self, session: &Session, error: &HostError) {
        if let Ok(mut state) = session.snapshot.lock()
            && state.tx_gate != TxGate::ControlUnknown
        {
            if state.tx_gate != TxGate::ConfigurationPending
                && let Ok(revision) = state.revision.checked_next()
            {
                state.revision = revision;
            }
            state.tx_gate = TxGate::ConfigurationPending;
        }
        // 首因留在源流；guard 释放后不能发布没有配置结果边界的 RX。
        let _ = session.source.fail(error.clone());
        let _ = self.devices.persist(session).await;
    }
    async fn break_signal(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Runtime,
    ) -> HostResult<Completion> {
        let params: BreakParams = decode(&accepted.call.params)?;
        deadline(self.now(), params.duration_ms, 2147483647)?;
        {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            if !state.capabilities.finite_break {
                return Err(HostError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Finite BREAK is not supported",
                ));
            }
            state.control_state = ControlState::Asserting;
            state.tx_gate = TxGate::ControlUnknown;
        }
        // 清线责任先持久化。assert失败、撤权和取消同样必须尝试clear。
        self.devices.persist(session).await?;
        let assert = transition(
            session
                .control(
                    ControlCommand::AssertBreak,
                    Some(self.backend_admission(accepted, token, runtime)),
                )
                .await,
            true,
            self.devices.inner.clock.wall_time(),
        );
        let end = deadline(self.now(), params.duration_ms, 2147483647)?;
        let mut interruption = None;
        if assert.status == ControlStatus::Confirmed {
            session
                .snapshot
                .lock()
                .map_err(|_| invalid())?
                .control_state = ControlState::Asserted;
            let mut grants = self.devices.inner.auth.subscribe_changes();
            loop {
                if token.cancelled.load(Ordering::SeqCst) {
                    interruption = Some(cancelled());
                    break;
                }
                if let Err(error) = self.require_token(accepted, token).await {
                    interruption = Some(error);
                    break;
                }
                if let Err(error) = self.check_lease(runtime, accepted) {
                    interruption = Some(error);
                    break;
                }
                if self.now() >= end {
                    break;
                }
                let wake_at = runtime
                    .lease
                    .lock()
                    .map_err(|_| invalid())?
                    .as_ref()
                    .filter(|lease| accepted.call.lease_id.as_ref() == Some(&lease.lease_id))
                    .map_or(end, |lease| end.min(lease.expires_at_mono_ns.get()));
                tokio::select! {
                    _ = token.wake.notified() => {},
                    _ = runtime.changed.notified() => {},
                    _ = grants.changed() => {},
                    _ = self.devices.inner.auth.wait_grant_expiry(token.grant_stamp.as_ref()) => {},
                    _ = crate::clock::wait_until(self.devices.inner.clock.as_ref(), wake_at) => {},
                }
            }
        }
        session
            .snapshot
            .lock()
            .map_err(|_| invalid())?
            .control_state = ControlState::Clearing;
        let clear = transition(
            session.control(ControlCommand::ClearBreak, None).await,
            false,
            self.devices.inner.clock.wall_time(),
        );
        {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            state.control_state = if clear.status == ControlStatus::Confirmed {
                ControlState::Clear
            } else {
                ControlState::Unknown
            };
            state.tx_gate = if clear.status == ControlStatus::Confirmed {
                TxGate::Ready
            } else {
                TxGate::ControlUnknown
            };
            state.revision = state.revision.checked_next()?;
        }
        self.devices.persist(session).await?;
        let state = if clear.status != ControlStatus::Confirmed
            || assert.status == ControlStatus::Unknown
        {
            OperationState::Unknown
        } else if clear.status != ControlStatus::Confirmed
            || assert.status != ControlStatus::Confirmed
        {
            OperationState::Failed
        } else if interruption.is_some() || token.cancelled.load(Ordering::SeqCst) {
            OperationState::Cancelled
        } else {
            OperationState::Succeeded
        };
        Ok(Completion {
            state,
            result: ActionResult::Break(BreakReceipt { assert, clear }),
            error: interruption,
        })
    }
    async fn wait_boundary(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        _runtime: &Runtime,
    ) -> HostResult<Completion> {
        let params: WaitBoundaryParams = decode(&accepted.call.params)?;
        let end = deadline(token.accepted_mono_ns, params.queue_wait_ms, 2147483647)?;
        let store = self.devices.inner.store.clone();
        let target = accepted.call.target.clone();
        let anchor = params.through_operation_id.clone();
        #[cfg(test)]
        {
            let gate = self.boundary_gap.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        let tokens = self.tokens.clone();
        let through = blocking(move || {
            // 在同一 blocking 协调中保留现有 owner 锁直到 SQL 捕获完成。
            // 未 track 的前缀不能在两次拍照之间穿越到 terminal；已 track
            // 的 owner 即使此时持久终态，仍会由有界 IDs 纳入固定前缀。
            let owners = tokens.lock().map_err(|_| invalid())?;
            let ids = owners.keys().cloned().collect();
            let captured = store.boundary_operations(&target, &anchor, ids);
            drop(owners);
            captured
        })
        .await?;
        self.dispatch(accepted, token, session).await?;
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if token.cancelled.load(Ordering::SeqCst) {
                return Ok(Completion {
                    state: OperationState::Cancelled,
                    result: ActionResult::Boundary(WaitBoundaryReceipt {
                        through_operation_id: params.through_operation_id,
                    }),
                    error: None,
                });
            }
            let store = self.devices.inner.store.clone();
            let ids = through.clone();
            let durable = blocking(move || {
                ids.iter()
                    .map(|id| store.operation_state(id))
                    .collect::<HostResult<Vec<_>>>()
            })
            .await?;
            let waiting = durable.iter().any(|state| !state.is_terminal())
                || self
                    .tokens
                    .lock()
                    .map_err(|_| invalid())?
                    .keys()
                    .any(|id| through.contains(id));
            if !waiting {
                return Ok(Completion::success(ActionResult::Boundary(
                    WaitBoundaryReceipt {
                        through_operation_id: params.through_operation_id,
                    },
                )));
            }
            if self.now() >= end {
                return Err(HostError::new("QUEUE_TIMEOUT", "Boundary wait expired"));
            }
            tokio::select! {
                _ = &mut ready => {},
                _ = token.wake.notified() => {},
                _ = crate::clock::wait_until(self.devices.inner.clock.as_ref(), end) => {},
            }
        }
    }
    async fn takeover(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Runtime,
    ) -> HostResult<Completion> {
        let params: TakeoverParams = decode(&accepted.call.params)?;
        self.dispatch(accepted, token, session).await?;
        let mut affected = {
            let tokens = self.tokens.lock().map_err(|_| invalid())?;
            tokens
                .iter()
                .filter(|(id, other)| {
                    *id != &accepted.operation.operation_id
                        && other.actor_id == params.actor_id
                        && other.session_id.as_ref() == Some(&accepted.call.target.id)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        let auth = self.devices.inner.auth.clone();
        let actor = accepted.actor.clone();
        let target = accepted.call.target.clone();
        let target_actor = params.actor_id.clone();
        blocking(move || {
            auth.revoke(
                &actor,
                RevokeParams {
                    actor_id: target_actor,
                    permissions: vec!["device.modify".into()],
                    targets: vec![target],
                },
            )
        })
        .await?;
        // 撤权先阻止新写；token 在 Store 真实结算之后才释放，不能只等调度队列空。
        loop {
            let wake = self.ready.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let remaining = {
                let tokens = self.tokens.lock().map_err(|_| invalid())?;
                let mut remaining = 0;
                for (id, other) in tokens.iter().filter(|(id, other)| {
                    *id != &accepted.operation.operation_id
                        && other.actor_id == params.actor_id
                        && other.session_id.as_ref() == Some(&accepted.call.target.id)
                }) {
                    if !affected.contains(id) {
                        affected.push(id.clone());
                    }
                    other.cancel();
                    remaining += 1;
                }
                remaining
            };
            if remaining == 0 && self.admissions.load(Ordering::SeqCst) == 0 {
                break;
            }
            tokio::select! { _ = &mut wake => {}, _ = tokio::time::sleep(Duration::from_millis(20)) => {} }
        }
        let mut error = self.wait_control_settlement(&affected).await.err();
        let store = self.devices.inner.store.clone();
        let ids = affected.clone();
        let unknown = blocking(move || {
            for id in ids {
                if store.operation_state(&id)? == OperationState::Unknown {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .await;
        let snapshot = session.snapshot()?;
        let unsettled_lease = runtime
            .lease
            .lock()
            .map_err(|_| invalid())?
            .as_ref()
            .is_some_and(|lease| {
                lease.actor_id == params.actor_id
                    && matches!(lease.state, LeaseState::Active | LeaseState::Revoking)
            });
        let isolated = snapshot.tx_gate == TxGate::ControlUnknown
            || snapshot.control_state != ControlState::Clear;
        match unknown {
            Err(failure) => {
                error = Some(failure);
            }
            Ok(true) if error.is_none() => {
                error = Some(HostError::new(
                    "CONTROL_UNKNOWN",
                    "Target operation has an unknown settlement",
                ));
            }
            _ => {}
        }
        if isolated || unsettled_lease {
            error.get_or_insert_with(|| {
                HostError::new(
                    "CONTROL_UNKNOWN",
                    "Target cleanup requires confirmed recovery",
                )
            });
        }
        if error.is_some() && snapshot.tx_gate != TxGate::ControlUnknown {
            {
                let mut state = session.snapshot.lock().map_err(|_| invalid())?;
                state.tx_gate = TxGate::ControlUnknown;
                state.revision = state.revision.checked_next()?;
            }
            self.devices.persist(session).await?;
        }
        affected.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Ok(Completion {
            state: if error.is_some() {
                OperationState::Unknown
            } else {
                OperationState::Succeeded
            },
            result: ActionResult::Takeover(TakeoverReceipt {
                affected_operation_ids: affected,
            }),
            error,
        })
    }
}
fn transition(
    result: BackendResult<ControlResult>,
    asserted: bool,
    at: Timestamp,
) -> ControlTransition {
    match result {
        Ok(ControlResult::Break { asserted: value }) if value == asserted => ControlTransition {
            status: ControlStatus::Confirmed,
            at,
            error: None,
        },
        Ok(_) => ControlTransition {
            status: ControlStatus::Unknown,
            at,
            error: Some(invalid()),
        },
        Err(error) => ControlTransition {
            status: ControlStatus::Failed,
            at,
            error: Some(*error.error),
        },
    }
}
