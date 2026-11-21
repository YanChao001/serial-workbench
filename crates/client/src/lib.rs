//! RPC client for authenticated Host connections.
mod connection;
mod discovery;
mod launch;
mod rpc;
mod shutdown;
pub use connection::{ConnectOptions, ControlConnection, HostClient, RawAttachment, RawConnection};
pub use discovery::read_user_control_credential;
pub use launch::adjacent_host_executable;
