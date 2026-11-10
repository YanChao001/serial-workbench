import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMetrics, SessionMetrics } from "@serial-workbench/contracts";
import { MetricsPanel } from "./metrics-panel";
import { labels } from "./test-fixtures";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const metrics: HostMetrics = {
  hostId: "host",
  instanceEpoch: "1",
  processId: "42",
  observedAt: "2026-11-08T04:00:00Z",
  rssBytes: "9007199254740999",
  rssPeakBytes: "9007199254741000",
  source: { usedBytes: "13", peakBytes: "20", limitBytes: "40" },
  reader: { usedBytes: "3", peakBytes: "5", limitBytes: "10" },
  captureQueue: { usedBytes: "7", peakBytes: "8", limitBytes: "16" },
};
it("updates Host metrics automatically, keeps exact values in details and cancels on close", async () => {
  vi.useFakeTimers();
  let pending: AbortSignal | undefined;
  const read = vi
    .fn()
    .mockResolvedValueOnce(metrics)
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" })
    .mockImplementationOnce((signal: AbortSignal) => {
      pending = signal;
      return new Promise(() => {});
    });
  const view = render(
    <>
      <Toaster />
      <MetricsPanel read={read} labels={labels} />
    </>,
  );
  await act(async () => {});
  expect(screen.getByTitle("9007199254740999")).toHaveTextContent("9.01 PB");
  expect(screen.getByTitle("13 / 40")).toHaveTextContent("13 B / 40 B");
  expect(screen.getByTitle(metrics.observedAt)).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("alert")).toHaveTextContent(
    labels.operationText.failure("PERMISSION_DENIED"),
  );
  expect(
    screen
      .getByRole("region", { name: labels.metrics })
      .querySelector('[role="alert"]'),
  ).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(pending?.aborted).toBe(true);
  vi.useRealTimers();
});

it("reports one safe notification and module log for repeated metrics failures, then a new recovery episode", async () => {
  vi.useFakeTimers();
  const notify = vi.spyOn(toast, "custom");
  const read = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    message: "private path C:\\private-user-data and raw diagnostic input",
  });
  const view = render(
    <>
      <Toaster />
      <MetricsPanel read={read} labels={labels} />
    </>,
  );
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent(
    labels.operationText.failure("PERMISSION_DENIED"),
  );
  expect(
    screen.queryByText(/private-user-data|\[object Object\]/),
  ).not.toBeInTheDocument();
  expect(getUserLog()).toMatchObject([
    {
      module: "application",
      level: "error",
      code: "PERMISSION_DENIED",
      count: 1,
    },
  ]);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(read).toHaveBeenCalledTimes(4);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(getUserLog()[0]?.count).toBe(1);
  read.mockResolvedValueOnce(metrics);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(notify).toHaveBeenCalledTimes(2);
  expect(getUserLog()[0]?.count).toBe(2);
  view.unmount();
});
it("discards late metrics when the connection reader changes", async () => {
  let resolve!: (value: HostMetrics) => void;
  const old = vi.fn(
    () =>
      new Promise<HostMetrics>((done) => {
        resolve = done;
      }),
  );
  const next = vi.fn().mockResolvedValue({ ...metrics, rssBytes: "222" });
  const view = render(<MetricsPanel read={old} labels={labels} />);
  view.rerender(<MetricsPanel read={next} labels={labels} />);
  await screen.findByText("222 B");
  await act(async () => resolve(metrics));
  expect(screen.queryByText(metrics.rssBytes)).not.toBeInTheDocument();
});

const sessionMetrics: SessionMetrics = {
  sessionId: "session",
  sessionEpoch: "1",
  instanceEpoch: "7",
  observedAt: "2026-11-08T00:00:01Z",
  observedMonoNs: "1000000000",
  connectionDurationMs: "999",
  rxBytes: "9007199254741999",
  txAcceptedBytes: "9007199254742000",
  txUnknownBytes: "111",
  rxReadErrors: "7",
  txWriteErrors: "8",
  rxBytesPerSecond: "222",
  txAcceptedBytesPerSecond: "333",
  rateWindowMs: "1000",
  rateResolutionMs: "10",
  lineErrorsAvailable: false,
  frameCountsAvailable: false,
};

it("reports an invalid session sample through the serial log without showing stale session data", async () => {
  vi.useFakeTimers();
  const readSession = vi
    .fn()
    .mockResolvedValue({ ...sessionMetrics, sessionEpoch: "9" });
  render(
    <>
      <Toaster />
      <MetricsPanel
        read={async () => metrics}
        readSession={readSession}
        labels={labels}
        target={{
          hostId: "host",
          kind: "session",
          id: "session",
          sessionId: "session",
          sessionEpoch: "1",
        }}
      />
    </>,
  );
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("alert")).toHaveTextContent(
    labels.operationText.failure("EPOCH_MISMATCH"),
  );
  expect(screen.queryByTitle(sessionMetrics.rxBytes)).not.toBeInTheDocument();
  expect(getUserLog()).toMatchObject([
    { module: "serial", code: "EPOCH_MISMATCH", count: 1 },
  ]);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(getUserLog()[0]?.count).toBe(1);
  expect(
    screen
      .getByRole("region", { name: labels.sessionMetrics })
      .querySelector('[role="alert"]'),
  ).toBeNull();
});

it("reads authoritative counters for the active session alongside Host memory", async () => {
  const target = {
    hostId: "host",
    kind: "session",
    id: "session",
    sessionId: "session",
    sessionEpoch: "1",
  };
  const readSession = vi.fn().mockResolvedValue(sessionMetrics);
  render(
    <MetricsPanel
      read={async () => metrics}
      labels={labels}
      {...{ readSession, target }}
    />,
  );
  await waitFor(() =>
    expect(readSession).toHaveBeenCalledWith(target, expect.any(AbortSignal)),
  );
  expect(await screen.findByTitle("9007199254741999")).toBeInTheDocument();
  expect(screen.getByTitle("9007199254742000")).toBeInTheDocument();
  expect(screen.getByTitle("9007199254740999")).toBeInTheDocument();
});

it("polls only the current session, clears old target values, and aborts reads on close", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: SessionMetrics) => void;
    let pending: AbortSignal | undefined;
    const readSession = vi
      .fn()
      .mockResolvedValueOnce(sessionMetrics)
      .mockImplementationOnce((_target: unknown, signal?: AbortSignal) => {
        pending = signal;
        return new Promise((done) => {
          finish = done;
        });
      })
      .mockResolvedValue({
        ...sessionMetrics,
        sessionId: "second",
        sessionEpoch: "2",
        rxBytes: "7777777",
      });
    const target = {
      hostId: "host",
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    };
    const read = vi.fn().mockResolvedValue(metrics);
    const view = render(
      <MetricsPanel
        read={read}
        readSession={readSession}
        target={target}
        labels={labels}
      />,
    );
    await act(async () => {});
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("9007199254741999")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    view.rerender(
      <MetricsPanel
        read={read}
        readSession={readSession}
        target={{
          ...target,
          id: "second",
          sessionId: "second",
          sessionEpoch: "2",
        }}
        labels={labels}
      />,
    );
    await act(async () => {});
    expect(pending?.aborted).toBe(true);
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(screen.queryByTitle("9007199254741999")).not.toBeInTheDocument();
    expect(screen.getByTitle("7777777")).toBeInTheDocument();
    await act(async () => finish(sessionMetrics));
    expect(screen.queryByTitle("9007199254741999")).not.toBeInTheDocument();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readSession).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("stops both background and session sampling while hidden and resumes each once", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const read = vi.fn().mockResolvedValue(metrics);
  const readSession = vi.fn().mockResolvedValue(sessionMetrics);
  const view = render(
    <MetricsPanel
      read={read}
      readSession={readSession}
      labels={labels}
      target={{
        hostId: "host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      }}
    />,
  );
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(readSession).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(true);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(readSession).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(readSession).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(readSession).toHaveBeenCalledTimes(2);
});
