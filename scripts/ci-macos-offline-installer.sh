#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != macOS || "$(id -u)" == 0 ]]; then
  echo 'Offline installation requires an independent macOS runner and its unprivileged user' >&2
  exit 2
fi

target=$RUNTIME_TARGET
output="$PWD/artifacts/offline-installer"
fixtures="$PWD/scripts/ci-offline-references.sh"
source "$fixtures"
mkdir -p "$output"
printf 'source=%s\ntarget=%s\n' "$GITHUB_SHA" "$target" > "$output/source.txt"
sw_vers >> "$output/source.txt"
uname -m >> "$output/source.txt"

profile="$output/offline.sb"
cat > "$profile" <<'POLICY'
(version 1)
(allow default)
(deny network*)
(allow network* (local unix-socket))
(allow network* (remote unix-socket))
POLICY

# 检查实际规则，IP 连接必须被拒绝，连接拒绝或超时不能证明沙箱生效。
/usr/bin/sandbox-exec -f "$profile" "$(command -v node)" --input-type=module - 2>&1 <<'PROBE' | tee "$output/network.log"
import { createConnection } from 'node:net';
for (const host of ['127.0.0.1', '::1']) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 9 });
    socket.setTimeout(2000, () => socket.destroy(new Error('Network probe timed out')));
    socket.once('connect', () => socket.destroy(new Error(`Unexpected IP access: ${host}`)));
    socket.once('error', (error) => {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') return reject(error);
      console.log(`${host}: ${error.code}`);
      resolve();
    });
  });
}
PROBE

pnpm app:build --target "$target" --bundles app,dmg --optimize speed --no-sign
version=$(node -p 'require("./package.json").version')
name=$(node -p 'require("./app.config.json").name')
dist="$PWD/artifacts/$version/$target/installers"
shopt -s nullglob
packages=("$dist/dmg"/*.dmg)
if [[ ${#packages[@]} != 1 ]]; then
  printf 'Expected one disk image in %s/dmg, found %s\n' "$dist" "${#packages[@]}" >&2
  exit 1
fi
dmg=${packages[0]}
cp "$dist/components.json" "$output/components.json"
shasum -a 256 "$dmg" > "$output/installer.sha256.txt"

scratch=$(mktemp -d /private/tmp/swb-dmg.XXXXXX)
installed="$scratch/Applications/$name.app"
/usr/bin/sandbox-exec -f "$profile" /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 TMPDIR="$scratch" \
  /bin/bash -s -- "$dmg" "$installed" "$scratch/mount" 2>&1 <<'OFFLINE' | tee "$output/install.log"
set -euo pipefail
dmg=$1
installed=$2
mount=$3

mkdir -p "$mount" "$(dirname "$installed")"
# 镜像内嵌本仓库 LICENSE。显式向挂载命令确认，避免它读取 bash 的脚本输入。
printf 'Y\n' | /usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" "$dmg"
trap '/usr/bin/hdiutil detach "$mount"' EXIT
/usr/bin/ditto "$mount/$(basename "$installed")" "$installed"
/usr/bin/hdiutil detach "$mount"
trap - EXIT

programs="$installed/Contents/MacOS"
resources="$installed/Contents/Resources"
main=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$installed/Contents/Info.plist")
/usr/bin/file "$programs/serial-workbench-host"
/usr/bin/shasum -a 256 "$programs/$main" "$programs"/serial-workbench{-host,-cli,-mcp} "$resources/runtime/node-image.json"
OFFLINE

export SWB_NODE_RUNTIME_BUILD_IMAGE="$installed/Contents/Resources/runtime/node-image.json"
test_bin=$(prepare_offline_references "$output")
[[ -x "$test_bin" ]]

cd "$scratch"
/usr/bin/sandbox-exec -f "$profile" /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 TMPDIR="$scratch" \
  /bin/bash -c 'set -euo pipefail; source "$1"; run_offline_references "$2" "$3" "$4/Contents/MacOS" "$4/Contents/Resources"' \
  offline "$fixtures" "$output" "$test_bin" "$installed" 2>&1 | tee "$output/installed-reference.log"
