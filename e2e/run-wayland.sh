#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --session ]]; then
  session=$(mktemp -d)
  trap 'rm -rf -- "$session"' EXIT
  failed=0
  for scenario in approve cancel deny reload key-control; do
    export SWB_E2E_WAYLAND_SCENARIO=$scenario
    export SWB_E2E_WAYLAND_ARTIFACTS="$PWD/artifacts/e2e/wayland/$scenario"
    mkdir -p "$SWB_E2E_WAYLAND_ARTIFACTS"
    if ! env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u AT_SPI_BUS_ADDRESS \
      dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
      bash "$0" --session "$session/$scenario" 2>&1 | tee "$SWB_E2E_WAYLAND_ARTIFACTS/session.log"; then
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
export KDE_FULL_SESSION=true KDE_SESSION_VERSION=6
export XDG_MENU_PREFIX=plasma-
export WAYLAND_DISPLAY=swb-wayland GDK_BACKEND=wayland QT_QPA_PLATFORM=wayland
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 QT_QUICK_BACKEND=software LC_ALL=C.UTF-8
export WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 LIBGL_ALWAYS_SOFTWARE=1
install -d -m 0700 "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" \
  "$XDG_CONFIG_HOME/xdg-desktop-portal" "$XDG_DATA_HOME/applications"
printf '[preferred]\ndefault=kde\n' > "$XDG_CONFIG_HOME/xdg-desktop-portal/kde-portals.conf"
[[ -r /etc/xdg/menus/plasma-applications.menu ]]
[[ -r /usr/share/applications/org.kde.plasma.settings.open.desktop ]]
printf '[Default Applications]\nx-scheme-handler/systemsettings=org.kde.plasma.settings.open.desktop;\n' \
  > "$XDG_CONFIG_HOME/mimeapps.list"
if [[ $SWB_E2E_WAYLAND_SCENARIO == key-control ]]; then
  # Compare the exact same chord in a separate profile without the application binding.
  printf '[kwin]\nWindow Close=Ctrl+Shift+F9,Alt+F4,Close Window\n' \
    > "$XDG_CONFIG_HOME/kglobalshortcutsrc"
fi
binary=$(node --input-type=module -e 'import { readE2EBuild } from "./e2e/build.mjs"; process.stdout.write(readE2EBuild());')
name=$(node -p 'require("./src-tauri/tauri.e2e.conf.json").productName')
printf '[Desktop Entry]\nType=Application\nName=%s\nExec="%s"\n' "$name" "$binary" \
  > "$XDG_DATA_HOME/applications/$name.desktop"
export GITHUB_SHA=${GITHUB_SHA:-$(git rev-parse HEAD)}
[[ $GITHUB_SHA == "$(git rev-parse HEAD)" ]]
{
  printf 'candidate=%s\ndesktop=%s\nsession=%s\nwayland_display=%s\nscenario=%s\n' \
    "$GITHUB_SHA" "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$SWB_E2E_WAYLAND_SCENARIO"
  dpkg-query -W kwin-wayland xdg-desktop-portal xdg-desktop-portal-kde systemsettings plasma-desktop plasma-workspace
  sha256sum "$binary"
} > "$evidence/environment.txt"

QT_LOGGING_RULES='kf.globalaccel.kglobalacceld.debug=true' \
  kwin_wayland --x11-display "$DISPLAY" --socket "$WAYLAND_DISPLAY" \
  --width 1440 --height 1000 --no-lockscreen > "$evidence/kwin.log" 2>&1 &
kwin=$!
children=("$kwin")
trap 'kill "${children[@]}" 2>/dev/null || true; wait "${children[@]}" 2>/dev/null || true' EXIT

SWB_E2E_KWIN_WINDOW=$(timeout 20 xdotool search --sync --onlyvisible --pid "$kwin")
[[ $SWB_E2E_KWIN_WINDOW =~ ^[0-9]+$ ]]
export SWB_E2E_KWIN_WINDOW
xdotool windowfocus --sync "$SWB_E2E_KWIN_WINDOW"
[[ $(xdotool getwindowfocus) == "$SWB_E2E_KWIN_WINDOW" ]]
timeout 15 wayland-info > "$evidence/wayland-info.txt"

# Resolving function-key symbols in xdotool injected Mod1 in this nested server.
# Use the current Xvfb map's unmodified keycodes for every test chord.
xmodmap -pk > "$evidence/input-keymap.txt"
declare -A keycodes
mapping=()
for key in Control_L Shift_L Alt_L F4 F8 F9 F10; do
  code=$(awk -v symbol="($key)" '$3 == symbol { print $1; exit }' "$evidence/input-keymap.txt")
  [[ $code =~ ^[1-9][0-9]*$ ]]
  keycodes[$key]=$code
  mapping+=("\"$key\":\"$code\"")
done
export SWB_E2E_WAYLAND_KEYCODES="{$(IFS=,; printf '%s' "${mapping[*]}")}"

dbus-update-activation-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY \
  XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_CURRENT_DESKTOP \
  XDG_SESSION_DESKTOP XDG_SESSION_TYPE XDG_MENU_PREFIX KDE_FULL_SESSION KDE_SESSION_VERSION \
  QT_QPA_PLATFORM QT_QUICK_BACKEND QT_LINUX_ACCESSIBILITY_ALWAYS_ON LC_ALL

bus_method() {
  gdbus call --session --timeout 5 --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus --method "org.freedesktop.DBus.$1" "${@:2}"
}
accel_owner=$(bus_method GetConnectionUnixProcessID org.kde.kglobalaccel)
printf 'global_accel_owner=%s kwin_pid=%s\n' "$accel_owner" "$kwin" | tee -a "$evidence/environment.txt"
[[ $accel_owner == "(uint32 $kwin,)" ]]
timeout 15 kbuildsycoca6 --noincremental > "$evidence/desktop-service-cache.log" 2>&1
bus_method StartServiceByName org.freedesktop.impl.portal.desktop.kde 0
# Qt can activate the frontend while KWin is starting, before D-Bus sees the KDE environment.
# Replace that instance on this session bus only after the real Wayland backend is available.
/usr/libexec/xdg-desktop-portal --replace --verbose > "$evidence/portal.log" 2>&1 &
portal_pid=$!
children+=("$portal_pid")
owner=
for attempt in {1..30}; do
  kill -0 "$portal_pid"
  owner=$(bus_method GetConnectionUnixProcessID org.freedesktop.portal.Desktop 2>/dev/null || true)
  [[ $owner == "(uint32 $portal_pid,)" ]] && break
  sleep 0.3
done
printf 'portal_owner=%s expected_pid=%s\n' "$owner" "$portal_pid" | tee -a "$evidence/environment.txt"
[[ $owner == "(uint32 $portal_pid,)" ]]

portal=$(gdbus call --session --timeout 15 --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.GlobalShortcuts version)
printf 'GlobalShortcuts=%s\n' "$portal" | tee -a "$evidence/environment.txt"
[[ $portal =~ uint32[[:space:]]+([1-9][0-9]*) ]]
export SWB_E2E_PORTAL_VERSION=${BASH_REMATCH[1]}
bus_method GetNameOwner org.freedesktop.impl.portal.desktop.kde | tee -a "$evidence/environment.txt"

export SWB_E2E_WAYLAND_APP_NAME=$name
dbus-monitor --session \
  "type='signal',interface='org.freedesktop.portal.GlobalShortcuts'" \
  "type='signal',interface='org.freedesktop.impl.portal.GlobalShortcuts'" \
  "type='signal',interface='org.kde.kglobalaccel.Component'" \
  "type='method_call',interface='org.freedesktop.portal.Request',member='Close'" \
  "type='method_call',interface='org.freedesktop.impl.portal.Request',member='Close'" \
  "type='method_call',interface='org.freedesktop.portal.Session',member='Close'" \
  "type='method_call',interface='org.freedesktop.impl.portal.Session',member='Close'" \
  > "$evidence/shortcuts-dbus.log" 2>&1 &
children+=("$!")

if [[ $SWB_E2E_WAYLAND_SCENARIO == key-control ]]; then
  gdbus call --session --timeout 5 --dest org.kde.kglobalaccel \
    --object-path /component/kwin --method org.kde.kglobalaccel.Component.allShortcutInfos \
    > "$evidence/kwin-bindings.txt"
  focus="$evidence/peer-focus.json"
  timeout 15 /usr/bin/python3 e2e/wayland-desktop.py focus "$focus" "$evidence/peer-keys.jsonl" &
  peer=$!
  children+=("$peer")
  for attempt in {1..25}; do
    if [[ -r $focus ]] && grep -Fq '"active": true' "$focus"; then break; fi
    sleep 0.2
  done
  grep -Fq '"active": true' "$focus"
  [[ $(xdotool getwindowfocus) == "$SWB_E2E_KWIN_WINDOW" ]]
  xdotool keydown "${keycodes[Control_L]}" "${keycodes[Shift_L]}" "${keycodes[F9]}"
  xdotool keyup "${keycodes[F9]}" "${keycodes[Shift_L]}" "${keycodes[Control_L]}"
  peer_status=0
  wait "$peer" || peer_status=$?
  printf 'comparison_chord=Ctrl+Shift+F9 peer_status=%s\n' "$peer_status" | tee -a "$evidence/environment.txt"
  exit "$peer_status"
fi

pnpm test:e2e --interactive --skip-build --wayland-global-send
