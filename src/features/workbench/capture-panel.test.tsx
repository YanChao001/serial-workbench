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
import { toast } from "sonner";
import type {
  CaptureStatusResult,
  Operation,
} from "@serial-workbench/contracts";
import { CapturePanel } from "./capture-panel";
import { labels, operation } from "./test-fixtures";
import { operationText } from "./operation-text";
import { createTranslator } from "../../i18n/translate";
import { en } from "../../i18n/en";
import { zhCN } from "../../i18n/zh-CN";
import { clearUserLog, getUserLog } from "@/lib/user-log";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

it.each([en, zhCN])(
  "shows localized recording summaries and keeps exact operation facts in explicit details",
  (dictionary) => {
    const t = createTranslator(dictionary);
    const text = operationText(t, labels.operationText.failure);
    const summary = {
      ...operation("internal-operation-id"),
      actionId: "capture.verify",
      state: "succeeded" as const,
      progress: { completed: "1250000", total: "1500000", unit: "bytes" },
    };
    render(
      <CapturePanel
        watchActions={allowControlActions}
        operations={[]}
        summaries={[summary]}
        labels={{ ...labels, operationText: text }}
        disabled={false}
      />,
    );
    expect(screen.getByText(t("workbench.tools.verify"))).toBeInTheDocument();
    expect(
      screen.getByText(t("workbench.operation.succeeded")),
    ).toBeInTheDocument();
    expect(screen.getByText("1.25 MB / 1.50 MB")).toBeInTheDocument();
    expect(screen.queryByText("capture.verify")).not.toBeInTheDocument();
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
    expect(screen.queryByText("internal-operation-id")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: text.details }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: text.details }));
    const detail = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: text.details,
    });
    expect(detail.value).toContain('"operationId": "internal-operation-id"');
    expect(detail.value).toContain('"actionId": "capture.verify"');
    expect(detail.value).toContain('"state": "succeeded"');
  },
);

it("keeps historical recording failures in the record without replaying notices when the tool is reopened", () => {
  const failed = {
    ...operation("capture-failure"),
    actionId: "capture.verify",
    state: "failed" as const,
    errorCode: "PERMISSION_DENIED",
  };
  const content = (summary = failed) => (
    <CapturePanel
      watchActions={allowControlActions}
      operations={[]}
      summaries={[summary]}
      labels={labels}
      disabled={false}
    />
  );
  const view = render(content());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByText(labels.operationText.failure("PERMISSION_DENIED")),
  ).toBeInTheDocument();
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
  view.rerender(content({ ...failed }));
  view.unmount();
  render(content());
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
});
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
  await screen.findByText("123 records");
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
  await screen.findByText("999 records");
  view.rerender(<CapturePanel {...props} operations={[running("second")]} />);
  expect(screen.queryByText("999 records")).not.toBeInTheDocument();
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
