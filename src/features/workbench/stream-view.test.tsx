import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "sonner";
import type { StreamItem } from "@serial-workbench/contracts";
import { defaults } from "@serial-workbench/contracts";
import { StreamView } from "./stream-view";
import { labels, txItem } from "./test-fixtures";
import { compactStreamTime } from "./stream-presentation";
it("notifies live configuration changes without adding rows to received data", async () => {
  const source = txItem("tx");
  if (source.kind !== "source") throw new Error("Missing source");
  const items: StreamItem[] = [
    {
      kind: "source",
      event: {
        ...source.event,
        eventSeq: "6387",
        kind: "configuration_boundary",
        payload: {
          revision: "2",
          certainty: "confirmed",
          receiptRef: { hostId: "host", kind: "operation", id: "configure" },
        },
      },
    },
    {
      kind: "source",
      event: {
        ...source.event,
        kind: "lifecycle",
        payload: { state: "closed" },
      },
    },
  ];
  const view = render(<StreamView items={items} labels={labels} />);
  const log = screen.getByRole("log");
  expect(log).not.toHaveTextContent("Connection parameters applied");
  expect(
    await screen.findByText("Connection parameters applied"),
  ).toBeVisible();
  expect(screen.getByText(labels.closed)).toBeVisible();
  expect(log).not.toHaveTextContent("CONFIGURATION_BOUNDARY");
  expect(log).not.toHaveTextContent("LIFECYCLE");
  expect(screen.queryByText("6387")).not.toBeInTheDocument();
  view.rerender(<StreamView items={[...items]} labels={{ ...labels }} />);
  const duplicate = render(<StreamView items={items} labels={labels} />);
  expect(screen.getAllByText("Connection parameters applied")).toHaveLength(1);
  view.unmount();
  duplicate.unmount();
  render(<StreamView items={items} labels={labels} />);
  expect(screen.getAllByText("Connection parameters applied")).toHaveLength(1);
});

it("keeps configuration boundaries readable in replay without replaying notifications", () => {
  const source = txItem("tx");
  if (source.kind !== "source") throw new Error("Missing source");
  const item: StreamItem = {
    kind: "source",
    event: {
      ...source.event,
      sessionId: "configuration-replay",
      kind: "configuration_boundary",
      payload: {
        revision: "2",
        certainty: "uncertain",
        receiptRef: { hostId: "host", kind: "operation", id: "configure" },
      },
    },
  };
  render(<StreamView items={[item]} labels={labels} replay />);
  expect(screen.getByRole("log")).toHaveTextContent(
    labels.configurationUncertain,
  );
  expect(document.querySelector("[data-sonner-toast]")).not.toBeInTheDocument();
});

it("notifies the latest configuration state per batch and recognizes a new source epoch", async () => {
  const source = txItem("tx");
  if (source.kind !== "source") throw new Error("Missing source");
  const boundary = (
    seq: string,
    certainty: "confirmed" | "uncertain",
    epoch = "1",
  ): StreamItem => ({
    kind: "source",
    event: {
      ...source.event,
      sessionId: "configuration-epochs",
      sessionEpoch: epoch,
      eventSeq: seq,
      kind: "configuration_boundary",
      payload: {
        revision: seq,
        certainty,
        receiptRef: {
          hostId: "host",
          kind: "operation",
          id: `configure-${seq}`,
        },
      },
    },
  });
  const items = [boundary("1", "confirmed"), boundary("2", "uncertain")];
  const view = render(<StreamView items={items} labels={labels} />);
  expect(screen.getByRole("log")).not.toHaveTextContent(
    labels.configurationUncertain,
  );
  expect(await screen.findByText(labels.configurationUncertain)).toBeVisible();
  expect(
    screen.queryByText(labels.configurationApplied),
  ).not.toBeInTheDocument();
  view.rerender(
    <StreamView
      items={[...items, boundary("1", "confirmed", "2")]}
      labels={labels}
    />,
  );
  expect(await screen.findByText(labels.configurationApplied)).toBeVisible();
});
it("reinterprets original GBK bytes and keeps a character split across RX chunks", async () => {
  const source = txItem("tx");
  if (source.kind !== "source") throw new Error("Missing source");
  const rx = (bytes: number[], start: string): StreamItem => ({
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      payload: {
        bytesBase64: btoa(String.fromCharCode(...bytes)),
        byteStart: start,
        byteEnd: String(Number(start) + bytes.length),
      },
    },
  });
  const items = [rx([0xc4], "0"), rx([0xe3, 0xba, 0xc3], "1")];
  const view = render(
    <StreamView items={items} labels={labels} encoding="gbk" />,
  );
  expect(await screen.findByText("你好")).toBeVisible();
  view.rerender(<StreamView items={items} labels={labels} encoding="utf-8" />);
  expect(screen.queryByText("你好")).not.toBeInTheDocument();
  expect(
    items[0]?.kind === "source" &&
      items[0].event.kind === "rx" &&
      items[0].event.payload.bytesBase64,
  ).toBe("xA==");
});
afterEach(() => {
  cleanup();
  toast.dismiss();
});
beforeEach(() => {
  render(<Toaster />);
});
it("preserves the original TX intent byte range while a receipt is unavailable", () => {
  render(<StreamView items={[txItem("tx_intent", "12")]} labels={labels} />);
  expect(screen.queryByText(labels.awaitingReceipt)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: labels.receipt }));
  expect(screen.getByText(labels.awaitingReceipt)).toBeVisible();
  expect(screen.getByText("Requested bytes: [12, 17)")).toBeVisible();
  expect(screen.queryByText(labels.accepted)).not.toBeInTheDocument();
});
it("keeps stopped stream bytes and offers recovery before the technical error details", async () => {
  render(
    <StreamView
      items={[txItem("tx")]}
      labels={labels}
      error={new Error("Subscription source epoch ended")}
    />,
  );
  expect(screen.getByText("Hello")).toBeVisible();
  const fault = await screen.findByRole("alert");
  expect(fault).toHaveTextContent(labels.streamUnavailable);
  expect(fault).toHaveTextContent(labels.disconnectHelp);
  expect(
    screen.queryByText("Subscription source epoch ended"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(labels.errorDetails));
  expect(
    screen.getByRole("region", { name: labels.errorDetails }),
  ).toHaveTextContent("Subscription source epoch ended");
});
it.each(["accepted", "partial", "unknown", "rejected"] as const)(
  "updates TX bytes in place with their %s receipt and preserves a gap",
  (outcome) => {
    const intent = txItem("tx_intent");
    const receipt = txItem("tx", "0", outcome);
    const gap: StreamItem = {
      kind: "reader_gap",
      gap: {
        hostId: "host",
        instanceEpoch: "1",
        sessionId: "session",
        sessionEpoch: "1",
        reason: "reader_overflow",
        missingEventRange: { start: "2", end: "3" },
      },
    };
    const view = render(<StreamView items={[intent]} labels={labels} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.queryByText(labels.awaitingReceipt)).not.toBeInTheDocument();
    view.rerender(
      <StreamView items={[intent, gap, receipt]} labels={labels} />,
    );
    expect(screen.getAllByText("Hello")).toHaveLength(1);
    expect(screen.queryByText(labels.awaitingReceipt)).not.toBeInTheDocument();
    expect(screen.queryByText(labels[outcome])).not.toBeInTheDocument();
    expect(screen.queryByText(labels.peerUnconfirmed)).not.toBeInTheDocument();
    expect(
      screen.getByRole("log").querySelector('[data-direction="tx"]'),
    ).toHaveAttribute("data-outcome", outcome);
    fireEvent.click(screen.getByRole("button", { name: labels.receipt }));
    expect(screen.getByText(labels[outcome])).toBeVisible();
    expect(screen.getByText(labels.peerUnconfirmed)).toBeInTheDocument();
    expect(screen.getByText(/reader_overflow/)).toBeInTheDocument();
    if (outcome === "partial" || outcome === "unknown")
      expect(
        screen.getByText("Bytes accepted by backend: [0, 2)"),
      ).toBeInTheDocument();
    if (outcome === "unknown")
      expect(
        screen.getByText("Bytes with unknown outcome: [2, 5)"),
      ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
    expect(screen.getByText("48 65 6C 6C 6F")).toBeInTheDocument();
  },
);
it("computes block intervals from visible TX rows rather than hidden receipts", () => {
  const timed = (item: StreamItem, sourceMonoNs: string): StreamItem => {
    if (item.kind !== "source") throw new Error("Expected source");
    return {
      ...item,
      event: { ...item.event, time: { ...item.event.time, sourceMonoNs } },
    };
  };
  render(
    <StreamView
      items={[
        timed(txItem("tx_intent"), "10"),
        timed(txItem("tx"), "20"),
        timed(txItem("tx_intent", "5"), "30"),
        timed(txItem("tx", "5"), "40"),
      ]}
      labels={labels}
      presentationLabels={presentationLabels}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.encodingHelp }));
  fireEvent.click(screen.getByRole("radio", { name: "Block interval" }));
  const summaries = screen
    .getByRole("log")
    .querySelectorAll("time.workbench-stream-time");
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toHaveTextContent("Unavailable");
  expect(summaries[1]).toHaveTextContent("20 ns");
});
it("applies shared typography to received text and HEX without changing terminal controls", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  expect(
    screen.getByText("Hello").closest(".workbench-stream-content"),
  ).toHaveStyle({
    fontFamily: "var(--font-mono)",
    fontSize: `${defaults.terminalTypography.fontSize}px`,
    lineHeight: String(defaults.terminalTypography.lineHeightPercent / 100),
    fontVariantLigatures: defaults.terminalTypography.ligatures
      ? "normal"
      : "none",
  });
  view.rerender(
    <StreamView
      items={[first]}
      labels={labels}
      mode="hex"
      terminalSettings={{
        ...defaults.settings.terminal,
        typography: {
          fontFamily: "Consolas",
          fontSize: 18,
          lineHeightPercent: 190,
          ligatures: true,
        },
      }}
    />,
  );
  expect(
    screen.getByText("48 65 6C 6C 6F").closest(".workbench-stream-content"),
  ).toHaveStyle({
    fontFamily: "Consolas",
    fontSize: "18px",
    lineHeight: "1.9",
    fontVariantLigatures: "normal",
  });
  expect(screen.getByRole("button", { name: "Freeze" })).not.toHaveStyle({
    fontSize: "18px",
  });
});
it("uses shared receive defaults while keeping an uncontrolled display switch usable", () => {
  render(
    <StreamView
      items={[first]}
      labels={labels}
      terminalSettings={{
        receiveMode: "hex",
        sendMode: "text",
        lineEnding: { kind: "none" },
      }}
    />,
  );
  expect(screen.getByRole("radio", { name: "HEX" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
});
const presentationLabels = {
  timeMode: "Time display",
  absoluteTime: "Absolute",
  relativeTime: "Relative",
  intervalTime: "Block interval",
  missingTime: "Unavailable",
  replay: "Replay",
};
const first: StreamItem = {
  kind: "source",
  event: {
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
      precision: { source: "host_read", resolutionNs: "1", syncMethod: "none" },
    },
    kind: "rx",
    payload: { bytesBase64: "SGVsbG8=", byteStart: "0", byteEnd: "5" },
  },
};
it("shows contiguous UTF-8 receive fragments as one text stream without changing raw HEX blocks", () => {
  const bytes = new TextEncoder().encode("中文回环");
  const cuts = [0, 1, 4, 8, bytes.length];
  const fragments: StreamItem[] = cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1]!;
    return {
      kind: "source",
      event: {
        ...first.event!,
        kind: "rx",
        eventSeq: String(index + 1),
        payload: {
          bytesBase64: btoa(String.fromCharCode(...bytes.slice(start, end))),
          byteStart: String(start),
          byteEnd: String(end),
        },
      },
    };
  });
  const original = JSON.stringify(fragments);
  const view = render(
    <StreamView items={fragments} labels={labels} mode="text" />,
  );
  const received = screen
    .getByRole("log")
    .querySelectorAll('[data-direction="rx"]');
  expect(received).toHaveLength(1);
  expect(received[0]).toHaveTextContent("中文回环");
  expect(received[0]).not.toHaveTextContent("�");
  view.rerender(<StreamView items={fragments} labels={labels} mode="hex" />);
  expect(
    screen.getByRole("log").querySelectorAll('[data-direction="rx"]'),
  ).toHaveLength(4);
  expect(JSON.stringify(fragments)).toBe(original);
});

const second: StreamItem = {
  ...first,
  event: {
    ...first.event!,
    eventSeq: "2",
    kind: "rx",
    payload: { bytesBase64: "V29ybGQ=", byteStart: "5", byteEnd: "10" },
  },
};
it.each(["configuration", "epoch", "offset"] as const)(
  "keeps receive text separated across a changed %s boundary",
  (boundary) => {
    const next = structuredClone(second);
    if (next.kind !== "source" || next.event.kind !== "rx")
      throw new Error("Expected receive source");
    if (boundary === "configuration") next.event.configurationRevision = "2";
    if (boundary === "epoch") next.event.sessionEpoch = "2";
    if (boundary === "offset") {
      next.event.payload.byteStart = "6";
      next.event.payload.byteEnd = "11";
    }
    render(<StreamView items={[first, next]} labels={labels} mode="text" />);
    const received = screen
      .getByRole("log")
      .querySelectorAll('[data-direction="rx"]');
    expect(received).toHaveLength(2);
    expect(received[0]).toHaveTextContent("Hello");
    expect(received[1]).toHaveTextContent("World");
  },
);
it.each([
  {
    locale: "en",
    mode: "absolute",
    timeDetails: "Time details",
    missingTime: "Time unavailable",
    expected: [
      compactStreamTime("2026-11-08T00:00:00Z"),
      compactStreamTime("2026-11-08T00:00:00Z"),
      "Time unavailable",
    ],
  },
  {
    locale: "en",
    mode: "relative",
    timeDetails: "Time details",
    missingTime: "Time unavailable",
    expected: ["0 ns", "7 ns", "Time unavailable"],
  },
  {
    locale: "en",
    mode: "interval",
    timeDetails: "Time details",
    missingTime: "Time unavailable",
    expected: ["Time unavailable", "7 ns", "Time unavailable"],
  },
  {
    locale: "zh",
    mode: "absolute",
    timeDetails: "时间详情",
    missingTime: "时间未知",
    expected: [
      compactStreamTime("2026-11-08T00:00:00Z"),
      compactStreamTime("2026-11-08T00:00:00Z"),
      "时间未知",
    ],
  },
  {
    locale: "zh",
    mode: "relative",
    timeDetails: "时间详情",
    missingTime: "时间未知",
    expected: ["0 ns", "7 ns", "时间未知"],
  },
  {
    locale: "zh",
    mode: "interval",
    timeDetails: "时间详情",
    missingTime: "时间未知",
    expected: ["时间未知", "7 ns", "时间未知"],
  },
])(
  "renders compact $locale $mode time labels without technical disclosures",
  ({ mode, timeDetails, missingTime, expected }) => {
    const later: StreamItem = {
      ...second,
      event: {
        ...second.event!,
        time: { ...second.event!.time, sourceMonoNs: "8" },
      },
    };
    const gap: StreamItem = {
      kind: "reader_gap",
      gap: {
        hostId: "host",
        instanceEpoch: "1",
        sessionId: "session",
        sessionEpoch: "1",
        reason: "reader_overflow",
        missingEventRange: { start: "3", end: "4" },
      },
    };
    render(
      <StreamView
        items={[first, later, gap]}
        labels={labels}
        presentationLabels={{ ...presentationLabels, missingTime }}
        mode="hex"
      />,
    );
    if (mode !== "absolute") {
      fireEvent.click(
        screen.getByRole("button", { name: labels.encodingHelp }),
      );
      fireEvent.click(
        screen.getByRole("radio", {
          name: mode === "relative" ? "Relative" : "Block interval",
        }),
      );
    }
    const summaries = screen
      .getByRole("log")
      .querySelectorAll("time.workbench-stream-time");
    expect(summaries).toHaveLength(3);
    expect(screen.queryByTitle(timeDetails)).not.toBeInTheDocument();
    summaries.forEach((summary, index) => {
      expect(summary).toHaveTextContent(expected[index]!);
      expect(summary).not.toHaveAttribute("title");
    });
  },
);
it("keeps original time in semantic metadata, hides clock internals and computes exact relative time", () => {
  const later: StreamItem = {
    ...second,
    event: {
      ...second.event!,
      time: {
        ...second.event!.time,
        sourceMonoNs: "9007199254741000",
      },
    },
  };
  const earlier: StreamItem = {
    ...first,
    event: {
      ...first.event!,
      time: {
        ...first.event!.time,
        sourceMonoNs: "9007199254740993",
      },
    },
  };
  render(
    <StreamView
      items={[earlier, later]}
      labels={labels}
      presentationLabels={presentationLabels}
      replay
      mode="hex"
    />,
  );
  const timestamps = screen
    .getByRole("log")
    .querySelectorAll("time.workbench-stream-time");
  expect(timestamps).toHaveLength(2);
  for (const timestamp of timestamps)
    expect(timestamp).toHaveAttribute("datetime", "2026-11-08T00:00:00Z");
  expect(screen.queryByText(/host_read/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Resolution: 1 ns/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/Replay/)[0]).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: labels.encodingHelp }));
  fireEvent.click(screen.getByRole("radio", { name: "Relative" }));
  expect(screen.getByText("7 ns")).toBeInTheDocument();
});

it("reflects controlled mode changes and reports user receive mode selection", () => {
  let selected: string | undefined;
  const view = render(
    <StreamView
      items={[first]}
      labels={labels}
      mode="text"
      onReceiveModeChange={(mode) => {
        selected = mode;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
  expect(selected).toBe("hex");
  view.rerender(<StreamView items={[first]} labels={labels} mode="hex" />);
  expect(screen.getByText("48 65 6C 6C 6F")).toBeInTheDocument();
});
it("freezes rendering while new Host items continue arriving, then resumes latest bytes", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  view.rerender(<StreamView items={[first, second]} labels={labels} />);
  expect(screen.queryByText("World")).not.toBeInTheDocument();
  const totals = screen.getByRole("group", {
    name: labels.displayedRxBytes,
  }).parentElement;
  expect(totals).toHaveTextContent("Display paused");
  expect(totals).toHaveTextContent("Pending updates: 1");
  expect(screen.queryByText("+1")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(totals).not.toHaveTextContent("Display paused");
  expect(screen.getByText("HelloWorld")).toBeInTheDocument();
});
it("applies a reduced retention limit to a paused view and explains normal display eviction", async () => {
  const separated: StreamItem = {
    ...second,
    event: {
      ...second.event,
      time: { ...second.event.time, sourceMonoNs: "500000000" },
    },
  };
  const view = render(
    <StreamView
      items={[first, separated]}
      labels={labels}
      historyLimits={{ maxRecords: 2, maxBytes: 1024 * 1024 }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.freeze }));
  view.rerender(
    <StreamView
      items={[second]}
      labels={labels}
      trimmed
      historyLimits={{ maxRecords: 1, maxBytes: 1024 * 1024 }}
    />,
  );
  expect(await screen.findByText("World")).toBeVisible();
  expect(screen.queryByText("HelloWorld")).not.toBeInTheDocument();
  expect(screen.getByText(labels.historyTrimmed)).toBeVisible();
  expect(screen.queryByText(labels.gapHelp)).not.toBeInTheDocument();
});
it("locates HEX matches by original byte offset and displays a real reader gap", async () => {
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "3", end: "7" },
    },
  };
  render(<StreamView items={[first, second, gap]} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Search bytes" }));
  fireEvent.click(screen.getByRole("radio", { name: "HEX Search bytes" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search bytes" }), {
    target: { value: "57 6f" },
  });
  screen.getByRole("textbox", { name: "Search bytes" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Offset 5"),
  );
  expect(screen.getByText(/reader_overflow/)).toHaveTextContent("[3, 7)");
  expect(screen.getByRole("textbox", { name: "Search bytes" })).toHaveFocus();
  expect(document.querySelector('[data-offset="0"]')).toHaveTextContent(
    "HelloWorld",
  );
});

it("opens search next to the stream and returns focus to its trigger on Escape", () => {
  render(<StreamView items={[first]} labels={labels} />);
  expect(
    screen.queryByRole("textbox", { name: "Search bytes" }),
  ).not.toBeInTheDocument();
  const search = screen.getByRole("button", { name: "Search bytes" });
  fireEvent.click(search);
  const input = screen.getByRole("textbox", { name: "Search bytes" });
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(
    screen.queryByRole("textbox", { name: "Search bytes" }),
  ).not.toBeInTheDocument();
  expect(search).toHaveFocus();
});

it("exposes capture and activity as explicit nearby actions", () => {
  const capture = vi.fn();
  const activity = vi.fn();
  render(
    <StreamView
      items={[]}
      labels={labels}
      onOpenCapture={capture}
      onOpenActivity={activity}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  expect(capture).toHaveBeenCalledOnce();
  expect(activity).toHaveBeenCalledOnce();
});

it("clears a frozen view without keeping its old snapshot on screen", () => {
  const clear = vi.fn();
  const props = {
    labels,
    onClearView: clear,
    displayLabels: {
      displayOptions: "Display options",
      clearView: "Clear view",
    },
  };
  const view = render(<StreamView items={[first]} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear view" }));
  expect(clear).toHaveBeenCalledOnce();
  view.rerender(<StreamView items={[]} {...props} />);
  expect(screen.queryByText("Hello")).not.toBeInTheDocument();
});

it("decodes split UTF-8 only within an uninterrupted source epoch", () => {
  const prefix: StreamItem = {
    ...first,
    event: {
      ...first.event!,
      kind: "rx",
      payload: { bytesBase64: "4g==", byteStart: "0", byteEnd: "1" },
    },
  };
  const suffix: StreamItem = {
    ...second,
    event: {
      ...second.event!,
      kind: "rx",
      payload: { bytesBase64: "gqw=", byteStart: "1", byteEnd: "3" },
    },
  };
  const view = render(<StreamView items={[prefix, suffix]} labels={labels} />);
  expect(screen.getByText("€")).toBeInTheDocument();
  const nextEpoch: StreamItem = {
    ...suffix,
    event: { ...suffix.event!, sessionEpoch: "2" },
  };
  view.rerender(<StreamView items={[prefix, nextEpoch]} labels={labels} />);
  expect(screen.queryByText("€")).not.toBeInTheDocument();
  expect(screen.getByText("��")).toBeInTheDocument();
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "2", end: "3" },
    },
  };
  view.rerender(<StreamView items={[prefix, gap, suffix]} labels={labels} />);
  expect(screen.queryByText("€")).not.toBeInTheDocument();
  expect(screen.getByText("��")).toBeInTheDocument();
  const boundary: StreamItem = {
    ...first,
    event: {
      ...first.event!,
      kind: "configuration_boundary",
      payload: {
        revision: "2",
        certainty: "confirmed",
        receiptRef: { hostId: "host", kind: "operation", id: "configuration" },
      },
    },
  };
  view.rerender(
    <StreamView items={[prefix, boundary, suffix]} labels={labels} />,
  );
  expect(screen.queryByText("€")).not.toBeInTheDocument();
  expect(screen.getByText("��")).toBeInTheDocument();
});

it("discards a frozen snapshot and decoder state when the replay reader generation changes", () => {
  const view = render(
    <StreamView key="reader-1" items={[first]} labels={labels} replay />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  view.rerender(
    <StreamView key="reader-2" items={[second]} labels={labels} replay />,
  );
  expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  expect(screen.getByText("World")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
});
it("keeps receiving live while reviewing history and follows again after returning to latest", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  let height = 1000;
  let top = 800;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  view.rerender(<StreamView items={[first]} labels={labels} />);
  height = 1400;
  fireEvent.scroll(log);
  expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
  fireEvent.wheel(log, { deltaY: -40 });
  log.scrollTop = 760;
  fireEvent.scroll(log);
  view.rerender(<StreamView items={[first, second]} labels={labels} />);
  expect(log).toHaveTextContent("World");
  expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: labels.returnToLatest }),
  ).toBeVisible();
  expect(screen.getByText("Updates: 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Return to latest" }));
  expect(
    screen.queryByRole("button", { name: labels.returnToLatest }),
  ).not.toBeInTheDocument();
  expect(log.scrollTop).toBe(1200);
});

it("does not freeze when clicking receive text is followed by layout growth", () => {
  render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  let height = 1000;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: { value: 800, writable: true },
  });
  fireEvent.pointerDown(screen.getByText("Hello"), { pointerType: "mouse" });
  height = 1400;
  fireEvent.scroll(log);
  fireEvent.pointerUp(window);
  expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: labels.returnToLatest }),
  ).not.toBeInTheDocument();
});

it("keeps history review when layout changes reach the end without a downward user gesture", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  let height = 1000;
  let top = 800;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  fireEvent.wheel(log, { deltaY: -8 });
  log.scrollTop = 792;
  fireEvent.scroll(log);
  const latest = screen.getByRole("button", { name: labels.returnToLatest });
  expect(latest).toBeVisible();
  height = 992;
  view.rerender(<StreamView items={[first, second]} labels={labels} />);
  fireEvent.scroll(log);
  expect(latest).toBeVisible();
  expect(latest).toHaveTextContent("Updates: 1");
  expect(log).toHaveTextContent("World");
  fireEvent.keyDown(log, { key: "End", ctrlKey: true });
  expect(latest).not.toBeInTheDocument();
});

it("enters history when a passive upward wheel arrives after the browser already reached the top", () => {
  render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
    scrollTop: { value: 0, writable: true },
  });
  fireEvent.wheel(log, { deltaY: -1000000 });
  expect(
    screen.getByRole("button", { name: labels.returnToLatest }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: labels.freeze })).toBeVisible();
});

it("does not carry a wheel event without scrolling into a later receive update", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  let height = 200;
  let top = 0;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  fireEvent.wheel(log, { deltaY: -40 });
  height = 1000;
  view.rerender(<StreamView items={[first, second]} labels={labels} />);
  height = 1400;
  fireEvent.scroll(log);
  expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
  expect(log).toHaveTextContent("World");
  expect(
    screen.queryByRole("button", { name: labels.returnToLatest }),
  ).not.toBeInTheDocument();
});

it.each([false, true])(
  "enters history on the first small scrollbar movement only while dragging: released=%s",
  (released) => {
    render(<StreamView items={[first]} labels={labels} />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 800, writable: true },
    });
    fireEvent.pointerDown(log);
    if (released) fireEvent.pointerUp(window);
    log.scrollTop = 790;
    fireEvent.scroll(log);
    expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: labels.returnToLatest }) !== null,
    ).toBe(!released);
    log.scrollTop = 700;
    fireEvent.scroll(log);
    expect(screen.getByRole("button", { name: "Freeze" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: labels.returnToLatest }) !== null,
    ).toBe(!released);
  },
);
