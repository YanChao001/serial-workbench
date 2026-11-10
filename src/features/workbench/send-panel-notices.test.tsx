import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Operation, OperationSummary } from "@serial-workbench/contracts";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { SendPanel } from "./send-panel";
import { OperationFailureObserver } from "./operation-failure-notices";
import { labels, operation, session } from "./test-fixtures";

const observer = vi.hoisted(() => ({
  state: { status: "ready", operationSummaries: [] as OperationSummary[] },
  connection: { attachment: { hostId: "host", instanceEpoch: "1" } },
}));
vi.mock("@/providers/host-context", () => ({ useHost: () => observer }));
vi.mock("@/providers/i18n", () => ({
  useI18n: () => ({ t: createTranslator(en) }),
}));
vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
  observer.state.operationSummaries = [];
});

function admitted(id: string): Operation {
  return {
    ...operation(id),
    actionId: "session.tx",
    state: "queued",
    target: {
      hostId: "host",
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
  };
}

it.each(["failed", "unknown"] as const)(
  "shares one real %s send failure event with the permanent observer",
  async (state) => {
    const queued = admitted(`send-observer-${state}`);
    const send = vi.fn().mockResolvedValue(queued);
    function Content({ operations }: { operations: Operation[] }) {
      observer.state.operationSummaries = operations.map((value) => ({
        ...value,
        errorCode: value.error?.code,
      }));
      return (
        <>
          <OperationFailureObserver />
          <SendPanel
            session={session()}
            draft="A"
            labels={labels}
            onDraftChange={vi.fn()}
            onSend={send}
            operations={operations}
          />
        </>
      );
    }
    const view = render(<Content operations={[]} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send" })),
    );
    expect(toast.custom).not.toHaveBeenCalled();
    const settled: Operation = {
      ...queued,
      state,
      revision: "2",
      ...(state === "failed"
        ? {
            error: {
              code: "PERMISSION_DENIED",
              message: "private input",
              retryable: false,
            },
          }
        : {}),
    };
    view.rerender(<Content operations={[settled]} />);
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()).toEqual([
      expect.objectContaining({ module: "serial", count: 1 }),
    ]);
    view.rerender(<Content operations={[{ ...settled, revision: "3" }]} />);
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()[0]?.count).toBe(1);
    expect(JSON.stringify(getUserLog())).not.toContain("private input");
  },
);

it.each(["failed", "unknown"] as const)(
  "does not attach a new pre-admission RPC failure to the preceding %s send operation",
  async (state) => {
    const queued = admitted(`send-before-rpc-error-${state}`);
    const failed: Operation = {
      ...queued,
      state,
      revision: "2",
      error: {
        code: "PERMISSION_DENIED",
        message: "private input",
        retryable: false,
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(queued)
      .mockRejectedValueOnce(new Error("private RPC detail"));
    function Content({ operations }: { operations: Operation[] }) {
      observer.state.operationSummaries = operations.map((value) => ({
        ...value,
        errorCode: value.error?.code,
      }));
      return (
        <>
          <OperationFailureObserver />
          <SendPanel
            session={session()}
            draft="A"
            labels={labels}
            onDraftChange={vi.fn()}
            onSend={send}
            operations={operations}
          />
        </>
      );
    }
    const view = render(<Content operations={[]} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send" })),
    );
    view.rerender(<Content operations={[failed]} />);
    expect(toast.custom).toHaveBeenCalledOnce();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send" })),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(toast.custom).toHaveBeenCalledTimes(2);
    expect(getUserLog()[0]?.code).toBeUndefined();
    expect(getUserLog()[0]?.level).toBe("error");
    expect(JSON.stringify(getUserLog())).not.toContain("private RPC detail");
  },
);

it("shares an explicitly identified terminal error returned by the send waiter with the observer", async () => {
  const queued = admitted("send-waiter-identified-error");
  const send = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    details: {
      operationFailure: {
        operationId: queued.operationId,
        executionHostId: queued.executionHostId,
      },
    },
  });
  const failed: Operation = {
    ...queued,
    state: "failed",
    revision: "2",
    error: {
      code: "PERMISSION_DENIED",
      message: "private input",
      retryable: false,
    },
  };
  function Content({ operations }: { operations: Operation[] }) {
    observer.state.operationSummaries = operations.map((value) => ({
      ...value,
      errorCode: value.error?.code,
    }));
    return (
      <>
        <OperationFailureObserver />
        <SendPanel
          session={session()}
          draft="A"
          labels={labels}
          onDraftChange={vi.fn()}
          onSend={send}
          operations={operations}
        />
      </>
    );
  }
  const view = render(<Content operations={[]} />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Send" })),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  view.rerender(<Content operations={[failed]} />);
  expect(toast.custom).toHaveBeenCalledOnce();
});

it.each(["host", "action", "target"] as const)(
  "does not borrow a mismatched %s projection for the admitted receipt",
  async (mismatch) => {
    const queued = admitted(`send-projection-${mismatch}`);
    const send = vi.fn().mockResolvedValue(queued);
    const foreign: Operation = {
      ...queued,
      state: "failed",
      revision: "2",
      error: {
        code: "PERMISSION_DENIED",
        message: "private input",
        retryable: false,
      },
    };
    if (mismatch === "host") {
      foreign.executionHostId = "other-host";
      foreign.target = { ...foreign.target, hostId: "other-host" };
    }
    if (mismatch === "action") foreign.actionId = "session.control";
    if (mismatch === "target")
      foreign.target = { ...foreign.target, sessionEpoch: "2" };
    function Content({ operations }: { operations: Operation[] }) {
      observer.state.operationSummaries = operations.map((value) => ({
        ...value,
        errorCode: value.error?.code,
      }));
      return (
        <>
          <OperationFailureObserver />
          <SendPanel
            session={session()}
            draft="A"
            labels={labels}
            onDraftChange={vi.fn()}
            onSend={send}
            operations={operations}
          />
        </>
      );
    }
    const view = render(<Content operations={[]} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send" })),
    );
    view.rerender(<Content operations={[foreign]} />);
    expect(toast.custom).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
    expect(
      await screen.findByRole("status", { name: "Receipt" }),
    ).toHaveTextContent(labels.queued);
  },
);
