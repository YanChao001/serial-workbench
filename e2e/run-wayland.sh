#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --session ]]; then
  session=$(mktemp -d)
  trap 'rm -rf -- "$session"' EXIT
  failed=0
  for consent in OK Cancel; do
    export SWB_E2E_WAYLAND_CONSENT=$consent
    export SWB_E2E_WAYLAND_ARTIFACTS="$PWD/artifacts/e2e/wayland/$consent"
    mkdir -p "$SWB_E2E_WAYLAND_ARTIFACTS"
    if ! env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u AT_SPI_BUS_ADDRESS \
      dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
      bash "$0" --session "$session/$consent" 2>&1 | tee "$SWB_E2E_WAYLAND_ARTIFACTS/session.log"; then
      failed=1
    fi
  done
  exit "$failed"
fi

# Xvfb hosts one outer KWin window. The desktop and both clients below use Wayland.
session=$2
evidence=${SWB_E2E_WAYLAND_ARTIFACTS:?Run through the isolated desktop entry point}
export XDG_RUNTIME_DIR="$session/run" XDG_CONFIG_HOME="$session/config"
export XDG_DATA_HOME="$session/data" XDG_CACHE_HOME="$session/cache"
export XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=swb-wayland GDK_BACKEND=wayland QT_QPA_PLATFORM=wayland
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 QT_QUICK_BACKEND=software LC_ALL=C.UTF-8
export WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 LIBGL_ALWAYS_SOFTWARE=1
install -d -m 0700 "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" \
  "$XDG_CONFIG_HOME/xdg-desktop-portal" "$XDG_DATA_HOME/applications"
printf '[preferred]\ndefault=kde\n' > "$XDG_CONFIG_HOME/xdg-desktop-portal/kde-portals.conf"
binary=$(node --input-type=module -e 'import { readE2EBuild } from "./e2e/build.mjs"; process.stdout.write(readE2EBuild());')
name=$(node -p 'require("./src-tauri/tauri.e2e.conf.json").productName')
printf '[Desktop Entry]\nType=Application\nName=%s\nExec="%s"\n' "$name" "$binary" \
  > "$XDG_DATA_HOME/applications/$name.desktop"
export GITHUB_SHA=${GITHUB_SHA:-$(git rev-parse HEAD)}
[[ $GITHUB_SHA == "$(git rev-parse HEAD)" ]]
{
  printf 'candidate=%s\ndesktop=%s\nsession=%s\nwayland_display=%s\nconsent=%s\n' \
    "$GITHUB_SHA" "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$SWB_E2E_WAYLAND_CONSENT"
  dpkg-query -W kwin-wayland xdg-desktop-portal xdg-desktop-portal-kde
  sha256sum "$binary"
} > "$evidence/environment.txt"

kwin_wayland --x11-display "$DISPLAY" --socket "$WAYLAND_DISPLAY" \
  --width 1440 --height 1000 --no-lockscreen > "$evidence/kwin.log" 2>&1 &
kwin=$!
trap 'kill "$kwin" 2>/dev/null || true; wait "$kwin" 2>/dev/null || true' EXIT

SWB_E2E_KWIN_WINDOW=$(timeout 20 xdotool search --sync --onlyvisible --pid "$kwin")
[[ $SWB_E2E_KWIN_WINDOW =~ ^[0-9]+$ ]]
export SWB_E2E_KWIN_WINDOW
xdotool windowfocus --sync "$SWB_E2E_KWIN_WINDOW"
[[ $(xdotool getwindowfocus) == "$SWB_E2E_KWIN_WINDOW" ]]
timeout 15 wayland-info > "$evidence/wayland-info.txt"
dbus-update-activation-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY \
  XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_CURRENT_DESKTOP \
  XDG_SESSION_DESKTOP XDG_SESSION_TYPE QT_QPA_PLATFORM QT_QUICK_BACKEND \
  QT_LINUX_ACCESSIBILITY_ALWAYS_ON LC_ALL

portal=$(gdbus call --session --timeout 15 --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.GlobalShortcuts version)
printf 'GlobalShortcuts=%s\n' "$portal" | tee -a "$evidence/environment.txt"
[[ $portal =~ uint32[[:space:]]+([1-9][0-9]*) ]]
export SWB_E2E_PORTAL_VERSION=${BASH_REMATCH[1]}
gdbus call --session --timeout 5 --dest org.freedesktop.DBus \
  --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetNameOwner \
  org.freedesktop.impl.portal.desktop.kde | tee -a "$evidence/environment.txt"

pnpm test:e2e --interactive --skip-build --wayland-global-send
