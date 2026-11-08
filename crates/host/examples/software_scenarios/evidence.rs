use super::process::{Result, checked};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;

pub(super) const REQUIRED: [(&str, [&str; 3]); 6] = [
    (
        "T01",
        [
            "three_clients_same_session",
            "rx_tx_hash",
            "partial_unknown_no_replay",
        ],
    ),
    (
        "T03",
        [
            "client_detach_continues",
            "shutdown_settled",
            "restart_epoch_no_replay",
        ],
    ),
    (
        "T04",
        [
            "capabilities",
            "partial_configuration",
            "break_cleanup_isolation",
        ],
    ),
    (
        "T05",
        ["disk_failure_evidence", "rotation_recovery", "crash_prefix"],
    ),
    (
        "T06",
        [
            "slow_reader_isolated",
            "control_responsive",
            "loss_accounted",
        ],
    ),
    (
        "T08",
        [
            "capture_after_detach",
            "finalize_verified",
            "replay_readonly_seek",
        ],
    ),
];
#[derive(Serialize)]
pub(super) struct Assertion {
    name: String,
    passed: bool,
    actual: Value,
}
#[derive(Serialize)]
pub(super) struct Case {
    pub id: String,
    status: String,
    source: String,
    evidence: Vec<String>,
    assertions: Vec<Assertion>,
    error: Option<String>,
}
impl Case {
    pub fn new(id: &str, source: &str) -> Self {
        Self {
            id: id.into(),
            status: "failed".into(),
            source: source.into(),
            evidence: Vec::new(),
            assertions: Vec::new(),
            error: None,
        }
    }
    pub fn check(&mut self, name: &str, passed: bool, actual: Value) -> Result<()> {
        if self.assertions.iter().any(|a| a.name == name) {
            return Err(format!("Repeated assertion {}:{name}", self.id));
        }
        let names = REQUIRED
            .iter()
            .find(|(id, _)| *id == self.id)
            .ok_or("Unknown scenario ID")?
            .1;
        if !names.contains(&name) {
            return Err(format!("Unknown assertion {}:{name}", self.id));
        }
        self.assertions.push(Assertion {
            name: name.into(),
            passed,
            actual,
        });
        if passed {
            Ok(())
        } else {
            Err(format!("{} assertion {name} failed", self.id))
        }
    }
    pub fn artifact(&mut self, path: &str) {
        self.evidence.push(path.into());
    }
    pub fn finish(&mut self, outcome: Result<()>, log_dir: &Path) -> Result<()> {
        self.error = outcome.err();
        let names = REQUIRED
            .iter()
            .find(|(id, _)| *id == self.id)
            .ok_or("Unknown scenario ID")?
            .1;
        for name in names {
            if !self.assertions.iter().any(|a| a.name == name) {
                self.assertions.push(Assertion {
                    name: name.into(),
                    passed: false,
                    actual: json!({"notExecuted":true,"error":self.error}),
                });
            }
        }
        if self.error.is_none() && self.assertions.iter().all(|a| a.passed) {
            self.status = "passed".into();
        }
        let file = format!("{}-observations.json", self.id);
        self.evidence.push(file.clone());
        write_json(&log_dir.join(file), self)
    }
    pub fn passed(&self) -> bool {
        self.status == "passed"
    }
    pub fn observed_all(&self) -> bool {
        self.assertions.len() == 3 && self.assertions.iter().all(|a| a.passed)
    }
}
pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::io::Write;
    let mut file = checked(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path),
    )?;
    checked(file.write_all(&checked(serde_json::to_vec_pretty(value))?))?;
    checked(file.sync_all())
}
pub(super) fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() as f64 * quantile).ceil() as usize).saturating_sub(1)]
}
