import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { defaults } from "@serial-workbench/contracts";
import { StreamView } from "./stream-view";
import { labels } from "./test-fixtures";
afterEach(cleanup);
it("applies shared typography to received text and HEX without changing terminal controls", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  expect(
    screen.getByText("Hello").closest(".workbench-stream-content"),
  ).toHaveStyle({
    fontFamily: defaults.terminalTypography.fontFamily,
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
  timeDetails: "Time details",
  clock: "Clock",
  timeSource: "Source",
  resolution: "Resolution",
  missingTime: "Unavailable",
  receivedTime: "Received",
  sourceTime: "Source wall time",
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
const second: StreamItem = {
  ...first,
  event: {
    ...first.event!,
    eventSeq: "2",
    kind: "rx",
    payload: { bytesBase64: "V29ybGQ=", byteStart: "5", byteEnd: "10" },
  },
};
it.each([
  {
    locale: "en",
    mode: "absolute",
    timeDetails: "Time details",
    missingTime: "Time unavailable",
    expected: [
      "2026-11-08T00:00:00Z",
      "2026-11-08T00:00:00Z",
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
    expected: ["2026-11-08T00:00:00Z", "2026-11-08T00:00:00Z", "时间未知"],
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
  "names $locale $mode time disclosures by their visible values",
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
        presentationLabels={{ ...presentationLabels, timeDetails, missingTime }}
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
    const summaries = screen.getByRole("log").querySelectorAll("summary");
    expect(summaries).toHaveLength(3);
    summaries.forEach((summary, index) => {
      expect(summary).toHaveTextContent(expected[index]!);
      expect(summary).toHaveAccessibleName(expected[index]!);
      expect(summary).toHaveAccessibleDescription(timeDetails);
    });
  },
);
it("shows original event time and precision, and computes exact relative time", () => {
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
    />,
  );
  expect(screen.getAllByText("2026-11-08T00:00:00Z")).toHaveLength(2);
  expect(screen.getAllByText(/host_read/)).toHaveLength(2);
  expect(screen.getAllByText(/Resolution: 1 ns/)).toHaveLength(2);
  expect(screen.getAllByText(/RX/)[0]).toHaveTextContent("Replay");
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
  expect(screen.getByRole("status")).toHaveTextContent("+1");
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(screen.getByText("World")).toBeInTheDocument();
});
it("locates HEX matches by original byte offset and displays a real reader gap", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(screen.getByRole("status")).toHaveTextContent("Offset 5");
  expect(screen.getByText(/reader_overflow/)).toHaveTextContent("[3, 7)");
  expect(document.querySelector('[data-offset="5"]')).toHaveFocus();
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
      newData: "New events",
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
it("scrolling away from the end freezes rendering without changing the input stream", () => {
  const view = render(<StreamView items={[first]} labels={labels} />);
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
    scrollTop: { value: 10, writable: true },
  });
  fireEvent.scroll(log);
  view.rerender(<StreamView items={[first, second]} labels={labels} />);
  expect(screen.queryByText("World")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
});
