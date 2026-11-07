//! Authenticated local Host client.
mod connection;
mod discovery;
mod launch;
mod rpc;
pub use connection::{ConnectOptions, HostClient, RawAttachment, RawConnection};
pub use discovery::read_user_control_credential;
pub use launch::adjacent_host_executable;
