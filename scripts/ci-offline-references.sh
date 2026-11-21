# 安装验收共用签名输入和用例，联网阶段编译，断网阶段运行安装产物。
prepare_offline_references() (
  set -euo pipefail
  local output=$1 seed reference dir build_log
  pnpm plugin-sdk:fixture >&2
  cargo build --locked -p serial-workbench-host \
    --example sign_reference_terminal --example sign_reference_chart --example sign_reference_automation
  seed=$(mktemp)
  trap 'rm -f -- "$seed"' EXIT
  node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32))' "$seed"
  for reference in terminal chart automation; do
    dir="$output/reference-$reference"
    mkdir "$dir"
    "src-tauri/target/debug/examples/sign_reference_$reference" \
      ".cache/plugin-sdk/examples/reference-$reference/main.js" "$seed" \
      "$dir/reference-$reference.zip" "$reference-reference" offline-ci \
      > "$dir/signed-$reference.json"
  done
  rm -- "$seed"
  trap - EXIT

  # 先落盘 Cargo 收据，避免 Node 读取管道时中断安装验收。
  build_log="$output/reference-test-build.log"
  cargo test --locked -p serial-workbench --lib --no-run --message-format=json-render-diagnostics > "$build_log"
  node -e 'for (const line of require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n")) {
    const event = JSON.parse(line);
    if (event.reason === "compiler-artifact" && event.target.name === "serial_workbench_lib" && event.profile.test && event.executable) process.stdout.write(event.executable);
  }' "$build_log"
)

run_offline_references() {
  local output=$1 test_bin=$2 programs=$3 resources=$4
  SWB_NODE_RUNTIME_TEST_ROOT="$resources" \
  SWB_TEST_TERMINAL_HOST_BIN="$programs/serial-workbench-host" \
  SWB_TEST_CLI_BIN="$programs/serial-workbench-cli" \
  SWB_TEST_MCP_BIN="$programs/serial-workbench-mcp" \
  SWB_TEST_SIGNED_TERMINAL_RECEIPT="$output/reference-terminal/signed-terminal.json" \
  SWB_TEST_SIGNED_CHART_RECEIPT="$output/reference-chart/signed-chart.json" \
  SWB_TEST_SIGNED_AUTOMATION_RECEIPT="$output/reference-automation/signed-automation.json" \
  "$test_bin" --ignored --test-threads=1 --nocapture \
    native_reference_terminal_uses_installed_runtime_through_formal_host \
    native_chart_samples_exact_rx_from_the_signed_reference_package \
    native_automation_uses_exact_responses_and_keeps_capture_running \
    native_automation_long_script_survives_caller_disconnect_and_settles_workers
}
