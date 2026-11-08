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
  CaptureRecord,
  ReplayReadParams,
  ReplayReadResult,
} from "@serial-workbench/contracts";
import { ReplayPanel } from "./replay-panel";
import { labels, operation, session } from "./test-fixtures";
afterEach(cleanup);
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
        timeDetails: "时间详情",
        clock: "时钟",
        timeSource: "来源",
        resolution: "精度",
        missingTime: "无时间",
        receivedTime: "接收时间",
        sourceTime: "来源时间",
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
  fireEvent.click(screen.getByRole("button", { name: "Read replay 42" }));
  await screen.findByText("HELLO");
  expect(
    screen.getByText("HELLO").closest(".workbench-stream-content"),
  ).toHaveStyle({
    fontFamily: "Consolas",
    fontSize: "18px",
    lineHeight: "1.75",
    fontVariantLigatures: "normal",
  });
  expect(screen.getByTitle("时间详情")).toHaveTextContent(
    "2026-11-08T00:00:00Z",
  );
  expect(screen.getByTitle("时间详情")).toHaveAccessibleName(
    "2026-11-08T00:00:00Z",
  );
  expect(screen.getByText("时钟: clock")).toBeInTheDocument();
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
