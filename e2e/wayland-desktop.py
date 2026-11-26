#!/usr/bin/python3
"""Drive the real KDE consent dialog and report a separate Wayland window's focus."""

import json
import os
from pathlib import Path
import sys
import time


def control(target, name, action):
    import pyatspi

    def descendants(node):
        yield node
        for child in node:
            yield from descendants(child)

    titles = {
        "consent": "Global Shortcuts Requested",
        "settings": "System Settings",
        "conflict": "Resolve Shortcut Conflict",
    }
    end = time.monotonic() + 20
    desktop = pyatspi.Registry.getDesktop(0)
    seen_windows = set()
    seen_controls = set()
    matching_windows = []
    while time.monotonic() < end:
        matching_windows.clear()
        for app in desktop:
            for window in app:
                title = window.name or ""
                seen_windows.add(title)
                if titles[target] not in title:
                    continue
                if action == "wait-closed":
                    state = window.getState()
                    matching_windows.append({
                        "title": title,
                        "showing": state.contains(pyatspi.STATE_SHOWING),
                        "active": state.contains(pyatspi.STATE_ACTIVE),
                    })
                    continue
                for item in descendants(window):
                    if item.getRole() not in (pyatspi.ROLE_PUSH_BUTTON, pyatspi.ROLE_CHECK_BOX):
                        continue
                    state = item.getState()
                    visible = state.contains(pyatspi.STATE_SHOWING)
                    enabled = state.contains(pyatspi.STATE_ENABLED)
                    label = (item.name or "").strip()
                    if visible:
                        seen_controls.add(label)
                    if not (visible and enabled and label == name):
                        continue
                    active = window.getState().contains(pyatspi.STATE_ACTIVE)
                    if action == "click" and not item.queryAction().doAction(0):
                        raise RuntimeError(f"KDE did not activate {name!r}")
                    print(json.dumps({"dialog": title, "control": label, "action": action, "active": active}))
                    return
        if action == "wait-closed" and not matching_windows:
            print(json.dumps({"dialog": titles[target], "action": action}))
            return
        time.sleep(0.2)
    if action == "wait-closed":
        raise RuntimeError(
            f"{titles[target]!r} still appears in the accessibility tree: {matching_windows}"
        )
    raise RuntimeError(
        f"No visible, enabled {name!r} in {titles[target]!r}. "
        f"Windows: {sorted(seen_windows)}. Controls: {sorted(seen_controls)}"
    )


def report_focus(output, keys_output):
    import gi

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gdk, Gtk

    window = Gtk.Window(title="Serial Workbench Wayland Focus Peer")
    display = window.get_display()
    if display.__gtype__.name != "GdkWaylandDisplay":
        raise RuntimeError(f"Unexpected display: {display.__gtype__.name}")
    target = Path(output)
    keys_target = Path(keys_output)
    keys_target.write_text("", encoding="utf-8")

    def record(*_args):
        pending = target.with_suffix(".tmp")
        pending.write_text(json.dumps({
            "pid": os.getpid(),
            "display": display.get_name(),
            "backend": display.__gtype__.name,
            "active": window.is_active(),
        }), encoding="utf-8")
        pending.replace(target)

    def record_key(_window, event, edge):
        key = Gdk.keyval_name(event.keyval)
        if key in ("F8", "F9", "F10"):
            with keys_target.open("a", encoding="utf-8") as output_file:
                print(json.dumps({
                    "key": key,
                    "edge": edge,
                    "control": bool(event.state & Gdk.ModifierType.CONTROL_MASK),
                    "shift": bool(event.state & Gdk.ModifierType.SHIFT_MASK),
                }), file=output_file)
        return False

    window.set_default_size(360, 120)
    window.add(Gtk.Label(label="Focus for the global shortcut acceptance test"))
    window.connect("notify::is-active", record)
    window.connect("key-press-event", record_key, "down")
    window.connect("key-release-event", record_key, "up")
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    record()
    Gtk.main()


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "control" and len(args) == 3 and args[2] in ("click", "observe", "wait-closed"):
        control(*args)
    elif command == "focus" and len(args) == 2:
        report_focus(*args)
    else:
        raise SystemExit("Usage: wayland-desktop.py control TARGET NAME click|observe|wait-closed, or focus FOCUS_PATH KEYS_PATH")
