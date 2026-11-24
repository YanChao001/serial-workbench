import { createHash, webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
import type {
  FileReadParams,
  FileReadResult,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import { en } from "@/i18n/en";
import { createTranslator } from "@/i18n/translate";
import { I18nContext } from "@/providers/i18n-context";
import type { HostContextValue } from "@/providers/host-context";
import { FramingTool } from "./framing-tool";
import {
  framingAction,
  framingParams,
  initialFramingDraft,
  parseFramingPage,
} from "./framing-model";
import { operation } from "./test-fixtures";

const target: Target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};
const reference = {
  hostId: "host",
  kind: "plugin_result",
  id: "operation",
  revision: "1",
};
const accepted: Operation = {
  ...operation(),
  actionId: framingAction,
  state: "queued",
  target,
};
const terminal: Operation = {
  ...accepted,
  state: "succeeded",
  result: { kind: "reference", value: { resultRef: reference } },
};

function frame(offset: number) {
  return {
    bytesBase64: "qg==",
    source: {
      hostId: target.hostId,
      sessionId: target.sessionId,
      sessionEpoch: target.sessionEpoch,
      direction: "rx",
      byteStart: String(offset),
      byteEnd: String(offset + 1),
      eventStart: "1",
      eventEnd: "2",
    },
  };
}

function filePage(value: unknown): FileReadResult {
  const bytes = Buffer.from(JSON.stringify(value), "utf-8");
  return {
    fileRef: reference,
    offset: "0",
    nextOffset: String(bytes.length),
    totalBytes: String(bytes.length),
    bytesBase64: bytes.toString("base64"),
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
    atEnd: true,
  };
}

function mount(options: {
  invoke?: HostContextValue["invoke"];
  waitForOperation?: HostContextValue["waitForOperation"];
  readFile?: HostContextValue["readFile"];
}) {
  const view = render(
    <I18nContext.Provider value={{ language: "en", t: createTranslator(en) }}>
      <Toaster />
      <FramingTool
        target={target}
        items={[]}
        invoke={options.invoke ?? (async () => accepted)}
        waitForOperation={options.waitForOperation ?? (async () => terminal)}
        readFile={
          options.readFile ??
          (async () => filePage({ frames: [], incompleteBytes: 0 }))
        }
      />
    </I18nContext.Provider>,
  );
  fireEvent.change(screen.getByLabelText("Stop before event"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Frame length (bytes)"), {
    target: { value: "1" },
  });
  return view;
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("waits for the terminal receipt and uses the exact byte cursor for the next page", async () => {
  let settle: (operation: Operation) => void = () => {};
  const waitForOperation = vi
    .fn<HostContextValue["waitForOperation"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    )
    .mockResolvedValue(terminal);
  const invoke = vi
    .fn<HostContextValue["invoke"]>()
    .mockResolvedValue(accepted);
  const readFile = vi
    .fn<
      (params: FileReadParams, signal?: AbortSignal) => Promise<FileReadResult>
    >()
    .mockResolvedValueOnce(
      filePage({
        frames: Array.from({ length: 128 }, (_, index) => frame(index)),
        incompleteBytes: 0,
        nextCursor: { eventSeq: "1", byteStart: "128" },
      }),
    )
    .mockResolvedValueOnce(
      filePage({ frames: [frame(128)], incompleteBytes: 0 }),
    );

  mount({ invoke, waitForOperation, readFile });
  fireEvent.click(screen.getByRole("button", { name: "Scan frames" }));
  await waitFor(() => expect(waitForOperation).toHaveBeenCalledOnce());
  expect(readFile).not.toHaveBeenCalled();
  expect(invoke.mock.calls[0]?.[0]).toEqual({
    actionId: framingAction,
    target,
    executionMode: "independent",
    params: {
      startEventSeq: "1",
      endEventSeq: "2",
      maxFrameLength: 4096,
      fixedLength: 1,
    },
  });

  await act(async () => settle(terminal));
  const results = within(
    await screen.findByRole("region", {
      name: en["workbench.framing.results"],
    }),
  );
  expect(results.getByRole("status")).toHaveTextContent("Frames 128");
  fireEvent.click(screen.getByRole("button", { name: "Next frames" }));
  await waitFor(() =>
    expect(results.getByRole("status")).toHaveTextContent(/^Frames 1 ·/),
  );
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1]?.[0].params).toEqual({
    startEventSeq: "1",
    startByte: "128",
    endEventSeq: "2",
    maxFrameLength: 4096,
    fixedLength: 1,
  });
  expect(screen.getByText("AA")).toBeInTheDocument();
  expect(screen.getByText(/Bytes 128 to 129/)).toBeInTheDocument();
});

it("does not read a late result when the session panel has closed", async () => {
  let settle: (operation: Operation) => void = () => {};
  const waitForOperation = vi.fn<HostContextValue["waitForOperation"]>(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const readFile = vi.fn<HostContextValue["readFile"]>();
  const view = mount({ waitForOperation, readFile });
  fireEvent.click(screen.getByRole("button", { name: "Scan frames" }));
  await waitFor(() => expect(waitForOperation).toHaveBeenCalledOnce());
  const signal = waitForOperation.mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => settle(terminal));
  expect(readFile).not.toHaveBeenCalled();
});

it("lets Host deny the scan without reading or presenting a result", async () => {
  const invoke = vi
    .fn<HostContextValue["invoke"]>()
    .mockRejectedValue({ code: "PERMISSION_DENIED" });
  const readFile = vi.fn<HostContextValue["readFile"]>();
  mount({ invoke, readFile });
  fireEvent.click(screen.getByRole("button", { name: "Scan frames" }));
  expect(
    await screen.findByText(en["nativeError.permissionDenied"]),
  ).toBeInTheDocument();
  expect(readFile).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Frame results" }),
  ).not.toBeInTheDocument();
});

it("keeps the saved footer local when switching the rule to silence", () => {
  const draft = {
    ...initialFramingDraft({ startEventSeq: "1", endEventSeq: "2" }),
    footer: "0D",
    idle: "10",
  };
  expect(framingParams({ ...draft, mode: "markers" })).toMatchObject({
    idleTimeoutMs: 10,
    footerBase64: "DQ==",
  });
  const silence = framingParams({ ...draft, mode: "silence" });
  expect(silence?.idleTimeoutMs).toBe(10);
  expect(silence?.footerBase64).toBeUndefined();
});

it("rejects overlapping frames and a cursor before the last frame end", () => {
  const params = { startEventSeq: "1", endEventSeq: "2", startByte: "1" };
  const original = { frames: [frame(1), frame(2)], incompleteBytes: 0 };
  expect(parseFramingPage(original, target, params).frames).toHaveLength(2);
  expect(() =>
    parseFramingPage(
      { ...original, frames: [frame(1), frame(1)] },
      target,
      params,
    ),
  ).toThrow("Invalid framing result");
  expect(() =>
    parseFramingPage(
      {
        frames: Array.from({ length: 128 }, (_, index) => frame(index + 1)),
        incompleteBytes: 0,
        nextCursor: { eventSeq: "1", byteStart: "128" },
      },
      target,
      params,
    ),
  ).toThrow("Invalid framing result");
});
