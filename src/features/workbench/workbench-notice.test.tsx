import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { StrictMode } from "react";
import { HostRequestError } from "@serial-workbench/host-client";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import {
  notifyWorkbenchFailure,
  operationFailureEventKey,
  operationFailureKey,
  WorkbenchNotice,
} from "./workbench-notice";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

it("accepts only bounded contract identities from unknown failure values", () => {
  expect(
    operationFailureEventKey({
      executionHostId: "host",
      operationId: "valid-id",
    }),
  ).toBe(
    operationFailureKey({ executionHostId: "host", operationId: "valid-id" }),
  );
  const native = {
    code: "ACCESS_DENIED",
    message: "private OS failure",
    retryable: false,
    details: {
      operationFailure: { executionHostId: "host", operationId: "valid-id" },
      osCode: "5",
    },
  };
  expect(operationFailureEventKey(native)).toBe(
    operationFailureEventKey(new HostRequestError(native)),
  );
  expect(operationFailureEventKey(native)).toBe(
    operationFailureKey({ executionHostId: "host", operationId: "valid-id" }),
  );
  for (const reason of [
    undefined,
    "failure",
    { executionHostId: "host", operationId: "" },
    { executionHostId: "host", operationId: "x".repeat(129) },
    { executionHostId: "host/path", operationId: "id" },
    { executionHostId: "host", operationId: 3 },
    { code: "ACCESS_DENIED", operationId: "not-terminal-proof" },
    { details: { operationId: "not-terminal-proof", executionHostId: "host" } },
    {
      details: {
        operationFailure: { executionHostId: "host/path", operationId: "id" },
      },
    },
    {
      details: {
        details: {
          operationFailure: {
            executionHostId: "host",
            operationId: "x".repeat(129),
          },
        },
      },
    },
  ])
    expect(operationFailureEventKey(reason)).toBeUndefined();
});

it("shares a real failure across StrictMode, multiple presenters and reopened tools without replaying or recounting it", () => {
  const key = operationFailureKey({
    executionHostId: "host",
    operationId: "once-across-tools",
  });
  const log = {
    module: "capture" as const,
    level: "error" as const,
    code: "PERMISSION_DENIED",
    message: "Recording could not stop",
  };
  const content = (
    <StrictMode>
      <WorkbenchNotice noticeKey="stop" eventKey={key} log={log}>
        <span>Recording could not stop</span>
      </WorkbenchNotice>
    </StrictMode>
  );
  const view = render(content);
  expect(toast.custom).toHaveBeenCalledOnce();
  view.unmount();
  render(content);
  notifyWorkbenchFailure(key, log);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(toast.dismiss).not.toHaveBeenCalledWith(key);
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "capture", count: 1 }),
  ]);
  notifyWorkbenchFailure(
    operationFailureKey({
      executionHostId: "host",
      operationId: "new-failure",
    }),
    log,
  );
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog()[0]?.count).toBe(2);
});

it("does not replay an unchanged error when its parent renders new content nodes", () => {
  const view = render(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">
      <p>Access denied</p>
    </WorkbenchNotice>,
  );
  view.rerender(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">
      <p>Access denied</p>
    </WorkbenchNotice>,
  );
  view.rerender(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">
      <p>Access denied</p>
    </WorkbenchNotice>,
  );
  expect(toast.custom).toHaveBeenCalledTimes(1);
  expect(vi.mocked(toast.custom).mock.calls[0]?.[1]).toMatchObject({
    duration: 5000,
    closeButton: true,
  });
});

it.each([false, true])(
  "does not keep broadcasting dismissals on stream updates after an empty notice (previous error: %s)",
  (previousError) => {
    const content = (present: boolean) => (
      <WorkbenchNotice
        noticeKey="stream:reader"
        log={{ module: "display", level: "error", message: "Reader stopped" }}
      >
        {present && <p>Reader stopped</p>}
      </WorkbenchNotice>
    );
    const view = render(content(previousError));
    view.rerender(content(false));
    const closed = vi.mocked(toast.dismiss).mock.calls.length;
    for (let tick = 0; tick < 100; tick++) view.rerender(content(false));
    expect(toast.dismiss).toHaveBeenCalledTimes(closed);
    expect(closed).toBe(previousError ? 1 : 0);
    view.unmount();
    expect(toast.dismiss).toHaveBeenCalledTimes(closed);
  },
);

it("notifies a subsequent failed attempt after the previous error was cleared", () => {
  const view = render(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">
      <p>Access denied</p>
    </WorkbenchNotice>,
  );
  view.rerender(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">{null}</WorkbenchNotice>,
  );
  view.rerender(
    <WorkbenchNotice noticeKey="open:ACCESS_DENIED">
      <p>Access denied</p>
    </WorkbenchNotice>,
  );
  expect(toast.custom).toHaveBeenCalledTimes(2);
});
