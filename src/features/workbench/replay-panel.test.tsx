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
  ReplayControlParams,
  ReplayReadParams,
  ReplayReadResult,
  ReplaySearchHit,
  ReplaySearchParams,
  ReplaySearchResult,
} from "@serial-workbench/contracts";
import { en } from "@/i18n/en";
import { createTranslator } from "@/i18n/translate";
import type { HostContextValue } from "@/providers/host-context";
import { ReplayPanel } from "./replay-panel";
import { compactStreamTime } from "./stream-presentation";
import { labels, session } from "./test-fixtures";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
  vi.restoreAllMocks();
});

it("uses the archive mode for gap-only pages and displays transformed text with original bounds", async () => {
  const source = {
    hostId: "host",
    instanceEpoch: "2",
    sessionId: "original",
    sessionEpoch: "3",
  };
  const first: ReplayReadResult = {
    mode: "redacted",
    readerGeneration: "1",
    nextRecord: "2",
    atEnd: false,
    playback: { rate: { kind: "fastest" }, paused: true, breakpointHit: false },
    records: [
      {
        kind: "inline",
        record: {
          recordOrdinal: "1",
          entry: {
            kind: "reader_gap",
            value: {
              ...source,
              reason: "capture_overflow",
              missingEventRange: { start: "1", end: "2" },
            },
          },
        },
      },
    ],
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({
      ...first,
      atEnd: true,
      nextRecord: "4",
      records: [
        {
          kind: "inline",
          record: {
            recordOrdinal: "2",
            entry: {
              kind: "redacted",
              value: {
                ...source,
                timestamp: "2026-11-25T03:00:00Z",
                eventStart: "2",
                eventEnd: "4",
                byteRange: { direction: "tx", start: "10", end: "30" },
                result: {
                  kind: "text",
                  text: "status=ready token=[hidden]",
                  replacements: "1",
                },
              },
            },
          },
        },
        {
          kind: "inline",
          record: {
            recordOrdinal: "3",
            entry: {
              kind: "redacted",
              value: {
                ...source,
                timestamp: "2026-11-25T03:00:01Z",
                eventStart: "4",
                eventEnd: "5",
                result: { kind: "omitted", reason: "incomplete" },
              },
            },
          },
        },
      ],
    } satisfies ReplayReadResult);
  render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={vi.fn()}
      control={vi.fn()}
      disabled={false}
      playbackSupported
      search={{
        run: vi.fn(),
        t: searchLabels,
        hostId: "host",
        watchActions: allowSearch,
      }}
      labels={labels}
    />,
  );
  const load = screen.getByRole("button", { name: labels.readReplay });
  expect(
    screen.getByRole("button", { name: "Search recording" }),
  ).toBeVisible();
  fireEvent.click(load);
  const firstPage = await screen.findByRole("list", {
    name: labels.captureRedacted,
  });
  expect(within(firstPage).getByText(labels.captureRedactedGap)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Search recording" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: labels.replayFieldChart }),
  ).not.toBeInTheDocument();
  fireEvent.click(load);
  expect(await screen.findByText("status=ready token=[hidden]")).toBeVisible();
  expect(
    screen.getByText(`${labels.captureRedactionTxAttempt} [10, 30)`),
  ).toBeVisible();
  expect(
    screen.getByText(labels.captureRedactionOmitted.incomplete),
  ).toBeVisible();
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
    control = vi.fn().mockResolvedValue({
      records: [],
      readerGeneration: "2",
      nextRecord: "9007199254740999",
      atEnd: false,
    } satisfies ReplayReadResult);
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

it("requests an atomic one-record step while preserving the explicit replay read budget", async () => {
  const result: ReplayReadResult = {
    records: [],
    readerGeneration: "1",
    nextRecord: "43",
    atEnd: false,
    playback: {
      rate: { kind: "timed", speedPercent: 100 },
      paused: true,
      breakpointRecord: "43",
      breakpointHit: false,
    },
  };
  const { playback, ...position } = result;
  const read = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({
      ...position,
      playback: { ...playback, paused: false },
    })
    .mockResolvedValueOnce({
      ...position,
      playback: { ...playback, breakpointHit: true },
    });
  const control = vi.fn().mockResolvedValue(position);
  render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={vi.fn()}
      control={control}
      playbackSupported
      disabled={false}
      labels={labels}
    />,
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Step one record" }));
  await screen.findByText("Paused");
  const raw = {
    sessionId: "session",
    sessionEpoch: "1",
    maxBytes: "65536",
  };
  expect(read).toHaveBeenNthCalledWith(
    1,
    { ...raw, maxRecords: "1", reportPlayback: true, singleStep: true },
    expect.any(AbortSignal),
  );
  expect(control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume replay" }));
  await screen.findByText("Next record 43");
  expect(control).toHaveBeenCalledWith(
    { sessionId: "session", sessionEpoch: "1", paused: false },
    expect.any(AbortSignal),
  );
  expect(read).toHaveBeenNthCalledWith(
    2,
    { ...raw, maxRecords: "1", inspectPlayback: true },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Read replay" }));
  await screen.findByText("Breakpoint reached 43");
  expect(read).toHaveBeenNthCalledWith(
    3,
    { ...raw, maxRecords: "100", reportPlayback: true },
    expect.any(AbortSignal),
  );
});

it("sets and clears an exact breakpoint using snapshots requested after the control terminal", async () => {
  const record = "9007199254740999";
  const playback = {
    rate: { kind: "fastest" },
    paused: false,
    breakpointHit: false,
  } as const;
  const result: ReplayReadResult = {
    records: [],
    readerGeneration: "1",
    nextRecord: "1",
    atEnd: false,
  };
  let complete!: (reply: ReplayReadResult) => void;
  const control = vi
    .fn<
      (
        _params: ReplayControlParams,
        _signal?: AbortSignal,
      ) => Promise<ReplayReadResult>
    >()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(result);
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      ...result,
      playback: { ...playback, breakpointRecord: record },
    })
    .mockResolvedValueOnce({ ...result, playback });
  render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={vi.fn()}
      control={control}
      playbackSupported
      disabled={false}
      labels={labels}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Playback options" }));
  const input = screen.getByRole("textbox", { name: "Breakpoint record" });
  const set = screen.getByRole("button", { name: "Set breakpoint" });
  const clear = screen.getByRole("button", { name: "Clear breakpoint" });
  expect(set).toBeDisabled();
  expect(clear).toBeDisabled();
  fireEvent.change(input, { target: { value: "0" } });
  expect(set).toBeDisabled();
  fireEvent.change(input, { target: { value: record } });
  fireEvent.click(set);
  const base = {
    sessionId: "session",
    sessionEpoch: "1",
    paused: false,
  };
  expect(control).toHaveBeenNthCalledWith(
    1,
    { ...base, playback: { kind: "set_breakpoint", record } },
    expect.any(AbortSignal),
  );
  expect(clear).toBeDisabled();
  expect(read).not.toHaveBeenCalled();
  await act(async () => complete(result));
  expect(clear).toBeEnabled();
  fireEvent.click(clear);
  await waitFor(() => expect(input).toHaveValue(""));
  expect(control).toHaveBeenNthCalledWith(
    2,
    { ...base, playback: { kind: "set_breakpoint" } },
    expect.any(AbortSignal),
  );
  expect(read).toHaveBeenCalledTimes(2);
  for (const call of [1, 2]) {
    expect(read).toHaveBeenNthCalledWith(
      call,
      {
        sessionId: "session",
        sessionEpoch: "1",
        maxRecords: "1",
        maxBytes: "65536",
        inspectPlayback: true,
      },
      expect.any(AbortSignal),
    );
  }
});

it("preserves the confirmed control position when inspecting playback fails", async () => {
  const control = vi.fn().mockResolvedValue({
    records: [],
    readerGeneration: "2",
    nextRecord: "5",
    atEnd: false,
  } satisfies ReplayReadResult);
  const read = vi
    .fn()
    .mockRejectedValue(new Error("Playback inspection failed"));
  render(
    <ReplayPanel
      session={session()}
      read={read}
      readRecord={vi.fn()}
      control={control}
      playbackSupported
      disabled={false}
      labels={labels}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Seek to record" }), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Seek to record" }));
  await screen.findByText("Next record 5");
  expect(control).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
});

const recordingName = "south-line-replay-with-long-recording-filename.swbc";
const match: ReplaySearchHit = {
  firstRecord: "43",
  lastRecord: "44",
  byteStart: "9007199254740993",
  byteEnd: "9007199254740997",
  direction: "rx",
};
const searchLabels = createTranslator(en);
const allowSearch: HostContextValue["watchActions"] = (inputs, publish) => {
  publish(
    inputs.map((input) => ({
      input,
      result: { actionId: input.actionId, target: input.target, allowed: true },
      error: null,
    })),
  );
  return () => {};
};

it("removes a visible search page on source revocation and starts clean after regrant", async () => {
  let publishAccess = (_allowed: boolean) => {};
  const watchActions: HostContextValue["watchActions"] = (inputs, publish) => {
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.actionId).toBe("replay.read");
    publishAccess = (allowed) =>
      publish(
        inputs.map((input) => ({
          input,
          result: { actionId: input.actionId, target: input.target, allowed },
          error: null,
        })),
      );
    publishAccess(true);
    return () => {};
  };
  const run = vi.fn(
    async ({ command }: ReplaySearchParams): Promise<ReplaySearchResult> =>
      command.kind === "stop"
        ? { kind: "stopped", searchId: command.searchId, stopped: true }
        : searchPage(command.searchId, "1", [match]),
  );
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      read={vi.fn()}
      readRecord={vi.fn()}
      control={vi.fn()}
      search={{ run, t: searchLabels, hostId: "host", watchActions }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search recording" }));
  const dialog = screen.getByRole("dialog", { name: "Search recording" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search content" }),
    {
      target: { value: "PING" },
    },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Start search" }));
  expect(
    await within(dialog).findByRole("button", { name: "Continue search" }),
  ).toBeVisible();
  await act(async () => publishAccess(false));
  expect(
    screen.queryByRole("dialog", { name: "Search recording" }),
  ).not.toBeInTheDocument();
  expect(run.mock.calls.map(([request]) => request.command.kind)).toEqual([
    "start",
    "stop",
  ]);
  await act(async () => publishAccess(true));
  fireEvent.click(screen.getByRole("button", { name: "Search recording" }));
  const nextDialog = screen.getByRole("dialog", { name: "Search recording" });
  expect(
    within(nextDialog).getByRole("textbox", { name: "Search content" }),
  ).toHaveValue("");
  expect(
    within(nextDialog).queryByRole("button", { name: "Continue search" }),
  ).not.toBeInTheDocument();
});

function searchPage(
  searchId: string,
  page: string,
  hits: ReplaySearchHit[],
  complete = false,
): ReplaySearchResult {
  return {
    kind: "page",
    searchId,
    page,
    result: { hits, scannedRecords: page, totalRecords: "100", complete },
  };
}

it("browses exact archive ordinals and locates search hits without moving playback", async () => {
  const play: ReplayReadResult = {
    records: [],
    readerGeneration: "3",
    nextRecord: "17",
    atEnd: false,
    playback: {
      rate: { kind: "fastest" },
      paused: false,
      breakpointHit: false,
    },
  };
  const read = vi.fn(
    async (params: ReplayReadParams): Promise<ReplayReadResult> => {
      if (!params.archive) return play;
      const first =
        BigInt(params.archive.record) -
        (params.archive.kind === "before" ? 1n : 0n);
      return {
        records: [
          {
            kind: "reference",
            recordOrdinal: String(first),
            jsonBytes: "200",
            jsonSha256: "a".repeat(64),
            recordRef: {
              hostId: "host",
              kind: "capture_record",
              id: "archive-record",
              revision: "1",
            },
          },
        ],
        readerGeneration: "3",
        nextRecord: String(first + 1n),
        atEnd: first === 1000000n,
        archiveTotalRecords: "1000000",
      };
    },
  );
  const control = vi.fn();
  const run = vi.fn(
    async ({ command }: ReplaySearchParams): Promise<ReplaySearchResult> =>
      command.kind === "stop"
        ? { kind: "stopped", searchId: command.searchId, stopped: true }
        : searchPage(command.searchId, "1", [match], true),
  );
  const archiveAccess = { hostId: "host", watchActions: allowSearch };
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      archiveAccess={archiveAccess}
      read={read}
      readRecord={vi.fn()}
      control={control}
      search={{ ...archiveAccess, run, t: searchLabels }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.readReplay }));
  expect(
    await screen.findByText(labels.replayNextRecord + " 17"),
  ).toBeVisible();
  const toggle = screen.getByRole("button", { name: labels.browseReplay });
  fireEvent.click(toggle);
  expect(await screen.findByText("1–1 / 1000000")).toBeVisible();
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByRole("button", { name: labels.previousReplayPage }),
  ).toBeDisabled();
  const seek = screen.getByRole("textbox", { name: labels.seekRecord });
  fireEvent.change(seek, { target: { value: "1000000" } });
  fireEvent.keyDown(seek, { key: "Enter" });
  expect(await screen.findByText("1000000–1000000 / 1000000")).toBeVisible();
  expect(
    screen.getByRole("button", { name: labels.nextReplayPage }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: labels.previousReplayPage }),
  );
  expect(await screen.findByText("999999–999999 / 1000000")).toBeVisible();
  expect(read.mock.lastCall?.[0].archive).toEqual({
    kind: "before",
    record: "1000000",
  });
  fireEvent.click(screen.getByRole("button", { name: labels.nextReplayPage }));
  expect(await screen.findByText("1000000–1000000 / 1000000")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Search recording" }));
  const dialog = screen.getByRole("dialog", { name: "Search recording" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search content" }),
    {
      target: { value: "PING" },
    },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Start search" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Go to record" }),
  );
  expect(
    await screen.findByText(/43–43 \/ 1000000.*Located record 43/),
  ).toBeVisible();
  expect(read.mock.lastCall?.[0].archive).toEqual({
    kind: "from",
    record: "43",
  });
  expect(control).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(screen.getByText(labels.replayNextRecord + " 17")).toBeVisible();
  expect(toggle).toHaveAttribute("aria-pressed", "false");
});

it("aborts a pending archive page on source revocation and discards the late result", async () => {
  let publishAccess = (_allowed: boolean) => {};
  const watchActions: HostContextValue["watchActions"] = (inputs, publish) => {
    publishAccess = (allowed) =>
      publish(
        inputs.map((input) => ({
          input,
          result: { actionId: input.actionId, target: input.target, allowed },
          error: null,
        })),
      );
    publishAccess(true);
    return () => {};
  };
  let finish: ((value: ReplayReadResult) => void) | undefined;
  const read = vi.fn(
    (_params: ReplayReadParams, _signal?: AbortSignal) =>
      new Promise<ReplayReadResult>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      archiveAccess={{ hostId: "host", watchActions }}
      read={read}
      readRecord={vi.fn()}
      control={vi.fn()}
    />,
  );
  const toggle = screen.getByRole("button", { name: labels.browseReplay });
  fireEvent.click(toggle);
  const signal = read.mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  await act(async () => publishAccess(false));
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    finish?.({
      readerGeneration: "1",
      nextRecord: "1",
      archiveTotalRecords: "0",
      atEnd: true,
      records: [],
    }),
  );
  await act(async () => publishAccess(true));
  expect(
    screen.getByRole("button", { name: labels.browseReplay }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.queryByRole("button", { name: labels.nextReplayPage }),
  ).not.toBeInTheDocument();
});

it("scans to a hit, reads its first record without resuming playback and restores focus", async () => {
  const run = vi.fn(
    async ({ command }: ReplaySearchParams): Promise<ReplaySearchResult> => {
      if (command.kind === "stop")
        return { kind: "stopped", searchId: command.searchId, stopped: true };
      return command.kind === "start"
        ? searchPage(command.searchId, "1", [])
        : searchPage(command.searchId, command.page, [match]);
    },
  );
  const control = vi.fn().mockResolvedValue({
    records: [],
    readerGeneration: "3",
    nextRecord: "43",
    atEnd: false,
  });
  const read = vi.fn().mockResolvedValue({
    records: [
      {
        kind: "reference",
        recordOrdinal: "43",
        jsonBytes: "200",
        jsonSha256: "a".repeat(64),
        recordRef: {
          hostId: "host",
          kind: "capture_record",
          id: "large-record",
          revision: "1",
        },
      },
    ],
    readerGeneration: "3",
    nextRecord: "44",
    atEnd: false,
    playback: { rate: { kind: "fastest" }, paused: true },
  });
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      read={read}
      readRecord={vi.fn()}
      control={control}
      search={{
        run,
        t: searchLabels,
        hostId: "host",
        watchActions: allowSearch,
      }}
      recordingName={recordingName}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Search recording" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Search recording" });
  const input = within(dialog).getByRole("textbox", { name: "Search content" });
  expect(input).toHaveFocus();
  expect(within(dialog).getByText(recordingName)).toBeVisible();
  fireEvent.change(input, { target: { value: "PING" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start search" }));
  expect(
    await within(dialog).findByText(
      "Record 43–44 · bytes [9007199254740993, 9007199254740997)",
    ),
  ).toBeVisible();
  expect(run.mock.calls.map(([request]) => request.command.kind)).toEqual([
    "start",
    "next",
  ]);
  expect(run.mock.calls[0]?.[0].command).toMatchObject({
    kind: "start",
    bytesBase64: "UElORw==",
  });
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Go to record" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({ paused: true, seekRecord: "43" }),
    expect.any(AbortSignal),
  );
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ singleStep: true, maxRecords: "1" }),
    expect.any(AbortSignal),
  );
  expect(screen.getByText(/Located record 43.*9007199254740993/)).toBeVisible();
  await waitFor(() =>
    expect(run.mock.calls.at(-1)?.[0].command.kind).toBe("stop"),
  );
});

it("reconciles a stop acknowledged before the first search page arrives", async () => {
  let complete!: (page: ReplaySearchResult) => void;
  const pending = new Promise<ReplaySearchResult>((resolve) => {
    complete = resolve;
  });
  const run = vi.fn(
    ({ command }: ReplaySearchParams): Promise<ReplaySearchResult> => {
      if (command.kind === "stop")
        return Promise.resolve({
          kind: "stopped",
          searchId: command.searchId,
          stopped: false,
        });
      return pending;
    },
  );
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      read={vi.fn()}
      readRecord={vi.fn()}
      control={vi.fn()}
      search={{
        run,
        t: searchLabels,
        hostId: "host",
        watchActions: allowSearch,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search recording" }));
  const dialog = screen.getByRole("dialog", { name: "Search recording" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search content" }),
    { target: { value: "PING" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Start search" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Stop search" }),
  );
  expect(
    await within(dialog).findByText("Waiting for search to stop…"),
  ).toBeVisible();
  expect(run.mock.calls.map(([request]) => request.command.kind)).toEqual([
    "start",
    "stop",
  ]);
  const id = run.mock.calls[0]![0].command.searchId;
  await act(async () => complete(searchPage(id, "1", [match])));
  expect(await within(dialog).findByText("Search stopped.")).toBeVisible();
  expect(run.mock.calls.map(([request]) => request.command)).toEqual([
    expect.objectContaining({ kind: "start", searchId: id }),
    { kind: "stop", searchId: id },
    { kind: "stop", searchId: id },
  ]);
  expect(
    within(dialog).queryByRole("list", { name: "Search matches" }),
  ).not.toBeInTheDocument();
});

it("keeps results scoped to the submitted input and clears them when the recording changes", async () => {
  const run = vi.fn(
    async ({ command }: ReplaySearchParams): Promise<ReplaySearchResult> => {
      if (command.kind === "start")
        return searchPage(command.searchId, "1", [match]);
      if (command.kind === "next") throw { code: "SOURCE_CHANGED" };
      return { kind: "stopped", searchId: command.searchId, stopped: true };
    },
  );
  render(
    <ReplayPanel
      session={session()}
      labels={labels}
      disabled={false}
      playbackSupported
      read={vi.fn()}
      readRecord={vi.fn()}
      control={vi.fn()}
      search={{
        run,
        t: searchLabels,
        hostId: "host",
        watchActions: allowSearch,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search recording" }));
  const dialog = screen.getByRole("dialog", { name: "Search recording" });
  const input = within(dialog).getByRole("textbox", { name: "Search content" });
  fireEvent.change(input, { target: { value: "PING" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start search" }));
  expect(
    await within(dialog).findByRole("list", { name: "Search matches" }),
  ).toBeVisible();
  fireEvent.change(input, { target: { value: "OTHER" } });
  expect(
    within(dialog).queryByRole("list", { name: "Search matches" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "Continue search" }),
  ).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: "PING" } });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Continue search" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Recording access changed.",
  );
  expect(
    within(dialog).queryByRole("list", { name: "Search matches" }),
  ).not.toBeInTheDocument();
});
