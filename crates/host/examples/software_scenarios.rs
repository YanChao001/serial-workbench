//! Explicitly run M1 software scenarios; never a workspace-test workload.
#[path = "software_scenarios/client.rs"]
mod client;
#[path = "software_scenarios/containment.rs"]
mod containment;
#[path = "software_scenarios/disk.rs"]
mod disk;
#[path = "software_scenarios/entry.rs"]
mod entry;
#[path = "software_scenarios/evidence.rs"]
mod evidence;
#[path = "software_scenarios/fault_transport.rs"]
mod fault_transport;
#[path = "software_scenarios/formal.rs"]
mod formal;
#[path = "software_scenarios/load.rs"]
mod load;
#[path = "software_scenarios/process.rs"]
mod process;
#[path = "software_scenarios/runner.rs"]
mod runner;
#[path = "software_scenarios/scenarios.rs"]
mod scenarios;

#[tokio::main]
async fn main() {
    if let Err(error) = entry::run(std::env::args_os().skip(1)).await {
        eprintln!("software scenarios failed: {error}");
        std::process::exit(1);
    }
}
