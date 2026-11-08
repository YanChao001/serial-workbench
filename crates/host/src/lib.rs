//! Independent Host runtime.
pub mod auth;
pub mod capture;
mod capture_api;
pub mod client_effects;
pub mod clock;
pub mod device;
pub mod dispatch;
mod documents;
pub mod files;
pub mod ipc;
mod limits;
pub mod metrics;
pub mod registry;
pub mod settings;
pub mod state;
pub mod storage;
pub mod stream;
pub mod transmission;
pub mod workspace;
pub use dispatch::Host;
#[cfg(test)]
extern crate self as serial_workbench_host;
#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;
