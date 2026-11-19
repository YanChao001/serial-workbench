#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || "$(id -u)" == 0 ]]; then
  echo 'Offline installation requires an independent Linux runner and its unprivileged user' >&2
  exit 2
fi

target=x86_64-unknown-linux-gnu
output="$PWD/artifacts/offline-installer"
mkdir -p "$output"
printf 'source=%s\ntarget=%s\n' "$GITHUB_SHA" "$target" > "$output/source.txt"
pnpm app:build --target "$target" --bundles deb --optimize speed --no-sign
version=$(node -p 'require("./package.json").version')
name=$(node -p 'require("./app.config.json").name')
dist="$PWD/artifacts/$version/$target/installers"
shopt -s nullglob
packages=("$dist"/*.deb)
[[ ${#packages[@]} == 1 ]]
deb=${packages[0]}
cp -- "$dist/components.json" "$output/components.json"
sha256sum -- "$deb" > "$output/installer.sha256.txt"

# 在线准备签名测试输入和同源测试程序，隔离后只执行已有产物。
pnpm plugin-sdk:fixture
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

test_bin=$(cargo test --locked -p serial-workbench --lib --no-run --message-format=json-render-diagnostics | \
  node -e 'for (const line of require("node:fs").readFileSync(0, "utf8").trim().split("\n")) {
    const event = JSON.parse(line);
    if (event.reason === "compiler-artifact" && event.target.name === "serial_workbench_lib" && event.profile.test && event.executable) process.stdout.write(event.executable);
  }')
[[ -x "$test_bin" ]]

scratch=$(mktemp -d /tmp/swb-installer.XXXXXX)
sudo -n unshare --net /bin/bash -s -- "$(readlink /proc/self/ns/net)" "$(id -u)" "$(id -g)" "$deb" "$output" "$test_bin" "$name" "$scratch" 2>&1 <<'OFFLINE' | tee "$output/installed-reference.log"
set -euo pipefail
parent_ns=$1
runner_uid=$2
runner_gid=$3
deb=$4
output=$5
test_bin=$6
name=$7
scratch=$8

child_ns=$(readlink /proc/self/ns/net)
printf 'parent=%s\nchild=%s\n' "$parent_ns" "$child_ns"
[[ "$child_ns" != "$parent_ns" ]]
ip -brief link show
[[ $(ip -brief link show) == lo*DOWN* && $(ip -o link show | wc -l) == 1 ]]
[[ -z $(ip -o address show) && -z $(ip -4 route show table all) && -z $(ip -6 route show table all) ]]

dpkg --install "$deb"
package=$(dpkg-deb --field "$deb" Package)
dpkg-query -W -f='${Status} ${Version}\n' "$package"
dpkg-query -L "$package"
sha256sum /usr/bin/serial-workbench{,-host,-cli,-mcp} "/usr/lib/$name/runtime/node-release.json"

# 去掉管理员身份与环境。测试使用安装版的程序和资源，工作目录与 PATH 不提供 Node 后备。
cd "$scratch"
setpriv --reuid="$runner_uid" --regid="$runner_gid" --init-groups --inh-caps=-all --ambient-caps=-all \
  env -i LANG=C.UTF-8 TMPDIR="$scratch" \
  SWB_NODE_RUNTIME_TEST_ROOT="/usr/lib/$name" \
  SWB_TEST_TERMINAL_HOST_BIN=/usr/bin/serial-workbench-host \
  SWB_TEST_CLI_BIN=/usr/bin/serial-workbench-cli \
  SWB_TEST_MCP_BIN=/usr/bin/serial-workbench-mcp \
  SWB_TEST_SIGNED_TERMINAL_RECEIPT="$output/reference-terminal/signed-terminal.json" \
  SWB_TEST_SIGNED_CHART_RECEIPT="$output/reference-chart/signed-chart.json" \
  SWB_TEST_SIGNED_AUTOMATION_RECEIPT="$output/reference-automation/signed-automation.json" \
  "$test_bin" --ignored --test-threads=1 --nocapture \
  native_reference_terminal_uses_installed_runtime_through_formal_host \
  native_chart_samples_exact_rx_from_the_signed_reference_package \
  native_automation_uses_exact_responses_and_keeps_capture_running
OFFLINE
