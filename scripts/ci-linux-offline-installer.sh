#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || "$(id -u)" == 0 ]]; then
  echo 'Offline installation requires an independent Linux runner and its unprivileged user' >&2
  exit 2
fi

target=x86_64-unknown-linux-gnu
output="$PWD/artifacts/offline-installer"
fixtures="$PWD/scripts/ci-offline-references.sh"
source "$fixtures"
mkdir -p "$output"
printf 'source=%s\ntarget=%s\n' "$GITHUB_SHA" "$target" > "$output/source.txt"
pnpm app:build --target "$target" --bundles deb --optimize speed --no-sign
version=$(node -p 'require("./package.json").version')
name=$(node -p 'require("./app.config.json").name')
dist="$PWD/artifacts/$version/$target/installers"
shopt -s nullglob
packages=("$dist/deb"/*.deb)
if [[ ${#packages[@]} != 1 ]]; then
  printf 'Expected one Debian package in %s/deb, found %s\n' "$dist" "${#packages[@]}" >&2
  exit 1
fi
deb=${packages[0]}
cp -- "$dist/components.json" "$output/components.json"
sha256sum -- "$deb" > "$output/installer.sha256.txt"

test_bin=$(prepare_offline_references "$output")
[[ -x "$test_bin" ]]

scratch=$(mktemp -d /tmp/swb-installer.XXXXXX)
sudo -n unshare --net /bin/bash -s -- "$(readlink /proc/self/ns/net)" "$(id -u)" "$(id -g)" "$deb" "$output" "$test_bin" "$name" "$scratch" "$fixtures" 2>&1 <<'OFFLINE' | tee "$output/installed-reference.log"
set -euo pipefail
parent_ns=$1
runner_uid=$2
runner_gid=$3
deb=$4
output=$5
test_bin=$6
name=$7
scratch=$8
fixtures=$9

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
find "/usr/lib/$name/runtime" -type l -printf '%P -> %l\n'

# 去掉管理员身份与环境。测试使用安装版的程序和资源，工作目录与 PATH 不提供 Node 后备。
cd "$scratch"
setpriv --reuid="$runner_uid" --regid="$runner_gid" --init-groups --inh-caps=-all --ambient-caps=-all \
  env -i LANG=C.UTF-8 TMPDIR="$scratch" \
  /bin/bash -c 'set -euo pipefail; source "$1"; run_offline_references "$2" "$3" /usr/bin "$4"' \
  offline "$fixtures" "$output" "$test_bin" "/usr/lib/$name"
OFFLINE
