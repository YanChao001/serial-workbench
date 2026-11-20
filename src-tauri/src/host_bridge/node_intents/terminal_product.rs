//! 可选的实际 MCP 产品验收。复用终端夹具的进程、会话和精确授权。
use serde::Deserialize;
use serde_json::{Value, json};
use serial_workbench_core::{CaptureTailResult, HostError, Operation, OperationResult, Target};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

const OPEN: &str = "swb_swb_x2E_reference_x2E_terminal_x2E_open";
const CAPTURE: &str = "swb_capture_x2E_tail";
const INSPECT: &str = "swb_operation_x2E_get";
const TRUST: &str = "swb_node_x2E_packages_x2E_confirmExecutionTrust";

pub(super) struct Product {
    executable: PathBuf,
    evidence: PathBuf,
    profile: PathBuf,
    mcp: PathBuf,
}

#[derive(Deserialize)]
struct Receipt {
    catalog: Vec<String>,
    results: Vec<ToolResult>,
}

#[derive(Debug, Deserialize)]
struct ToolResult {
    value: Option<Value>,
    error: bool,
    text: String,
}

impl Product {
    pub(super) fn configured(profile: &Path, mcp: PathBuf) -> Option<Self> {
        let executable = std::env::var_os("SWB_TEST_CLAUDE_CODE_BIN");
        let evidence = std::env::var_os("SWB_TEST_TERMINAL_PRODUCT_OUTPUT");
        match (executable, evidence) {
            (None, None) => None,
            (Some(executable), Some(evidence)) => {
                let executable = PathBuf::from(executable);
                let evidence = PathBuf::from(evidence);
                assert!(executable.is_absolute() && executable.is_file());
                assert!(evidence.is_absolute() && evidence.is_dir());
                Some(Self {
                    executable,
                    evidence,
                    profile: profile.to_owned(),
                    mcp,
                })
            }
            _ => panic!("Supply both the Claude Code program and product evidence directory"),
        }
    }

    pub(super) async fn authorized(
        &self,
        session: &Target,
        capture: &Target,
        tail: &Value,
        operation: &Operation,
        expected: &CaptureTailResult,
    ) -> Operation {
        let receipt = self
            .run(
                "granted",
                json!([
                    {"name": OPEN, "input": {"target": session, "params": {}}},
                    inspection(operation),
                    {"name": CAPTURE, "input": {"target": capture, "params": tail}}
                ]),
            )
            .await;
        for name in [OPEN, INSPECT, CAPTURE] {
            assert!(
                receipt.catalog.iter().any(|tool| tool == name),
                "Missing active tool {name}"
            );
        }
        assert!(!receipt.catalog.iter().any(|name| name == TRUST));
        let [accepted, inspected, content] =
            receipt.results.try_into().expect("three product replies");
        let accepted: Operation = decode(accepted);
        assert_eq!(accepted.action_id.as_str(), "swb.reference.terminal.open");
        assert_eq!(&accepted.target, session);
        let inspected: OperationResult = decode(inspected);
        assert_eq!(&inspected.operation, operation);
        let content: CaptureTailResult = decode(content);
        assert_eq!(&content, expected);
        accepted
    }

    pub(super) async fn revoked(&self, capture: &Operation) {
        let receipt = self.run("revoked", json!([inspection(capture)])).await;
        for name in [OPEN, CAPTURE, TRUST] {
            assert!(
                !receipt.catalog.iter().any(|tool| tool == name),
                "Revoked tool still visible: {name}"
            );
        }
        let [denied] = receipt.results.try_into().expect("one product reply");
        assert!(denied.error && denied.value.is_none(), "{denied:?}");
        let error: HostError = serde_json::from_str(&denied.text).expect("MCP denial payload");
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert!(error.details.is_none());
        eprintln!(
            "terminal_claude_code signed_action=true capture_matches_cli=true revoked_catalog_and_reference=true"
        );
    }

    async fn run(&self, phase: &str, calls: Value) -> Receipt {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/terminal-product.mjs");
        let input = json!({"claude": self.executable, "mcp": self.mcp, "profile": self.profile, "calls": calls});
        let input_path = self.evidence.join(format!("{phase}.input.json"));
        let input_file = std::fs::File::create_new(&input_path).expect("fresh test evidence input");
        serde_json::to_writer(input_file, &input).unwrap();
        let mut command = Command::new("node");
        command
            .arg(script)
            .arg(input_path)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let result = command
            .output()
            .await
            .expect("Run the actual MCP product fixture");
        assert!(
            result.status.success(),
            "MCP product fixture failed in {}: {}",
            self.evidence.display(),
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).expect("MCP product receipt JSON")
    }
}

fn inspection(operation: &Operation) -> Value {
    json!({"name": INSPECT, "input": {
        "target": {"kind": "operation", "id": operation.operation_id, "hostId": operation.target.host_id},
        "params": {"operationId": operation.operation_id}
    }})
}

fn decode<T: serde::de::DeserializeOwned>(reply: ToolResult) -> T {
    assert!(!reply.error, "{reply:?}");
    serde_json::from_value(reply.value.expect("MCP product structured content")).unwrap()
}
