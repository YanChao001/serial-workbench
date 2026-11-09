import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMetrics, SessionMetrics } from "@serial-workbench/contracts";
import { MetricsPanel } from "./metrics-panel";
import { labels } from "./test-fixtures";
afterEach(cleanup);
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
it("shows exact Host values, refresh errors, and cancels an outstanding read on unmount", async () => {
  let pending: AbortSignal | undefined;
  const read = vi
    .fn()
    .mockResolvedValueOnce(metrics)
    .mockRejectedValueOnce(new Error("PERMISSION_DENIED"))
    .mockImplementationOnce((signal: AbortSignal) => {
      pending = signal;
      return new Promise(() => {});
    });
  const view = render(<MetricsPanel read={read} labels={labels} />);
  expect(await screen.findByText("9007199254740999")).toBeInTheDocument();
  expect(screen.getByText("13 / 40")).toBeInTheDocument();
  expect(screen.getByText(metrics.observedAt)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "PERMISSION_DENIED",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  view.unmount();
  expect(pending?.aborted).toBe(true);
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
  await screen.findByText("222");
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
  expect(await screen.findByText("9007199254741999")).toBeInTheDocument();
  expect(screen.getByText("9007199254742000")).toBeInTheDocument();
  expect(screen.getByText("9007199254740999")).toBeInTheDocument();
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
    expect(screen.getByText("9007199254741999")).toBeInTheDocument();
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
    expect(screen.queryByText("9007199254741999")).not.toBeInTheDocument();
    expect(screen.getByText("7777777")).toBeInTheDocument();
    await act(async () => finish(sessionMetrics));
    expect(screen.queryByText("9007199254741999")).not.toBeInTheDocument();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readSession).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
