import {
  allowControlActions,
  observeControlActions,
} from "./session-controls.test-fixtures";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { CaptureStatusResult } from "@serial-workbench/contracts";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { CaptureStatus, LiveCaptureStatus } from "./capture-status";
import { operationFailureKey, WorkbenchNotice } from "./workbench-notice";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { labels } from "./test-fixtures";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearUserLog();
});
const status: CaptureStatusResult = {
  captureRef: { hostId: "host", kind: "capture", id: "capture", revision: "1" },
  ownerOperationId: "owner",
  summary: {
    captureId: "capture",
    state: "recording",
    containerComplete: false,
    sourceContinuous: true,
    watermarks: { written: "100", flushed: "90", synced: "80", verified: "0" },
  },
};
async function tick(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}
function useClock() {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
}
it("shows readable distinct watermarks and waits for the actual final recording state after a stop receipt", async () => {
  useClock();
  const read = vi.fn().mockResolvedValue({
    ...status,
    summary: {
      ...status.summary,
      state: "complete",
      containerComplete: true,
      watermarks: {
        written: "200",
        flushed: "190",
        synced: "180",
        verified: "170",
      },
    },
  });
  const stop = vi.fn().mockResolvedValue(undefined);
  render(
    <CaptureStatus
      watchActions={allowControlActions}
      value={status}
      read={read}
      onStop={stop}
      disabled={false}
      labels={labels}
    />,
  );
  expect(screen.getByText("100 records")).toBeInTheDocument();
  expect(screen.getByText("90 records")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("capture")).not.toBeInTheDocument();
  expect(screen.queryByText("recording")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: labels.captureStatusDetails }),
  ).not.toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Stop capture" })),
  );
  expect(stop).toHaveBeenCalledWith(status.captureRef, expect.any(AbortSignal));
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.captureStates.recording,
  );
  expect(screen.getByText(labels.stopRequested)).toBeVisible();
  expect(screen.getByRole("button", { name: "Stop capture" })).toBeDisabled();
  await tick(1000);
  expect(screen.getByText("170 records")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.captureStates.complete,
  );
  expect(read).toHaveBeenCalledWith(status.captureRef, expect.any(AbortSignal));
  await tick(4000);
  expect(read).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: labels.captureStatusDetails }),
  );
  const details = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: labels.captureStatusDetails,
  });
  expect(JSON.parse(details.value)).toMatchObject({
    ownerOperationId: "owner",
    summary: { captureId: "capture", watermarks: { verified: "170" } },
  });
});

it("observes status and stop independently and rejects an old reference's permission callback", async () => {
  useClock();
  const observer = observeControlActions();
  const read = vi.fn().mockResolvedValue(status),
    stop = vi.fn();
  const props = {
    value: status,
    labels,
    disabled: false,
    read,
    onStop: stop,
    watchActions: observer.watchActions,
  };
  const view = render(<CaptureStatus {...props} />);
  const stopButton = () => screen.getByRole("button", { name: "Stop capture" });
  expect(stopButton()).toBeDisabled();
  const first = observer.subscriptions[0]!;
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.status"),
  );
  expect(stopButton()).toBeDisabled();
  await tick(1000);
  expect(read).toHaveBeenCalledOnce();
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.stop"),
  );
  expect(stopButton()).toBeEnabled();
  await tick(2000);
  expect(read).toHaveBeenCalledOnce();
  view.rerender(
    <CaptureStatus
      {...props}
      value={{ ...status, captureRef: { ...status.captureRef, revision: "2" } }}
    />,
  );
  expect(stopButton()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  fireEvent.click(stopButton());
  expect(stop).not.toHaveBeenCalled();
  await tick(2000);
  expect(read).toHaveBeenCalledOnce();
});

it("reads a live capture once across global observation invalidations before its next visible sample", async () => {
  useClock();
  const subscriptions = new Set<{
    inputs: readonly HostActionCheckInput[];
    listener: (values: readonly HostActionAvailability[]) => void;
  }>();
  function invalidate() {
    for (const subscription of subscriptions)
      subscription.listener(
        subscription.inputs.map((input) => ({
          input,
          result: null,
          error: null,
        })),
      );
  }
  const watchActions: HostContextValue["watchActions"] = (inputs, listener) => {
    const subscription = { inputs, listener };
    subscriptions.add(subscription);
    invalidate();
    return () => {
      subscriptions.delete(subscription);
      invalidate();
    };
  };
  async function allowCurrent() {
    await act(async () => {
      for (const subscription of [...subscriptions])
        subscription.listener(
          subscription.inputs.map((input) => ({
            input,
            result: {
              actionId: input.actionId,
              target: input.target,
              allowed: true,
            },
            error: null,
          })),
        );
    });
  }
  const read = vi.fn(async (): Promise<CaptureStatusResult> => ({
    ...status,
    captureRef: { ...status.captureRef },
    summary: {
      ...status.summary,
      watermarks: { ...status.summary.watermarks },
    },
  }));
  const view = render(
    <LiveCaptureStatus
      reference={status.captureRef}
      read={read}
      labels={labels}
      disabled={false}
      watchActions={watchActions}
    />,
  );
  expect(read).not.toHaveBeenCalled();
  await allowCurrent();
  expect(screen.getByText("100 records")).toBeInTheDocument();
  expect(subscriptions.size).toBe(2);
  await allowCurrent();
  await allowCurrent();
  await allowCurrent();
  expect(read).toHaveBeenCalledOnce();
  await tick(999);
  expect(read).toHaveBeenCalledOnce();
  await tick(1);
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(subscriptions.size).toBe(0);
  await tick(5000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("routes a failed initial read to one safe module notice and retries only after an explicit request", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "private/path/secret",
    })
    .mockResolvedValueOnce(status);
  const props = {
    read,
    labels,
    disabled: false,
    watchActions: allowControlActions,
  };
  const view = render(
    <LiveCaptureStatus {...props} reference={status.captureRef} />,
  );
  await act(async () => {});
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toMatchObject([
    {
      module: "capture",
      code: "PERMISSION_DENIED",
      message: labels.operationText.failure("PERMISSION_DENIED"),
      count: 1,
    },
  ]);
  expect(document.body).not.toHaveTextContent("private/path/secret");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.rerender(
    <LiveCaptureStatus {...props} reference={{ ...status.captureRef }} />,
  );
  await act(async () => {});
  expect(read).toHaveBeenCalledOnce();
  expect(toast.custom).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.retry })),
  );
  expect(screen.getByText("100 records")).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
  let pendingSignal: AbortSignal | undefined;
  let resolve!: (value: CaptureStatusResult) => void;
  const pendingRead = vi.fn((_reference: unknown, signal?: AbortSignal) => {
    pendingSignal = signal;
    return new Promise<CaptureStatusResult>((done) => {
      resolve = done;
    });
  });
  view.rerender(
    <LiveCaptureStatus
      {...props}
      reference={{ ...status.captureRef, id: "next" }}
      read={pendingRead}
    />,
  );
  expect(screen.queryByText("100 records")).not.toBeInTheDocument();
  await act(async () => {});
  expect(pendingRead).toHaveBeenCalledOnce();
  view.unmount();
  expect(pendingSignal?.aborted).toBe(true);
  await act(async () => resolve(status));
  expect(screen.queryByText("100 records")).not.toBeInTheDocument();
});

it("samples without overlap only while visible and aborts the active reader on close", async () => {
  useClock();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  let signal: AbortSignal | undefined;
  let finish!: (value: CaptureStatusResult) => void;
  const read = vi.fn((_reference: unknown, requestSignal?: AbortSignal) => {
    signal = requestSignal;
    return new Promise<CaptureStatusResult>((resolve) => {
      finish = resolve;
    });
  });
  const view = render(
    <CaptureStatus
      value={status}
      labels={labels}
      disabled={false}
      read={read}
      watchActions={allowControlActions}
    />,
  );
  hidden = true;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(5000);
  expect(read).not.toHaveBeenCalled();
  hidden = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(read).toHaveBeenCalledOnce();
  await tick(5000);
  expect(read).toHaveBeenCalledOnce();
  await act(async () => finish(status));
  await tick(1000);
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(status));
  await tick(3000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("pauses failed polling, keeps exact facts and logs a structured failure without leaking its raw message", async () => {
  useClock();
  const read = vi
    .fn()
    .mockRejectedValueOnce({ code: "IO", message: "private/recording/path" })
    .mockResolvedValueOnce({
      ...status,
      summary: {
        ...status.summary,
        state: "complete",
        watermarks: {
          written: "1234570",
          flushed: "1234569",
          synced: "1234568",
          verified: "1234567",
        },
      },
    });
  render(
    <CaptureStatus
      value={status}
      labels={labels}
      disabled={false}
      read={read}
      watchActions={allowControlActions}
    />,
  );
  await tick(1000);
  expect(read).toHaveBeenCalledOnce();
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toMatchObject([
    { module: "capture", code: "IO", count: 1 },
  ]);
  expect(JSON.stringify(getUserLog())).not.toContain("private/recording/path");
  expect(screen.getByText("100 records")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await tick(5000);
  expect(read).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: labels.retry }));
  await tick(1000);
  expect(screen.getByText("1,234,567 records")).toHaveAttribute(
    "title",
    "1234567",
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it("aborts stop waiting when its capture reference changes and ignores the old completion", async () => {
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  const stop = vi.fn((_reference: unknown, requestSignal?: AbortSignal) => {
    signal = requestSignal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const props = {
    labels,
    disabled: false,
    onStop: stop,
    watchActions: allowControlActions,
  };
  const view = render(<CaptureStatus {...props} value={status} />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.stopCapture })),
  );
  expect(stop).toHaveBeenCalledOnce();
  view.rerender(
    <CaptureStatus
      {...props}
      value={{ ...status, captureRef: { ...status.captureRef, id: "next" } }}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => finish());
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.captureStates.recording,
  );
  expect(
    screen.getByRole("button", { name: labels.stopCapture }),
  ).toBeEnabled();
});

it("keeps a failed stop retryable and reports only its safe module error", async () => {
  const stop = vi
    .fn()
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "private/recording/path",
    })
    .mockResolvedValueOnce(undefined);
  render(
    <CaptureStatus
      value={status}
      labels={labels}
      disabled={false}
      onStop={stop}
      watchActions={allowControlActions}
    />,
  );
  const button = screen.getByRole("button", { name: labels.stopCapture });
  await act(async () => fireEvent.click(button));
  expect(button).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.captureStates.recording,
  );
  expect(getUserLog()).toMatchObject([
    { module: "capture", code: "PERMISSION_DENIED", count: 1 },
  ]);
  expect(JSON.stringify(getUserLog())).not.toContain("private/recording/path");
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => fireEvent.click(button));
  expect(stop).toHaveBeenCalledTimes(2);
  expect(button).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.captureStates.recording,
  );
});

it("deduplicates the stop terminal failure with the same operation's global notice", async () => {
  const identity = {
    executionHostId: "host",
    operationId: "capture-stop-dedup",
  };
  const failure = {
    ...identity,
    code: "IO",
    message: "private/recording/path",
  };
  const message = labels.operationText.failure("IO");
  render(
    <>
      <WorkbenchNotice
        noticeKey="observed-terminal"
        eventKey={operationFailureKey(identity)}
        log={{ module: "capture", level: "error", code: "IO", message }}
      >
        <span role="alert">{message}</span>
      </WorkbenchNotice>
      <CaptureStatus
        value={status}
        labels={labels}
        disabled={false}
        onStop={vi.fn().mockRejectedValue(failure)}
        watchActions={allowControlActions}
      />
    </>,
  );
  const stop = screen.getByRole("button", { name: labels.stopCapture });
  await act(async () => fireEvent.click(stop));
  expect(stop).toBeEnabled();
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toMatchObject([
    { module: "capture", code: "IO", count: 1 },
  ]);
  expect(JSON.stringify(getUserLog())).not.toContain("private/recording/path");
});

it("keeps a local stop RPC failure distinct from a later terminal failure", async () => {
  const identity = {
    executionHostId: "host",
    operationId: "capture-stop-rpc-distinct",
  };
  const message = labels.operationText.failure("IO");
  const view = render(
    <CaptureStatus
      value={status}
      labels={labels}
      disabled={false}
      onStop={vi.fn().mockRejectedValue({ code: "IO" })}
      watchActions={allowControlActions}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.stopCapture })),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  view.rerender(
    <>
      <CaptureStatus
        value={status}
        labels={labels}
        disabled={false}
        onStop={vi.fn().mockRejectedValue({ code: "IO" })}
        watchActions={allowControlActions}
      />
      <WorkbenchNotice
        noticeKey="observed-later-terminal"
        eventKey={operationFailureKey(identity)}
        log={{ module: "capture", level: "error", code: "IO", message }}
      >
        <span role="alert">{message}</span>
      </WorkbenchNotice>
    </>,
  );
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog().reduce((sum, entry) => sum + entry.count, 0)).toBe(2);
});

it.each([
  ["1234567", "1,234,567 records"],
  ["18446744073709551615", "18,446,744,073,709,551,615 records"],
])(
  "preserves the exact contiguous record prefix %s instead of formatting it as a byte quantity",
  (prefix, expected) => {
    render(
      <CaptureStatus
        value={{
          ...status,
          summary: {
            ...status.summary,
            watermarks: {
              written: prefix,
              flushed: prefix,
              synced: prefix,
              verified: prefix,
            },
          },
        }}
        labels={labels}
        disabled={false}
        watchActions={allowControlActions}
      />,
    );
    expect(screen.getByLabelText(labels.verified)).toHaveTextContent(expected);
    expect(screen.getByLabelText(labels.verified)).toHaveAttribute(
      "title",
      prefix,
    );
    expect(screen.queryByText("1.23 MB")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: labels.captureStatusDetails }),
    );
    const details = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: labels.captureStatusDetails,
    });
    const value: unknown = JSON.parse(details.value);
    expect(value).toMatchObject({
      summary: { watermarks: { verified: prefix } },
    });
  },
);
