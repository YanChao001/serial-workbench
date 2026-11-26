#!/usr/bin/python3
"""Drive the real KDE consent dialog and report a separate Wayland window's focus."""

import json
import os
from pathlib import Path
import sys
import time


def find_consent(action):
    import pyatspi

    def descendants(node):
        yield node
        for child in node:
            yield from descendants(child)

    end = time.monotonic() + 20
    desktop = pyatspi.Registry.getDesktop(0)
    while time.monotonic() < end:
        for app in desktop:
            for window in app:
                if window.name != "Global Shortcuts Requested":
                    continue
                for item in descendants(window):
                    if (item.name == action and item.getRole() == pyatspi.ROLE_PUSH_BUTTON
                            and item.getState().contains(pyatspi.STATE_SHOWING)
                            and item.getState().contains(pyatspi.STATE_ENABLED)):
                        if not item.queryAction().doAction(0):
                            raise RuntimeError(f"KDE dialog did not activate {action}")
                        print(json.dumps({"dialog": window.name, "action": action}))
                        return
        time.sleep(0.2)
    raise RuntimeError(f"No visible, enabled {action} button in the KDE shortcut dialog")


def report_focus(output):
    import gi

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk

    window = Gtk.Window(title="Serial Workbench Wayland Focus Peer")
    display = window.get_display()
    if display.__gtype__.name != "GdkWaylandDisplay":
        raise RuntimeError(f"Unexpected display: {display.__gtype__.name}")
    target = Path(output)

    def record(*_args):
        pending = target.with_suffix(".tmp")
        pending.write_text(json.dumps({
            "pid": os.getpid(),
            "display": display.get_name(),
            "backend": display.__gtype__.name,
            "active": window.is_active(),
        }), encoding="utf-8")
        pending.replace(target)

    window.set_default_size(360, 120)
    window.add(Gtk.Label(label="Focus for the global shortcut acceptance test"))
    window.connect("notify::is-active", record)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    record()
    Gtk.main()


if __name__ == "__main__":
    command, value = sys.argv[1:]
    if command == "consent" and value in ("OK", "Cancel"):
        find_consent(value)
    elif command == "focus":
        report_focus(value)
    else:
        raise SystemExit("Usage: wayland-desktop.py consent OK|Cancel, or focus PATH")
