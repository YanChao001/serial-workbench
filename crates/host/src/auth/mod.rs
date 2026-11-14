mod context;
mod grants;
mod identity;
pub use context::{ContextSigner, RequestContext, ValidatedContext};
pub(crate) use context::{add_wall_seconds, hash};
pub use grants::{AuthService, Authentication};
pub(crate) use grants::{AuthorizationSnapshot, GrantStamp};
pub use identity::{AuthenticatedActor, HostIdentity};

#[cfg(test)]
pub(crate) fn actor(id: &str) -> AuthenticatedActor {
    let id = serial_workbench_core::Id::try_from(id).unwrap();
    AuthenticatedActor::from_verified(id.clone(), id, 0.into(), false)
}
