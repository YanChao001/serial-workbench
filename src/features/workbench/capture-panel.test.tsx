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
import type {
  CaptureStatusResult,
  Operation,
} from "@serial-workbench/contracts";
import { CapturePanel } from "./capture-panel";
import { labels, operation } from "./test-fixtures";
afterEach(cleanup);
it("reads the live reference of a running capture before offering exact-target stop", async () => {
  const reference = { hostId: "host", kind: "capture", id: "live" };
  const running: Operation = {
    ...operation("capture"),
    actionId: "capture.start",
    state: "running",
    result: { kind: "reference", value: { resultRef: reference } },
  };
  const status: CaptureStatusResult = {
    captureRef: reference,
    ownerOperationId: "capture",
    summary: {
      captureId: "live",
      state: "recording",
      watermarks: {
        written: "123",
        flushed: "120",
        synced: "110",
        verified: "0",
      },
      containerComplete: false,
      sourceContinuous: true,
    },
  };
  const read = vi.fn().mockResolvedValue(status),
    stop = vi.fn().mockResolvedValue(undefined);
  render(
    <CapturePanel
      watchActions={allowControlActions}
      operations={[running]}
      summaries={[running]}
      labels={labels}
      disabled={false}
      readStatus={read}
      onStop={stop}
    />,
  );
  await screen.findByText("123");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Stop capture" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop capture" }));
  await waitFor(() =>
    expect(stop).toHaveBeenCalledWith(reference, expect.any(AbortSignal)),
  );
});
it("clears a live status receipt when the same operation points to another capture", async () => {
  const observer = observeControlActions();
  const reference = { hostId: "host", kind: "capture", id: "first" };
  const read = vi.fn().mockResolvedValue({
    captureRef: reference,
    summary: {
      captureId: "first",
      state: "recording",
      watermarks: {
        written: "999",
        flushed: "0",
        synced: "0",
        verified: "0",
      },
      containerComplete: false,
      sourceContinuous: true,
    },
  });
  const running = (id: string): Operation => ({
    ...operation("capture"),
    actionId: "capture.start",
    state: "running",
    result: { kind: "reference", value: { resultRef: { ...reference, id } } },
  });
  const props = {
    summaries: [],
    labels,
    disabled: false,
    readStatus: read,
    watchActions: observer.watchActions,
  };
  const view = render(
    <CapturePanel {...props} operations={[running("first")]} />,
  );
  act(() => observer.publish(observer.subscriptions[0]!, () => true));
  await screen.findByText("999");
  view.rerender(<CapturePanel {...props} operations={[running("second")]} />);
  expect(screen.queryByText("999")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Capture first")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not read an unobserved live capture and ignores an old attachment callback", async () => {
  const observer = observeControlActions();
  const reference = {
    hostId: "host",
    kind: "capture",
    id: "first",
    revision: "1",
  };
  const read = vi.fn().mockResolvedValue({
    captureRef: reference,
    summary: {
      captureId: "first",
      state: "recording",
      watermarks: { written: "9", flushed: "0", synced: "0", verified: "0" },
      containerComplete: false,
      sourceContinuous: true,
    },
  });
  const props = {
    summaries: [],
    labels,
    disabled: false,
    readStatus: read,
    watchActions: observer.watchActions,
  };
  const running = (id: string): Operation => ({
    ...operation(id),
    actionId: "capture.start",
    state: "running",
    result: { kind: "reference", value: { resultRef: { ...reference, id } } },
  });
  const view = render(
    <CapturePanel {...props} operations={[running("first")]} />,
  );
  expect(read).not.toHaveBeenCalled();
  const first = observer.subscriptions[0]!;
  view.rerender(<CapturePanel {...props} operations={[running("second")]} />);
  act(() => observer.publish(first, () => true));
  expect(read).not.toHaveBeenCalled();
  const second = observer.subscriptions.at(-1)!;
  expect(second.inputs).toEqual([
    {
      actionId: "capture.status",
      target: { hostId: "host", kind: "capture", id: "second" },
      params: { captureRef: { ...reference, id: "second" } },
    },
  ]);
  act(() => observer.publish(second, () => true));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(read).toHaveBeenCalledWith(
    { ...reference, id: "second" },
    expect.any(AbortSignal),
  );
});
