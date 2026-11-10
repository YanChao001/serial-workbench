#!/usr/bin/env bash
set -euo pipefail

prefer_ubuntu_archive() {
  local apt_directory="${1:-/etc/apt}"
  local config filtered
  local configs=("$apt_directory/apt-mirrors.txt" "$apt_directory/sources.list")
  shopt -s nullglob
  configs+=("$apt_directory"/sources.list.d/*.list "$apt_directory"/sources.list.d/*.sources)
  for config in "${configs[@]}"; do
    [[ -f "$config" ]] || continue
    # runner 通过 mirror+file 选源；只替换完整 Azure URI，保留安全源、组件及签名。
    sudo sed -i -E 's#https?://azure\.archive\.ubuntu\.com/ubuntu/?([[:space:]]|$)#https://archive.ubuntu.com/ubuntu/\1#g' "$config"
    if [[ "$config" == "$apt_directory/apt-mirrors.txt" ]]; then
      # 当前 runner 的镜像按优先级排列；替换后保留第一个 URI，避免重复 fallback。
      filtered=$(mktemp)
      awk '/^[[:space:]]*(#|$)/ || !seen[$1]++' "$config" > "$filtered"
      sudo cp "$filtered" "$config"
      rm -- "$filtered"
    fi
  done
}

install_linux_dependencies() {
  local mode="${1:-}"
  local apt_directory="${2:-/etc/apt}"
  local packages=(build-essential libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev libatomic1 patchelf)
  case "$mode" in
    rust) ;;
    native)
      packages+=(xvfb xauth dbus-x11 openbox gdb libc6-dbg fonts-noto-cjk gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav)
      ;;
    *) echo "Usage: bash scripts/ci-linux-deps.sh rust|native" >&2; return 2 ;;
  esac
  prefer_ubuntu_archive "$apt_directory"
  local apt=(sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15)
  echo "APT index started: $(date -u +%FT%TZ)"
  "${apt[@]}" update
  echo "APT download started: $(date -u +%FT%TZ)"
  # 只限下载墙钟；失败不进入 dpkg，安装复用已验证归档且不再访问网络。
  timeout --signal=TERM --kill-after=10s 480s "${apt[@]}" install -y --no-install-recommends --download-only "${packages[@]}"
  echo "APT install started: $(date -u +%FT%TZ)"
  "${apt[@]}" install -y --no-install-recommends --no-download "${packages[@]}"
  echo "APT preparation completed: $(date -u +%FT%TZ)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_linux_dependencies "$@"
fi
