import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CaptureRecord,
  ReplayReadParams,
  ReplayReadResult,
} from "@serial-workbench/contracts";
import { ReplayPanel } from "./replay-panel";
import { compactStreamTime } from "./stream-presentation";
import { labels, operation, session } from "./test-fixtures";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
  vi.restoreAllMocks();
});

it("keeps referenced records and exact TX settlement facts in an explicit detail panel", async () => {
  const read = vi.fn().mockResolvedValue({
    records: [
      {
        kind: "reference",
        recordOrdinal: "42",
        jsonBytes: "200",
        jsonSha256: "a".repeat(64),
        recordRef: {
          hostId: "host",
          kind: "capture_record",
          id: "large-record",
          revision: "1",
        },
      },
      {
        kind: "inline",
        record: {
          recordOrdinal: "43",
          entry: {
            kind: "tx_settlement",
            value: {
              hostId: "host",
              instanceEpoch: "1",
              receipt: {
                operationId: "private-operation-uuid",
                sessionId: "session",
                sessionEpoch: "1",
                outcome: "accepted",
                bytesBase64: "SEVMTE8=",
                byteStart: "9007199254740999",
                byteEnd: "9007199254741004",
                acceptedRanges: [
                  { start: "9007199254740999", end: "9007199254741004" },
                ],
                unknownRanges: [],
                peerAcknowledged: false,
              },
            },
          },
        },
      },
    ],
    readerGeneration: "1",
    nextRecord: "44",
    atEnd: true,
  } satisfies ReplayReadResult);
  render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={vi.fn()}
      control={vi.fn()}
      disabled={false}
      labels={labels}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.readReplay }));
  await screen.findByText(labels.atEnd);
  expect(
    screen.queryByRole("button", { name: "Read replay 42" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/private-operation-uuid/)).not.toBeInTheDocument();
  expect(screen.queryByText(/9007199254740999/)).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: labels.operationText.details,
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Read replay 42" }),
  ).toBeVisible();
  expect(screen.getByText(labels.accepted)).toBeVisible();
  expect(screen.getByText(/Requested bytes.*9007199254740999/)).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: labels.receipt }),
  ).toHaveDisplayValue(/private-operation-uuid/);
});

it("routes replay failures to safe notifications and capture logs without adding an inline error", async () => {
  const read = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    message: "private capture path and diagnostic input",
  });
  const notify = vi.spyOn(toast, "custom");
  const props = {
    session: session(),
    read,
    readRecord: vi.fn(),
    control: vi.fn(),
    disabled: false,
    labels,
  };
  const view = render(
    <>
      <Toaster />
      <ReplayPanel {...props} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.readReplay }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    labels.operationText.failure("PERMISSION_DENIED"),
  );
  expect(
    screen.queryByText(/private capture path|\[object Object\]/),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: labels.replay })).queryByRole(
      "alert",
    ),
  ).not.toBeInTheDocument();
  expect(getUserLog()).toMatchObject([
    { module: "capture", code: "PERMISSION_DENIED", count: 1 },
  ]);
  expect(notify).toHaveBeenCalledOnce();
  view.rerender(
    <>
      <Toaster />
      <ReplayPanel {...props} />
    </>,
  );
  expect(notify).toHaveBeenCalledOnce();
});
it("aborts an old replay read when its connection changes and ignores its late page", async () => {
  let oldSignal: AbortSignal | undefined;
  let resolve!: (value: ReplayReadResult) => void;
  const old = vi.fn((_params: unknown, signal?: AbortSignal) => {
    oldSignal = signal;
    return new Promise<ReplayReadResult>((done) => {
      resolve = done;
    });
  });
  const props = {
    session: session(),
    readRecord: vi.fn(),
    control: vi.fn(),
    disabled: false,
    labels,
  };
  const view = render(<ReplayPanel {...props} read={old} />);
  fireEvent.click(screen.getByRole("button", { name: "Read replay" }));
  const next = vi.fn().mockResolvedValue({
    records: [],
    readerGeneration: "2",
    nextRecord: "0",
    atEnd: false,
  });
  view.rerender(<ReplayPanel {...props} read={next} />);
  expect(oldSignal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Read replay" }));
  await waitFor(() => expect(next).toHaveBeenCalledOnce());
  await act(async () =>
    resolve({
      records: [],
      readerGeneration: "1",
      nextRecord: "1",
      atEnd: true,
    }),
  );
  expect(screen.queryByText("End reached")).not.toBeInTheDocument();
});
it("reads only on request, renders checked referenced records, and seeks with the exact session epoch", async () => {
  const record: CaptureRecord = {
    recordOrdinal: "42",
    entry: {
      kind: "event",
      value: {
        hostId: "host",
        instanceEpoch: "1",
        sessionId: "session",
        sessionEpoch: "1",
        eventSeq: "1",
        configurationRevision: "1",
        time: {
          clockId: "clock",
          sourceMonoNs: "1",
          receivedWallTime: "2026-11-08T00:00:00Z",
          precision: {
            source: "host_read",
            resolutionNs: "1",
            syncMethod: "none",
          },
        },
        kind: "rx",
        payload: {
          bytesBase64: "SEVMTE8=",
          byteStart: "9007199254740999",
          byteEnd: "9007199254741004",
        },
      },
    },
  };
  const page: ReplayReadResult = {
    records: [
      {
        kind: "reference",
        recordRef: {
          hostId: "host",
          kind: "capture_record",
          id: "record",
          revision: "1",
        },
        recordOrdinal: "42",
        jsonBytes: "200",
        jsonSha256: "a".repeat(64),
      },
    ],
    readerGeneration: "1",
    nextRecord: "43",
    atEnd: true,
  };
  const read = vi.fn(async (params: ReplayReadParams) => {
      const records = BigInt(params.maxRecords);
      const bytes = BigInt(params.maxBytes);
      // 与真实 ReplayReader::read_with_references 的预算拒绝条件一致。
      if (records === 0n || records > 100n || bytes === 0n || bytes > 1048576n)
        throw new Error("Invalid replay read budget");
      return page;
    }),
    readRecord = vi.fn().mockResolvedValue(record),
    control = vi.fn().mockResolvedValue(operation());
  const view = render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={readRecord}
      control={control}
      disabled={false}
      labels={labels}
      terminalSettings={{
        receiveMode: "text",
        sendMode: "text",
        lineEnding: { kind: "none" },
        typography: {
          fontFamily: "Consolas",
          fontSize: 18,
          lineHeightPercent: 175,
          ligatures: true,
        },
      }}
      presentationLabels={{
        timeMode: "时间显示",
        absoluteTime: "绝对时间",
        relativeTime: "相对时间",
        intervalTime: "间隔",
        missingTime: "无时间",
        replay: "回放",
      }}
    />,
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Read replay" }));
  await screen.findByText("End reached");
  expect(read).toHaveBeenCalledWith(
    {
      sessionId: "session",
      sessionEpoch: "1",
      maxRecords: "100",
      maxBytes: "65536",
    },
    expect.any(AbortSignal),
  );
  expect(readRecord).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: labels.operationText.details,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Read replay 42" }));
  await screen.findByText("HELLO");
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: labels.operationText.details,
    }),
    { key: "Escape" },
  );
  expect(
    screen.getByText("HELLO").closest(".workbench-stream-content"),
  ).toHaveStyle({
    fontFamily: "Consolas",
    fontSize: "18px",
    lineHeight: "1.75",
    fontVariantLigatures: "normal",
  });
  const timestamp = screen.getByRole("log").querySelector("time");
  expect(timestamp).toHaveAttribute("datetime", "2026-11-08T00:00:00Z");
  expect(timestamp).toHaveTextContent(
    compactStreamTime("2026-11-08T00:00:00Z"),
  );
  expect(screen.queryByText("时钟: clock")).not.toBeInTheDocument();
  expect(readRecord).toHaveBeenCalledWith(
    page.records[0],
    expect.any(AbortSignal),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Seek to record" }), {
    target: { value: "9007199254740999" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Seek to record" }));
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith(
      {
        sessionId: "session",
        sessionEpoch: "1",
        paused: true,
        seekRecord: "9007199254740999",
      },
      expect.any(AbortSignal),
    ),
  );
  view.rerender(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={readRecord}
      control={control}
      disabled={true}
      labels={labels}
    />,
  );
  expect(screen.getByRole("button", { name: "Pause replay" })).toBeDisabled();
});
