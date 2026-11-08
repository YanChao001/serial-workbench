import { expect, it, vi } from "vitest";
import type { ActionSpec } from "@serial-workbench/contracts";
import { buildWorkbenchCommands } from "./workbench-commands";
const action = {
  actionId: "session.close",
  kind: "action",
  targetKinds: ["session"],
  inputSchema: {},
  outputSchema: {},
  executionLocation: "resource_host",
  permissions: ["device.modify"],
  stateScopes: [],
  eventTypes: [],
  cancellation: "none",
  revealTarget: { pageId: "workbench" },
} satisfies ActionSpec;
it("registers only real visible catalog actions for the current target and shares the button handler", async () => {
  const close = vi.fn();
  const binding = {
    actionId: "session.close",
    label: "Close session",
    target: {
      hostId: "host",
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
    available: true,
    run: close,
  };
  const result = buildWorkbenchCommands(
    [action],
    [binding, { ...binding, actionId: "fake.action" }],
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.label).toBe("Close session");
  await result[0]!.run();
  expect(close).toHaveBeenCalledOnce();
  expect(buildWorkbenchCommands([], [binding])).toEqual([]);
  expect(
    buildWorkbenchCommands([{ ...action, kind: "query" }], [binding]),
  ).toEqual([]);
  expect(
    buildWorkbenchCommands(
      [action],
      [
        {
          ...binding,
          target: { hostId: "host", kind: "device", id: "device" },
        },
      ],
    ),
  ).toEqual([]);
  expect(
    buildWorkbenchCommands([action], [{ ...binding, available: false }]),
  ).toEqual([]);
});
