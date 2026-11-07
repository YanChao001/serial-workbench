use serial_workbench_core::{Id, U64};

#[derive(Clone, Debug)]
pub struct AuthenticatedActor {
    id: Id,
    client_id: Id,
    grant_revision: U64,
    user_control: bool,
}
impl AuthenticatedActor {
    pub(super) fn from_verified(
        id: Id,
        client_id: Id,
        grant_revision: U64,
        user_control: bool,
    ) -> Self {
        Self {
            id,
            client_id,
            grant_revision,
            user_control,
        }
    }
    pub fn id(&self) -> &Id {
        &self.id
    }
    pub fn client_id(&self) -> &Id {
        &self.client_id
    }
    pub fn grant_revision(&self) -> U64 {
        self.grant_revision
    }
    pub fn is_user_control(&self) -> bool {
        self.user_control
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostIdentity {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub catalog_version: U64,
}
