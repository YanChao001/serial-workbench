import { StrictMode } from "react";
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
import { HostRequestError } from "@serial-workbench/host-client";
import type { OperationSummary } from "@serial-workbench/contracts";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { OperationFailureNotices } from "./operation-failure-notices";
import { WorkspaceLayout, type WorkbenchHost } from "./workspace-layout";
import { actionCatalog, labels, operation, session } from "./test-fixtures";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

function host(): WorkbenchHost {
  return {
    state: {
      status: "ready",
      error: null,
      devices: [
        {
          deviceId: "device",
          hostId: "host",
          systemName: "COM14",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          capabilities: session().capabilities,
        },
      ],
      sessions: [],
      operations: [],
      operationSummaries: [],
      operationSummariesReady: true,
      streams: new Map(),
      catalog: actionCatalog,
      devicesStale: false,
    },
    checkAction: vi.fn<WorkbenchHost["checkAction"]>(async (input) => ({
      ...input,
      allowed: true,
    })),
    watchActions: vi.fn<WorkbenchHost["watchActions"]>((inputs, listener) => {
      listener(
        inputs.map((input) => ({
          input,
          result: { ...input, allowed: true },
          error: null,
        })),
      );
      return () => {};
    }),
    open: vi.fn().mockResolvedValue(session()),
    trustedConnect: vi.fn().mockResolvedValue(session()),
    send: vi.fn().mockResolvedValue(operation()),
    takeover: vi.fn().mockResolvedValue(operation()),
    refresh: vi.fn().mockResolvedValue(undefined),
    watchSession: vi.fn(() => () => {}),
  };
}
function failure(id: string): OperationSummary {
  return {
    ...operation(id),
    actionId: "device.open",
    state: "failed",
    errorCode: "ACCESS_DENIED",
    target: { hostId: "host", kind: "device", id: "device" },
  };
}
function Shell({
  adapter,
  showWorkbench = true,
  onCloseSession,
}: {
  adapter: WorkbenchHost;
  showWorkbench?: boolean;
  onCloseSession?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}) {
  return (
    <StrictMode>
      <OperationFailureNotices
        ready
        scopeKey="native-open-failure"
        operations={adapter.state.operationSummaries}
        text={labels.operationText}
      />
      {showWorkbench && (
        <WorkspaceLayout
          host={adapter}
          labels={labels}
          formatError={() => "Cannot open this port"}
          onCloseSession={onCloseSession}
        />
      )}
    </StrictMode>
  );
}
function nativeFailure(operationId: string) {
  return new HostRequestError({
    code: "ACCESS_DENIED",
    message: "private OS failure C:/private/fixture-user",
    retryable: false,
    details: {
      operationFailure: { executionHostId: "host", operationId },
      osCode: "5",
    },
  });
}

it("shows connection progress until Native confirms the session", async () => {
  const adapter = host();
  let resolve!: (value: ReturnType<typeof session>) => void;
  adapter.trustedConnect = vi.fn(
    () =>
      new Promise<ReturnType<typeof session>>((done) => {
        resolve = done;
      }),
  );
  const view = render(<Shell adapter={adapter} />);
  const button = screen.getByRole("button", { name: "Open COM14" });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toHaveAttribute("aria-pressed", "true");
  adapter.state = { ...adapter.state, sessions: [session()] };
  view.rerender(<Shell adapter={adapter} />);
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toHaveAttribute("aria-pressed", "true");
  await act(async () => resolve(session()));
  expect(
    screen.getByRole("button", { name: labels.closeSession }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { busy: true })).not.toBeInTheDocument();
});

it("dispatches a send without waiting for a redundant preview request", async () => {
  const adapter = host();
  adapter.state = { ...adapter.state, sessions: [session()] };
  render(<Shell adapter={adapter} />);
  fireEvent.click(screen.getByRole("button", { name: "Open COM14" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: labels.closeSession }),
    ).toBeInTheDocument(),
  );
  adapter.checkAction = vi.fn<WorkbenchHost["checkAction"]>(
    () => new Promise(() => {}),
  );
  fireEvent.change(screen.getByRole("textbox", { name: labels.draft }), {
    target: { value: "fast" },
  });
  fireEvent.click(screen.getByRole("button", { name: labels.send }));
  await waitFor(() => expect(adapter.send).toHaveBeenCalledOnce());
});

it.each(["local-first", "projection-first"] as const)(
  "notifies one actual COM-style open failure once across Native and projection (%s)",
  async (order) => {
    const adapter = host();
    let reject!: (reason: unknown) => void;
    adapter.trustedConnect = vi.fn(
      () =>
        new Promise<ReturnType<typeof session>>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const view = render(<Shell adapter={adapter} />);
    const id = `native-open-${order}`;
    fireEvent.click(screen.getByRole("button", { name: "Open COM14" }));
    await waitFor(() => expect(adapter.trustedConnect).toHaveBeenCalledOnce());
    if (order === "local-first")
      await act(async () => reject(nativeFailure(id)));
    adapter.state = { ...adapter.state, operationSummaries: [failure(id)] };
    view.rerender(<Shell adapter={adapter} />);
    if (order === "projection-first")
      await act(async () => reject(nativeFailure(id)));
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()).toEqual([
      expect.objectContaining({
        module: "connection",
        code: "ACCESS_DENIED",
        count: 1,
      }),
    ]);
    expect(JSON.stringify(getUserLog())).not.toMatch(
      /private|fixture-user|native-open-|osCode/,
    );
    adapter.state = {
      ...adapter.state,
      operationSummaries: [failure(`${id}-next`), failure(id)],
    };
    view.rerender(<Shell adapter={adapter} />);
    expect(toast.custom).toHaveBeenCalledTimes(2);
    expect(getUserLog().reduce((count, entry) => count + entry.count, 0)).toBe(
      2,
    );
  },
);

it("keeps an ordinary RPC failure separate from the later actual device failure", async () => {
  const adapter = host();
  adapter.trustedConnect = vi.fn().mockRejectedValue(
    new HostRequestError({
      code: "ACCESS_DENIED",
      message: "private RPC failure",
      retryable: false,
      operationId: "rpc-reference-is-not-a-terminal-proof",
      details: { osCode: "5" },
    }),
  );
  const view = render(<Shell adapter={adapter} />);
  fireEvent.click(screen.getByRole("button", { name: "Open COM14" }));
  await waitFor(() => expect(toast.custom).toHaveBeenCalledOnce());
  adapter.state = {
    ...adapter.state,
    operationSummaries: [failure("actual-after-rpc")],
  };
  view.rerender(<Shell adapter={adapter} />);
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog().every((entry) => entry.module === "connection")).toBe(
    true,
  );
  expect(getUserLog().reduce((count, entry) => count + entry.count, 0)).toBe(2);
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private|rpc-reference|actual-after-rpc/,
  );
});

it("keeps an aborted UI waiter quiet while observing the later actual failure outside the route", async () => {
  const adapter = host();
  let reject!: (reason: unknown) => void;
  let waiting: AbortSignal | undefined;
  adapter.trustedConnect = vi.fn((_deviceId, signal) => {
    waiting = signal;
    return new Promise<ReturnType<typeof session>>((_resolve, fail) => {
      reject = fail;
    });
  });
  const view = render(<Shell adapter={adapter} />);
  fireEvent.click(screen.getByRole("button", { name: "Open COM14" }));
  await waitFor(() => expect(adapter.trustedConnect).toHaveBeenCalledOnce());
  view.rerender(<Shell adapter={adapter} showWorkbench={false} />);
  expect(waiting?.aborted).toBe(true);
  await act(async () => reject(nativeFailure("native-open-after-route-left")));
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
  adapter.state = {
    ...adapter.state,
    operationSummaries: [failure("native-open-after-route-left")],
  };
  view.rerender(<Shell adapter={adapter} showWorkbench={false} />);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "connection", count: 1 }),
  ]);
});

it("correlates a confirmed close failure with the same connection event", async () => {
  const adapter = host();
  adapter.state.sessions = [session()];
  const id = "confirmed-close-failure";
  const close = vi.fn().mockRejectedValue(
    Object.assign(
      new HostRequestError({
        code: "ACCESS_DENIED",
        message: "private close failure",
        retryable: false,
      }),
      { executionHostId: "host", operationId: id },
    ),
  );
  const view = render(<Shell adapter={adapter} onCloseSession={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Open COM14" }));
  const button = await screen.findByRole("button", { name: "Close session" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  adapter.state = {
    ...adapter.state,
    operationSummaries: [
      {
        ...failure(id),
        actionId: "session.close",
        target: {
          hostId: "host",
          kind: "session",
          id: "session",
          sessionId: "session",
          sessionEpoch: "1",
        },
      },
    ],
  };
  view.rerender(<Shell adapter={adapter} onCloseSession={close} />);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "connection", count: 1 }),
  ]);
});
