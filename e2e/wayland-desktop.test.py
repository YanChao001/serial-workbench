import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from runpy import run_path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch


control = run_path(str(Path(__file__).with_name("wayland-desktop.py")))["control"]
CONSENT = "Global Shortcuts Requested"


def accessible(name, children=(), role=None):
    node = MagicMock()
    node.name = name
    node.__iter__.return_value = children
    node.getRole.return_value = role
    node.getState.return_value.contains.return_value = True
    return node


def probe(snapshots, action):
    iterations = iter(snapshots)
    desktop = MagicMock()
    desktop.__iter__.side_effect = lambda: iter(next(iterations))
    atspi = SimpleNamespace(
        Registry=SimpleNamespace(getDesktop=lambda _: desktop),
        ROLE_PUSH_BUTTON="button",
        ROLE_CHECK_BOX="check",
        ROLE_LIST_ITEM="list",
        STATE_SHOWING="showing",
        STATE_ACTIVE="active",
        STATE_ENABLED="enabled",
    )
    clock = SimpleNamespace(monotonic=Mock(return_value=0), sleep=Mock())
    output = io.StringIO()
    with (
        patch.dict(sys.modules, {"pyatspi": atspi}),
        patch.dict(control.__globals__, {"time": clock}),
        redirect_stdout(output),
    ):
        control("consent", "Cancel", action)
    return json.loads(output.getvalue()), clock.sleep.call_count


class AccessibilityObservation(unittest.TestCase):
    def test_waits_for_complete_snapshot_before_reporting_closed(self):
        dialog = accessible(CONSENT)
        result, retries = probe([[[None], None], [[dialog]], [[]]], "wait-closed")
        self.assertEqual(result, {"dialog": CONSENT, "action": "wait-closed"})
        self.assertEqual(retries, 2)

    def test_rescans_missing_child_before_reporting_no_button(self):
        button = accessible("Cancel", role="button")
        result, retries = probe(
            [[[accessible(CONSENT, [None])]], [[accessible(CONSENT, [button])]]],
            "click-if-present",
        )
        self.assertEqual(result["control"], "Cancel")
        self.assertEqual(retries, 1)
        button.queryAction.return_value.doAction.assert_called_once_with(0)


if __name__ == "__main__":
    unittest.main()
