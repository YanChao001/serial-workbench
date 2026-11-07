use super::*;
impl TransmissionService {
    pub(super) fn check_lease(&self, runtime: &Runtime, accepted: &AcceptedCall) -> HostResult<()> {
        if let Some(id) = &accepted.call.lease_id {
            let current = runtime.lease.lock().map_err(|_| invalid())?;
            let lease = current
                .as_ref()
                .filter(|lease| {
                    &lease.lease_id == id
                        && lease.actor_id == accepted.operation.actor_id
                        && Some(lease.session_epoch) == accepted.call.target.session_epoch
                })
                .ok_or_else(expired)?;
            if lease.state != LeaseState::Active || self.now() >= lease.expires_at_mono_ns.get() {
                return Err(expired());
            }
        }
        Ok(())
    }
    pub(super) async fn lease_action(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Arc<Runtime>,
    ) -> HostResult<Completion> {
        match accepted.call.action_id.as_str() {
            "lease.acquire" => {
                let params: LeaseAcquireParams = decode(&accepted.call.params)?;
                let expires_at = deadline(token.accepted_mono_ns, params.ttl_ms, 30000)?;
                if self.now() >= expires_at {
                    return Err(expired());
                }
                let turn = self
                    .acquire(accepted, token, session, runtime, 0, None)
                    .await?;
                // 前一租约的 owner 保存终态后，后继才能覆盖该租约槽。
                loop {
                    let previous = runtime.lease.lock().map_err(|_| invalid())?.clone();
                    if previous.as_ref().is_none_or(|lease| {
                        !self
                            .tokens
                            .lock()
                            .is_ok_and(|tokens| tokens.contains_key(&lease.owner_operation_id))
                    }) {
                        break;
                    }
                    if token.cancelled.load(Ordering::SeqCst) {
                        return Err(cancelled());
                    }
                    tokio::select! {_=self.ready.notified()=>{},_=tokio::time::sleep(Duration::from_millis(20))=>{}}
                }
                if self.now() >= expires_at {
                    return Err(expired());
                }
                self.dispatch(accepted, token, session).await?;
                let snapshot = session.snapshot()?;
                let lease = Lease {
                    lease_id: new_id(),
                    session_id: snapshot.session_id,
                    session_epoch: snapshot.session_epoch,
                    actor_id: accepted.operation.actor_id.clone(),
                    owner_operation_id: accepted.operation.operation_id.clone(),
                    kind: match params.kind {
                        ExplicitLeaseKind::Transaction => LeaseKind::Transaction,
                        ExplicitLeaseKind::Exclusive => LeaseKind::Exclusive,
                    },
                    state: LeaseState::Active,
                    execution_mode: accepted.operation.execution_mode,
                    expires_at_mono_ns: expires_at.into(),
                };
                {
                    let _transition = runtime.lease_transition.lock().await;
                    if self.now() >= expires_at {
                        return Err(expired());
                    }
                    *runtime.lease.lock().map_err(|_| invalid())? = Some(lease.clone());
                    self.devices
                        .publish_lease(session, Some(lease.clone()))
                        .await?;
                    let store = self.devices.inner.store.clone();
                    let id = accepted.operation.operation_id.clone();
                    let evidence = ActionResult::Lease(lease.clone());
                    blocking(move || store.record_result_evidence(&id, &evidence)).await?;
                }
                drop(turn);
                runtime.changed.notify_waiters();
                let mut grants = self.devices.inner.auth.subscribe_changes();
                let mut authorization_valid = self.require_token(accepted, token).await.is_ok();
                loop {
                    let changed = runtime.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    let current = runtime
                        .lease
                        .lock()
                        .map_err(|_| invalid())?
                        .clone()
                        .filter(|v| v.lease_id == lease.lease_id)
                        .ok_or_else(expired)?;
                    if matches!(current.state, LeaseState::Released | LeaseState::Expired) {
                        return self.lease_completion(session, current, OperationState::Succeeded);
                    }
                    let is_cancelled = token.cancelled.load(Ordering::SeqCst);
                    if is_cancelled
                        || !authorization_valid
                        || self.now() >= current.expires_at_mono_ns.get()
                    {
                        let result = self
                            .revoke_lease(session, runtime, &lease.lease_id, LeaseState::Expired)
                            .await?;
                        return self.lease_completion(
                            session,
                            result,
                            if is_cancelled || !authorization_valid {
                                OperationState::Cancelled
                            } else {
                                OperationState::Succeeded
                            },
                        );
                    }
                    tokio::select! {
                        _=&mut changed=>{},
                        _=token.wake.notified()=>{},
                        _=crate::clock::wait_until(self.devices.inner.clock.as_ref(),current.expires_at_mono_ns.get())=>{},
                        _=self.devices.inner.auth.wait_grant_expiry(token.grant_stamp.as_ref())=>{authorization_valid=false;},
                        result=grants.changed()=>{authorization_valid=result.is_ok() && self.require_token(accepted,token).await.is_ok();}
                    }
                }
            }
            "lease.renew" => {
                let params: LeaseRenewParams = decode(&accepted.call.params)?;
                let expires_at = deadline(token.accepted_mono_ns, params.ttl_ms, 30000)?;
                if self.now() >= expires_at {
                    return Err(expired());
                }
                self.dispatch(accepted, token, session).await?;
                let _transition = runtime.lease_transition.lock().await;
                let lease = {
                    let mut slot = runtime.lease.lock().map_err(|_| invalid())?;
                    let lease = slot
                        .as_mut()
                        .filter(|lease| {
                            lease.lease_id == params.lease_id
                                && lease.actor_id == accepted.operation.actor_id
                        })
                        .ok_or_else(expired)?;
                    if lease.state != LeaseState::Active
                        || self.now() >= lease.expires_at_mono_ns.get()
                        || self.now() >= expires_at
                    {
                        return Err(expired());
                    }
                    lease.expires_at_mono_ns = expires_at.into();
                    lease.clone()
                };
                self.devices
                    .publish_lease(session, Some(lease.clone()))
                    .await?;
                runtime.changed.notify_waiters();
                Ok(Completion::success(ActionResult::Lease(lease)))
            }
            "lease.release" => {
                let params: LeaseReleaseParams = decode(&accepted.call.params)?;
                let lease = runtime
                    .lease
                    .lock()
                    .map_err(|_| invalid())?
                    .clone()
                    .filter(|lease| {
                        lease.lease_id == params.lease_id
                            && lease.actor_id == accepted.operation.actor_id
                    })
                    .ok_or_else(expired)?;
                self.dispatch(accepted, token, session).await?;
                let released = self
                    .revoke_lease(session, runtime, &lease.lease_id, LeaseState::Released)
                    .await?;
                self.lease_completion(session, released, OperationState::Succeeded)
            }
            _ => Err(invalid()),
        }
    }
    async fn revoke_lease(
        &self,
        session: &Session,
        runtime: &Arc<Runtime>,
        id: &Id,
        state: LeaseState,
    ) -> HostResult<Lease> {
        let _transition = runtime.lease_transition.lock().await;
        let mut lease = {
            let mut slot = runtime.lease.lock().map_err(|_| invalid())?;
            let current = slot
                .as_mut()
                .filter(|v| &v.lease_id == id)
                .ok_or_else(expired)?;
            if matches!(current.state, LeaseState::Released | LeaseState::Expired) {
                return Ok(current.clone());
            }
            current.state = LeaseState::Revoking;
            current.clone()
        };
        self.devices
            .publish_lease(session, Some(lease.clone()))
            .await?;
        let mut affected = HashSet::new();
        loop {
            let remaining = {
                let tokens = self.tokens.lock().map_err(|_| invalid())?;
                tokens
                    .iter()
                    .filter(|(operation, token)| {
                        *operation != &lease.owner_operation_id
                            && token.lease_id.as_ref() == Some(id)
                            && token.session_id.as_ref() == Some(&lease.session_id)
                    })
                    .map(|(operation, token)| {
                        affected.insert(operation.clone());
                        token.cancel();
                        1usize
                    })
                    .sum::<usize>()
            };
            if remaining == 0 {
                break;
            }
            tokio::select! {_=self.ready.notified()=>{},_=tokio::time::sleep(Duration::from_millis(20))=>{}}
        }
        let store = self.devices.inner.store.clone();
        let unknown = blocking(move || {
            let mut unknown = false;
            for id in affected {
                let state = store.operation_state(&id)?;
                if !terminal(state) {
                    return Err(HostError::new(
                        "STORAGE_UNAVAILABLE",
                        "Lease work has not durably settled",
                    ));
                }
                unknown |= state == OperationState::Unknown;
            }
            Ok(unknown)
        })
        .await?;
        if unknown {
            self.isolate_lease(session).await?;
        }
        lease.state = state;
        *runtime.lease.lock().map_err(|_| invalid())? = Some(lease.clone());
        self.devices
            .publish_lease(session, Some(lease.clone()))
            .await?;
        runtime.changed.notify_waiters();
        Ok(lease)
    }
    pub(super) async fn isolate_lease(&self, session: &Session) -> HostResult<()> {
        {
            let mut snapshot = session.snapshot.lock().map_err(|_| invalid())?;
            if snapshot.tx_gate != TxGate::ControlUnknown {
                snapshot.tx_gate = TxGate::ControlUnknown;
                snapshot.revision = snapshot.revision.checked_next()?;
            }
        }
        self.devices.persist(session).await
    }
    fn lease_completion(
        &self,
        session: &Session,
        lease: Lease,
        state: OperationState,
    ) -> HostResult<Completion> {
        let unknown = session.snapshot()?.tx_gate == TxGate::ControlUnknown;
        Ok(Completion {
            state: if unknown {
                OperationState::Unknown
            } else {
                state
            },
            result: ActionResult::Lease(lease),
            error: unknown.then(|| {
                HostError::new(
                    "CONTROL_UNKNOWN",
                    "Lease work has an unknown backend outcome",
                )
            }),
        })
    }
}
fn expired() -> HostError {
    HostError::new("LEASE_EXPIRED", "Lease is no longer active for this owner")
}
