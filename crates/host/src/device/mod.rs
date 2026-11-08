mod discovery;
pub mod identity;
mod reconnect;
pub mod serial;
pub(crate) mod sessions;
pub mod virtual_backend;
pub use discovery::{DeviceDirectory, RecentConnections};
pub use identity::{IdentityMatcher, MatchResult};
pub use reconnect::{ReconnectDecision, ReconnectGate, ReconnectResponsibility};
pub use sessions::{BindingResolver, DeviceService, TransportOpener};

mod runtime;
pub use runtime::{DeviceProvider, DeviceRuntime};
