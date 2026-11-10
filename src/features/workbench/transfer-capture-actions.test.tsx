import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { useToolAction } from "./transfer-capture-actions";
import {
  notifyWorkbenchFailure,
  operationFailureKey,
  WorkbenchNotice,
} from "./workbench-notice";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});
const log = {
  module: "capture" as const,
  level: "error" as const,
  code: "PERMISSION_DENIED",
  message: "Recording request failed",
};

function ActionTool({ run }: { run: (signal: AbortSignal) => Promise<void> }) {
  const action = useToolAction(() => log.message);
  return (
    <>
      <button disabled={action.busy} onClick={() => void action.run(run)}>
        Run
      </button>
      <WorkbenchNotice
        noticeKey={String(action.failureIndex)}
        eventKey={action.eventKey}
        log={action.error ? log : undefined}
      >
        {action.error ? <span>{action.error}</span> : null}
      </WorkbenchNotice>
    </>
  );
}

it("keeps pre-admission/RPC errors distinct from a later real terminal event and clears the old event key on a successful retry", async () => {
  const identity = {
    executionHostId: "host",
    operationId: "tool-waiter-terminal",
  };
  const run = vi
    .fn()
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" })
    .mockRejectedValueOnce({
      ...identity,
      code: "PERMISSION_DENIED",
      message: "private input",
    })
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" });
  render(<ActionTool run={run} />);
  const button = () => screen.getByRole("button", { name: "Run" });
  await act(async () => fireEvent.click(button()));
  expect(toast.custom).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.click(button()));
  notifyWorkbenchFailure(operationFailureKey(identity), log);
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog()[0]?.count).toBe(2);
  await act(async () => fireEvent.click(button()));
  await act(async () => fireEvent.click(button()));
  expect(toast.custom).toHaveBeenCalledTimes(3);
  expect(getUserLog()[0]?.count).toBe(3);
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private input|tool-waiter-terminal/,
  );
});

it("does not publish a fake terminal failure when closing a tool only cancels its UI wait", async () => {
  let reject!: (reason: unknown) => void;
  let signal: AbortSignal | undefined;
  const run = vi.fn((current: AbortSignal) => {
    signal = current;
    return new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  });
  const view = render(<ActionTool run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenCalledOnce());
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    reject({
      code: "PERMISSION_DENIED",
      executionHostId: "host",
      operationId: "cancelled-ui-wait",
    }),
  );
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
});
