//! Typed native client-effect admission; only Host-issued effects enter this path.
use serial_workbench_core::{
    ClientEffectRequest, ClientRegistration, HostError, HostResult, Id, U64,
};
use std::collections::VecDeque;

pub(crate) fn validate_delivery(
    host_id: &Id,
    host_epoch: U64,
    registration: &ClientRegistration,
    request: &ClientEffectRequest,
) -> HostResult<()> {
    if &request.host_id != host_id
        || &registration.target.host_id != host_id
        || registration.target.kind.as_str() != "client"
        || request.instance_epoch != host_epoch
        || request.client_target_id != registration.target.id
        || request.generation != registration.generation
        || !registration
            .capabilities
            .contains(&request.action.capability())
    {
        return Err(HostError::new(
            "PERMISSION_DENIED",
            "Client effect does not match the registered window",
        ));
    }
    request.action.validate()
}

pub(crate) struct EffectInbox {
    max_items: usize,
    max_bytes: usize,
    bytes: usize,
    closed: bool,
    pending: VecDeque<(ClientEffectRequest, usize)>,
}
impl EffectInbox {
    pub(super) fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            max_items,
            max_bytes,
            bytes: 0,
            closed: false,
            pending: VecDeque::new(),
        }
    }
    pub(super) fn push(&mut self, request: ClientEffectRequest) -> HostResult<()> {
        if self.closed {
            return Err(HostError::new(
                "UNAUTHENTICATED",
                "Client effect receiver closed",
            ));
        }
        let size = serde_json::to_vec(&request)
            .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid client effect"))?
            .len();
        if self.pending.len() >= self.max_items || size > self.max_bytes.saturating_sub(self.bytes)
        {
            return Err(HostError::new(
                "HOST_BUSY",
                "Client effect capacity exhausted",
            ));
        }
        self.pending.push_back((request, size));
        self.bytes += size;
        Ok(())
    }
    pub(super) fn close(&mut self) {
        self.closed = true;
        self.pending.clear();
        self.bytes = 0;
    }
    pub(super) fn pop(&mut self) -> Option<ClientEffectRequest> {
        let (request, size) = self.pending.pop_front()?;
        self.bytes -= size;
        Some(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::*;

    fn fixture() -> (Id, ClientRegistration, ClientEffectRequest) {
        let host = Id::try_from("host").unwrap();
        let target = Target {
            host_id: host.clone(),
            kind: ResourceKind::try_from("client").unwrap(),
            id: Id::try_from("window").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let registration = ClientRegistration {
            target,
            generation: 7.into(),
            capabilities: vec![ClientCapability::WindowRead],
        };
        let request = ClientEffectRequest {
            host_id: host.clone(),
            instance_epoch: 2.into(),
            client_target_id: Id::try_from("window").unwrap(),
            generation: 7.into(),
            delivery_id: Id::try_from("delivery").unwrap(),
            request_id: RequestId::try_from("00000000-0000-4000-8000-000000000101").unwrap(),
            operation_id: None,
            action: ClientEffectAction::WindowRead {},
        };
        (host, registration, request)
    }

    #[test]
    fn only_matching_host_epoch_target_generation_and_capability_are_admitted() {
        let (host, registration, request) = fixture();
        validate_delivery(&host, 2.into(), &registration, &request).unwrap();
        let mut wrong = request.clone();
        wrong.host_id = Id::try_from("other").unwrap();
        assert!(validate_delivery(&host, 2.into(), &registration, &wrong).is_err());
        let mut wrong = request.clone();
        wrong.instance_epoch = 3.into();
        assert!(validate_delivery(&host, 2.into(), &registration, &wrong).is_err());
        let mut wrong = request.clone();
        wrong.client_target_id = Id::try_from("other").unwrap();
        assert!(validate_delivery(&host, 2.into(), &registration, &wrong).is_err());
        let mut wrong = request.clone();
        wrong.generation = 8.into();
        assert!(validate_delivery(&host, 2.into(), &registration, &wrong).is_err());
        let mut wrong = request;
        wrong.action = ClientEffectAction::WindowMinimize {};
        assert!(validate_delivery(&host, 2.into(), &registration, &wrong).is_err());
    }

    #[test]
    fn queue_is_bounded_and_closure_prevents_new_delivery() {
        let (_, _, request) = fixture();
        let mut inbox = EffectInbox::new(1, 1024 * 1024);
        inbox.push(request.clone()).unwrap();
        assert_eq!(inbox.push(request.clone()).unwrap_err().code, "HOST_BUSY");
        inbox.close();
        assert_eq!(inbox.push(request).unwrap_err().code, "UNAUTHENTICATED");
    }

    #[test]
    fn queue_byte_limit_counts_encoded_request() {
        let (_, _, request) = fixture();
        let size = serde_json::to_vec(&request).unwrap().len();
        let mut inbox = EffectInbox::new(2, size - 1);
        assert_eq!(inbox.push(request).unwrap_err().code, "HOST_BUSY");
    }

    #[test]
    fn dequeue_releases_both_budgets_and_close_discards_pending() {
        let (_, _, request) = fixture();
        let size = serde_json::to_vec(&request).unwrap().len();
        let mut inbox = EffectInbox::new(1, size);
        inbox.push(request.clone()).unwrap();
        assert_eq!(inbox.pop(), Some(request.clone()));
        inbox.push(request).unwrap();
        inbox.close();
        assert_eq!(inbox.pop(), None);
    }
}
