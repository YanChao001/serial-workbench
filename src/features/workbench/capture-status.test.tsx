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
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CaptureStatusResult } from "@serial-workbench/contracts";
import { CaptureStatus, LiveCaptureStatus } from "./capture-status";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { labels } from "./test-fixtures";
afterEach(cleanup);
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
it("keeps capture watermarks distinct and stops the exact capture reference", async () => {
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
  const view = render(
    <CaptureStatus
      watchActions={allowControlActions}
      value={status}
      read={read}
      onStop={stop}
      disabled={false}
      labels={labels}
    />,
  );
  expect(screen.getByText("100")).toBeInTheDocument();
  expect(screen.getByText("90")).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Container complete" }),
  ).not.toBeChecked();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Stop capture" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop capture" }));
  await waitFor(() =>
    expect(stop).toHaveBeenCalledWith(
      status.captureRef,
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("170");
  expect(read).toHaveBeenCalledWith(status.captureRef, expect.any(AbortSignal));
  expect(screen.getByRole("button", { name: "Stop capture" })).toBeDisabled();
  view.rerender(
    <CaptureStatus
      watchActions={allowControlActions}
      value={status}
      read={read}
      onStop={stop}
      disabled={true}
      labels={labels}
    />,
  );
  expect(screen.getByRole("button", { name: "Stop capture" })).toBeDisabled();
});

it("observes status and stop independently for the current capture reference", () => {
  const observer = observeControlActions();
  const read = vi.fn(),
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
  const refresh = () => screen.getByRole("button", { name: "Refresh" });
  const stopButton = () => screen.getByRole("button", { name: "Stop capture" });
  expect(refresh()).toBeDisabled();
  expect(stopButton()).toBeDisabled();
  const first = observer.subscriptions[0]!;
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.status"),
  );
  expect(refresh()).toBeEnabled();
  expect(stopButton()).toBeDisabled();
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.stop"),
  );
  expect(refresh()).toBeDisabled();
  expect(stopButton()).toBeEnabled();
  view.rerender(
    <CaptureStatus
      {...props}
      value={{ ...status, captureRef: { ...status.captureRef, revision: "2" } }}
    />,
  );
  expect(stopButton()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(stopButton()).toBeDisabled();
  fireEvent.click(stopButton());
  expect(stop).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("reads a live capture once across global observation invalidations and refreshes only on request", async () => {
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
  await screen.findByText("100");
  expect(subscriptions.size).toBe(2);
  // 有界推进 Host 的允许结果，旧实现会在每轮再次读取而不会把测试挂死。
  await allowCurrent();
  await allowCurrent();
  await allowCurrent();
  expect(read).toHaveBeenCalledTimes(1);
  const refresh = screen.getByRole("button", { name: "Refresh" });
  expect(refresh).toBeEnabled();
  fireEvent.click(refresh);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await allowCurrent();
  await allowCurrent();
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(subscriptions.size).toBe(0);
});

it("retries a failed initial live read explicitly and aborts a read when its reference changes", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("100");
  expect(read).toHaveBeenCalledTimes(2);
  let pendingSignal: AbortSignal | undefined;
  let resolve!: (value: CaptureStatusResult) => void;
  const pendingRead = vi.fn((_reference: unknown, signal?: AbortSignal) => {
    pendingSignal = signal;
    return new Promise<CaptureStatusResult>((done) => {
      resolve = done;
    });
  });
  const nextRef = { ...status.captureRef, id: "next" };
  view.rerender(
    <LiveCaptureStatus {...props} reference={nextRef} read={pendingRead} />,
  );
  expect(screen.queryByText("100")).not.toBeInTheDocument();
  await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(pendingSignal?.aborted).toBe(true);
  await act(async () => resolve(status));
  expect(screen.queryByText("100")).not.toBeInTheDocument();
});
