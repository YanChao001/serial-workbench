import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { defaults, TX_MAX_BYTES } from "@serial-workbench/contracts";
import type { Operation } from "@serial-workbench/contracts";
import type { LineEnding } from "@serial-workbench/contracts";
import { encodeSend, formatHex } from "@serial-workbench/host-client";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { SendPanel, type SendPanelProps } from "./send-panel";
import type { SendPreprocessQuery } from "./send-preprocess";
import { labels, operation, session } from "./test-fixtures";
import type { TextSendPreview } from "@/lib/text-encoding";

function readPreview(observe: (bytes: Uint8Array | null) => void) {
  return (preview: TextSendPreview | null) =>
    observe(preview?.readBytes() ?? null);
}

it("validates mixed input live and sends the applied HEX draft with one line ending", async () => {
  const user = userEvent.setup();
  const send = vi.fn().mockResolvedValue(operation());
  const observed = vi.fn();
  const current = session();
  function Editor() {
    const [draft, setDraft] = useState("41 4");
    return (
      <SendPanel
        draft={draft}
        onDraftChange={setDraft}
        labels={labels}
        session={current}
        onSend={send}
        onPreviewChange={readPreview(observed)}
        terminalSettings={{
          ...defaults.settings.terminal,
          lineEnding: { kind: "lf" },
        }}
      />
    );
  }
  render(<Editor />);

  await user.click(screen.getByRole("button", { name: labels.mixedSendInput }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: labels.mixedSendInput,
  });
  const apply = screen.getByRole("button", { name: labels.mixedSendUseHex });
  expect(apply).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Invalid mixed input at character 4" }),
  );
  expect(input.selectionStart).toBe(3);
  expect(input.selectionEnd).toBe(4);
  fireEvent.change(input, { target: { value: String.raw`41 "B" \x00` } });
  expect(screen.getByText("41 42 00")).toBeVisible();
  await user.click(apply);

  expect(
    await screen.findByRole("textbox", { name: labels.draft }),
  ).toHaveValue("41 42 00");
  expect(send).not.toHaveBeenCalled();
  const bytes = Uint8Array.of(0x41, 0x42, 0, 10);
  expect(observed).toHaveBeenLastCalledWith(bytes);
  await user.click(screen.getByRole("button", { name: labels.send }));
  expect(send).toHaveBeenCalledWith(bytes, expect.any(AbortSignal));
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
});

it("previews the checksum of the selected encoded bytes and sends that exact snapshot", async () => {
  const user = userEvent.setup();
  const send = vi.fn().mockResolvedValue(operation());
  const observed = vi.fn();
  const props = {
    draft: "ABC",
    checksumDraftKey: "first-view",
    encoding: "utf-16le" as const,
    onDraftChange: vi.fn(),
    labels,
    onSend: send,
    onPreviewChange: readPreview(observed),
    terminalSettings: {
      ...defaults.settings.terminal,
      lineEnding: { kind: "crlf" } as const,
    },
  };
  const current = session();
  const view = render(<SendPanel {...props} session={current} />);
  const checksumButton = screen.getByRole("button", {
    name: labels.sendChecksum,
  });
  await user.click(checksumButton);
  await user.click(
    screen.getByRole("combobox", { name: labels.checksumAlgorithm }),
  );
  await user.click(screen.getByRole("option", { name: "Sum-8" }));
  const start = screen.getByRole("textbox", { name: labels.checksumStart });
  const end = screen.getByRole("textbox", { name: labels.checksumEnd });
  fireEvent.change(start, { target: { value: "2" } });
  fireEvent.change(end, { target: { value: "4" } });
  expect(screen.getByLabelText(labels.checksumBytes)).toHaveTextContent("42");
  const body = Uint8Array.of(0x41, 0, 0x42, 0, 0x43, 0, 0x0d, 0, 0x0a, 0);
  expect(observed).toHaveBeenLastCalledWith(Uint8Array.of(...body, 0x42));

  fireEvent.change(end, { target: { value: "10" } });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(observed).toHaveBeenLastCalledWith(null);
  expect(send).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", { name: labels.checksumIncludeEnding }),
  );
  expect(screen.getByLabelText(labels.checksumBytes)).toHaveTextContent("9C");
  expect(observed).toHaveBeenLastCalledWith(Uint8Array.of(...body, 0x9c));

  await user.keyboard("{Escape}");
  expect(checksumButton).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]?.[0]).toEqual(Uint8Array.of(...body, 0x9c));
  view.rerender(
    <SendPanel {...props} session={{ ...current, sessionEpoch: "2" }} />,
  );
  expect(observed).toHaveBeenLastCalledWith(body);
  view.rerender(<SendPanel {...props} session={current} />);
  expect(observed).toHaveBeenLastCalledWith(body);
});

it("discards a late preprocessing result and sends only a preview of the current draft", async () => {
  const user = userEvent.setup();
  const send = vi.fn().mockResolvedValue(operation());
  const observe = vi.fn();
  let finish!: (value: unknown) => void;
  const query = vi
    .fn<SendPreprocessQuery>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ output: "Qw==" });
  const props = {
    labels,
    onDraftChange: vi.fn(),
    onSend: send,
    session: session(),
    preprocessQuery: query,
    onPreviewChange: readPreview(observe),
    terminalSettings: {
      ...defaults.settings.terminal,
      lineEnding: { kind: "lf" as const },
    },
  };
  const view = render(<SendPanel {...props} draft="A" />);
  await user.click(
    screen.getByRole("button", { name: labels.preprocess.title }),
  );
  const editor = screen.getByRole("textbox", {
    name: labels.preprocess.definition,
  });
  fireEvent.change(editor, {
    target: {
      value:
        '[{"kind":"query","actionId":"test.transform","input":"source","output":"output"}]',
    },
  });
  await user.click(
    screen.getByRole("switch", { name: labels.preprocess.enabled }),
  );
  const generate = screen.getByRole("button", {
    name: labels.preprocess.preview,
  });
  const submit = screen.getByRole("button", { name: labels.send });
  await user.click(generate);
  expect(query).toHaveBeenCalledWith(
    "test.transform",
    { source: "QQ==" },
    expect.any(AbortSignal),
  );
  expect(submit).toBeDisabled();
  expect(observe).toHaveBeenLastCalledWith(null);

  view.rerender(<SendPanel {...props} draft="B" />);
  expect(query.mock.calls[0]?.[2].aborted).toBe(true);
  await act(async () => finish({ output: "QQ==" }));
  expect(submit).toBeDisabled();
  expect(observe).toHaveBeenLastCalledWith(null);
  expect(send).not.toHaveBeenCalled();

  await user.click(generate);
  expect(query).toHaveBeenLastCalledWith(
    "test.transform",
    { source: "Qg==" },
    expect.any(AbortSignal),
  );
  expect(
    await screen.findByRole("region", { name: labels.preprocess.final(2) }),
  ).toHaveTextContent("43 0A");
  await user.keyboard("{Escape}");
  await user.click(submit);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    Uint8Array.of(0x43, 0x0a),
    expect.any(AbortSignal),
    undefined,
    "1",
  );
});

it("sends a 16.50 KB draft exactly and retains its editable content", async () => {
  const draft = "1234567890".repeat(1650);
  const send = vi.fn().mockResolvedValue(operation());
  render(
    <SendPanel
      session={session()}
      draft={draft}
      onDraftChange={vi.fn()}
      labels={labels}
      onSend={send}
    />,
  );
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "16.50 KB",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toEqual(new TextEncoder().encode(draft));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    draft,
  );
});

it("includes line endings in the shared TX limit, keeps the byte count and never submits an oversized preview", async () => {
  const send = vi.fn().mockResolvedValue(operation()),
    observed = vi.fn();
  const draft = "A".repeat(TX_MAX_BYTES - 2);
  const props = {
    session: session(),
    onDraftChange: vi.fn(),
    labels,
    onSend: send,
    onPreviewChange: readPreview(observed),
    terminalSettings: {
      ...defaults.settings.terminal,
      lineEnding: { kind: "crlf" } as const,
    },
  };
  const view = render(
    <>
      <Toaster />
      <SendPanel {...props} draft={draft} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  const bytes = send.mock.calls[0]![0] as Uint8Array;
  expect(bytes.length).toBe(TX_MAX_BYTES);
  expect([...bytes.slice(-2)]).toEqual([13, 10]);
  view.rerender(
    <>
      <Toaster />
      <SendPanel {...props} draft={draft + "B"} />
    </>,
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    draft + "B",
  );
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "131.07 KB",
  );
  expect(observed).toHaveBeenLastCalledWith(null);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Use Send file for larger content",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledOnce();
});

it("keeps an unconnected draft editable without offering a transfer that requires a session", () => {
  const transfer = vi.fn();
  render(
    <SendPanel
      session={undefined}
      labels={labels}
      draft="AT"
      onDraftChange={vi.fn()}
      onSend={vi.fn()}
      onOpenTransfer={transfer}
      transferLabel="Advanced transfer"
    />,
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toBeEnabled();
  const button = screen.getByRole("button", { name: "Advanced transfer" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(transfer).not.toHaveBeenCalled();
});

it("expands escapes without sending and appends the selected suffix once on send", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  function Consumer() {
    const [draft, setDraft] = useState("AT\\r\\xFF");
    return (
      <SendPanel
        session={session()}
        draft={draft}
        onDraftChange={setDraft}
        terminalSettings={{
          ...defaults.settings.terminal,
          lineEnding: { kind: "lf" },
        }}
        labels={labels}
        onSend={send}
      />
    );
  }
  render(<Consumer />);
  fireEvent.click(
    screen.getByRole("button", { name: labels.expandSendEscapes }),
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "41 54 0D FF",
  );
  expect(screen.getByRole("radio", { name: "HEX" })).toBeChecked();
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toEqual(
    Uint8Array.of(0x41, 0x54, 0x0d, 0xff, 0x0a),
  );
});

it("keeps the source and selects the full incomplete escape for correction", () => {
  const change = vi.fn();
  const original = "中\\xF";
  render(
    <SendPanel
      draft={original}
      onDraftChange={change}
      labels={labels}
      onSend={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: labels.expandSendEscapes }),
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toHaveValue(original);
  expect(input).toHaveProperty("selectionStart", 1);
  expect(input).toHaveProperty("selectionEnd", 4);
  expect(input).toHaveFocus();
  expect(change).not.toHaveBeenCalled();
});

it("shows the exact invalid HEX position and selects it without queuing a send", () => {
  const send = vi.fn();
  const draft = "AA 😃 80";
  render(
    <SendPanel
      session={session()}
      draft={draft}
      onDraftChange={vi.fn()}
      mode="hex"
      labels={labels}
      onSend={send}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toHaveAccessibleDescription(
    "Invalid HEX in the draft at character 4.",
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(input).toHaveProperty("selectionStart", 3);
  expect(input).toHaveProperty("selectionEnd", 5);
  expect(send).not.toHaveBeenCalled();
});

it.each([
  { draft: "你好，串口", ending: { kind: "none" } as LineEnding },
  { draft: "AT+GMR", ending: { kind: "crlf" } as LineEnding },
  { draft: "", ending: { kind: "none" } as LineEnding },
  { draft: "A\nB\r\n", ending: { kind: "crlf" } as LineEnding },
  {
    draft: "é🙂",
    ending: { kind: "custom", bytesBase64: "AP8K" } as LineEnding,
  },
])(
  "converts a text draft to UTF-8 HEX and back without changing its transmitted bytes ($draft)",
  ({ draft, ending }) => {
    const send = vi.fn(),
      observed = vi.fn();
    function Consumer() {
      const [value, setValue] = useState(draft);
      const [mode, setMode] = useState<"text" | "hex">("text");
      return (
        <SendPanel
          session={session()}
          draft={value}
          onDraftChange={setValue}
          mode={mode}
          onSendModeChange={setMode}
          terminalSettings={{
            ...defaults.settings.terminal,
            lineEnding: ending,
          }}
          labels={labels}
          onSend={send}
          onPreviewChange={readPreview(observed)}
        />
      );
    }
    render(<Consumer />);
    const expected = encodeSend(draft, "text", ending);
    expect(observed).toHaveBeenLastCalledWith(expected);
    fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      formatHex(new TextEncoder().encode(draft)),
    );
    expect(observed).toHaveBeenLastCalledWith(expected);
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      draft.replace(/\r\n/g, "\n"),
    );
    expect(observed).toHaveBeenLastCalledWith(expected);
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["0Z", "A", "FF", "C3 28", "E2 82"])(
  "retains invalid or non-UTF-8 HEX %s and its mode when text conversion fails",
  async (draft) => {
    const changed = vi.fn(),
      modeChanged = vi.fn(),
      send = vi.fn();
    render(<Toaster />);
    const view = render(
      <SendPanel
        session={session()}
        draft={draft}
        initialMode="hex"
        onDraftChange={changed}
        onSendModeChange={modeChanged}
        labels={labels}
        onSend={send}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByRole("radio", { name: "HEX" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      draft,
    );
    expect(changed).not.toHaveBeenCalled();
    expect(modeChanged).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(getUserLog()).toEqual([
      expect.objectContaining({ module: "serial", level: "error", count: 1 }),
    ]);
    expect(getUserLog()[0]?.message).toBe(
      draft === "0Z" || draft === "A" ? labels.invalidHex : labels.invalidUtf8,
    );
  },
);

it.each([
  { draft: "41 e4bda0 00\n0A", text: "A你\u0000\n" },
  { draft: "efbbbfE4BDA0", text: "\uFEFF你" },
  { draft: " \n\t", text: "" },
])(
  "decodes a valid existing HEX draft without losing its exact UTF-8 bytes ($draft)",
  ({ draft, text }) => {
    const send = vi.fn(),
      observed = vi.fn();
    function Consumer() {
      const [value, setValue] = useState(draft);
      const [mode, setMode] = useState<"text" | "hex">("hex");
      return (
        <SendPanel
          session={session()}
          draft={value}
          onDraftChange={setValue}
          mode={mode}
          onSendModeChange={setMode}
          labels={labels}
          onSend={send}
          onPreviewChange={readPreview(observed)}
        />
      );
    }
    render(<Consumer />);
    const expected = encodeSend(draft, "hex", { kind: "none" });
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      text,
    );
    expect(observed).toHaveBeenLastCalledWith(expected);
    fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      formatHex(expected),
    );
    expect(observed).toHaveBeenLastCalledWith(expected);
    expect(send).not.toHaveBeenCalled();
  },
);

it("converts an edited draft during an admitted send without modifying the captured TX bytes or restoring an old draft", async () => {
  let finish!: (value: Operation) => void;
  const send = vi.fn(
    (_bytes: Uint8Array) =>
      new Promise<Operation>((resolve) => {
        finish = resolve;
      }),
  );
  function Consumer() {
    const [value, setValue] = useState("你好");
    const [mode, setMode] = useState<"text" | "hex">("text");
    return (
      <SendPanel
        session={session()}
        draft={value}
        onDraftChange={setValue}
        mode={mode}
        onSendModeChange={setMode}
        labels={labels}
        onSend={send}
      />
    );
  }
  render(<Consumer />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const sent = send.mock.calls[0]?.[0];
  expect(sent).toEqual(new TextEncoder().encode("你好"));
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "B" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("42");
  expect(send).toHaveBeenCalledOnce();
  expect(sent).toEqual(new TextEncoder().encode("你好"));
  await act(async () => finish(operation()));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("42");
});
async function openReceipt() {
  const trigger = screen.getByRole("button", { name: "Receipt" });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  return screen.findByRole("status", { name: "Receipt" });
}
it.each([
  {
    byteCount: 14,
    draft: "AT+GMR\r\n123456",
  },
  {
    byteCount: 21,
    draft: "AT+GMR\r\n1234567890123",
  },
])(
  "shows a passive in-frame byte count without a preview control for $byteCount bytes",
  async ({ draft, byteCount }) => {
    const user = userEvent.setup();
    render(
      <SendPanel
        session={session()}
        draft={draft}
        onDraftChange={vi.fn()}
        labels={labels}
        onSend={vi.fn()}
        onSendFile={vi.fn()}
      />,
    );
    const count = screen.getByLabelText(labels.draftByteCount);
    expect(count).toHaveTextContent(`${byteCount} B`);
    expect(count).not.toHaveAttribute("tabindex");
    expect(count.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: /preview/i }),
    ).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Send file" }).focus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: labels.clearDraft }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveFocus();
  },
);
it("ignores a late send receipt after the same session moves to a new epoch", async () => {
  let finish!: (value: Operation) => void;
  const send = vi.fn<
    (bytes: Uint8Array, signal?: AbortSignal) => Promise<Operation>
  >(
    () =>
      new Promise<Operation>((resolve) => {
        finish = resolve;
      }),
  );
  const props = { draft: "AT", onDraftChange: vi.fn(), labels, onSend: send };
  const view = render(<SendPanel {...props} session={session()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const signal = send.mock.calls[0]![1] as AbortSignal;
  view.rerender(
    <SendPanel {...props} session={{ ...session(), sessionEpoch: "2" }} />,
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(operation("old-epoch")));
  expect(
    screen.queryByRole("status", { name: "Receipt" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("old-epoch")).not.toBeInTheDocument();
});

it("clears an existing receipt when the session epoch changes in place", async () => {
  const accepted = operation("old-receipt");
  const props = {
    draft: "AT",
    onDraftChange: vi.fn(),
    labels,
    onSend: vi.fn().mockResolvedValue(accepted),
    operations: [accepted],
  };
  const view = render(<SendPanel {...props} session={session()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await openReceipt()).toHaveTextContent("old-receipt");
  view.rerender(
    <SendPanel {...props} session={{ ...session(), sessionEpoch: "2" }} />,
  );
  expect(
    screen.queryByRole("status", { name: "Receipt" }),
  ).not.toBeInTheDocument();
});

it("does not let an old session failure settle a new session's pending send", async () => {
  let failOld!: (reason: Error) => void;
  let finishNew!: (value: Operation) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Operation>((_resolve, reject) => {
          failOld = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Operation>((resolve) => {
          finishNew = resolve;
        }),
    );
  const props = { draft: "AT", onDraftChange: vi.fn(), labels, onSend: send };
  const view = render(<SendPanel {...props} session={session()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.rerender(<SendPanel {...props} session={session("new-session")} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledTimes(2);
  await act(async () => failOld(new Error("old session failure")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();
  await act(async () => finishNew(operation("new-receipt", "new-session")));
  expect(await openReceipt()).toHaveTextContent("new-receipt");
});
it("applies shared terminal typography to the editable send body", () => {
  const props = {
    draft: "AT",
    onDraftChange: vi.fn(),
    labels,
    onSend: vi.fn(),
  };
  const view = render(<SendPanel {...props} />);
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toHaveStyle({
    fontFamily: "var(--font-mono)",
    fontSize: `${defaults.terminalTypography.fontSize}px`,
    lineHeight: String(defaults.terminalTypography.lineHeightPercent / 100),
    fontVariantLigatures: defaults.terminalTypography.ligatures
      ? "normal"
      : "none",
  });
  view.rerender(
    <SendPanel
      {...props}
      terminalSettings={{
        ...defaults.settings.terminal,
        typography: {
          fontFamily: "Consolas",
          fontSize: 19,
          lineHeightPercent: 180,
          ligatures: true,
        },
      }}
    />,
  );
  expect(input).toHaveStyle({
    fontFamily: "Consolas",
    fontSize: "19px",
    lineHeight: "1.8",
    fontVariantLigatures: "normal",
  });
});

it("blocks ordinary sends and the shortcut when permission is denied while retaining an editable draft", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  const props = {
    session: session(),
    draft: "AT",
    onDraftChange: vi.fn(),
    labels,
    onSend: send,
  };
  const view = render(<SendPanel {...props} permissionAllowed={false} />);
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByText(labels.sendNotAllowed)).toBeInTheDocument();
  view.rerender(<SendPanel {...props} draft="" permissionAllowed={false} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.queryByText(labels.sendNotAllowed)).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Send" }),
  ).toHaveAccessibleDescription(labels.emptyDraft);
  view.rerender(<SendPanel {...props} permissionAllowed />);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
});

it("notifies the final bytes across conversion, line ending and custom HEX changes, and clears them on unmount", () => {
  const preview = vi.fn();
  const props = {
    session: session(),
    draft: "41",
    onDraftChange: vi.fn(),
    labels,
    onSend: vi.fn(),
    onPreviewChange: readPreview(preview),
    presentationLabels: {
      customLineEnding: "Custom",
      customLineEndingHex: "Custom ending (HEX)",
    },
  };
  function Consumer() {
    const [draft, setDraft] = useState(props.draft);
    return <SendPanel {...props} draft={draft} onDraftChange={setDraft} />;
  }
  const view = render(<Consumer />);
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([52, 49]));
  fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([52, 49]));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "CRLF" }), {
    key: "Enter",
  });
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([52, 49, 13, 10]));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "Custom" }), {
    key: "Enter",
  });
  fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  const suffix = screen.getByRole("textbox", { name: "Custom ending (HEX)" });
  fireEvent.change(suffix, { target: { value: "00 FF" } });
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([52, 49, 0, 255]));
  fireEvent.change(suffix, { target: { value: "0Z" } });
  expect(preview).toHaveBeenLastCalledWith(null);
  fireEvent.change(suffix, { target: { value: "0A" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "0Z" },
  });
  expect(preview).toHaveBeenLastCalledWith(null);
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "42" },
  });
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([66, 10]));
  view.unmount();
  expect(preview).toHaveBeenLastCalledWith(null);
});

it("keeps preview notifications stable with StrictMode, inline callbacks and freshly allocated settings", () => {
  function Consumer() {
    const [bytes, setBytes] = useState<Uint8Array | null>(null);
    return (
      <>
        <output aria-label="Observed bytes">
          {bytes ? Array.from(bytes).join(",") : "none"}
        </output>
        <SendPanel
          draft="A"
          labels={labels}
          onDraftChange={vi.fn()}
          onSend={vi.fn()}
          terminalSettings={{
            ...defaults.settings.terminal,
            lineEnding: { kind: "crlf" },
          }}
          onPreviewChange={(next) => setBytes(next?.readBytes() ?? null)}
        />
      </>
    );
  }
  const view = render(
    <StrictMode>
      <Consumer />
    </StrictMode>,
  );
  expect(screen.getByLabelText("Observed bytes")).toHaveTextContent("65,13,10");
  view.unmount();
});

it("isolates preview observers from the exact bytes sent to the Host", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  render(
    <SendPanel
      session={session()}
      draft="AT"
      labels={labels}
      onDraftChange={vi.fn()}
      onSend={send}
      onPreviewChange={(preview) => {
        if (preview) preview.readBytes()[0] = 0;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toEqual(new Uint8Array([65, 84]));
});
it("uses shared send defaults and allows a local mode choice without a controlled mode", () => {
  function Consumer() {
    const [draft, setDraft] = useState("41");
    return (
      <SendPanel
        session={session()}
        draft={draft}
        onDraftChange={setDraft}
        labels={labels}
        onSend={vi.fn()}
        terminalSettings={{
          receiveMode: "text",
          sendMode: "hex",
          lineEnding: { kind: "crlf" },
        }}
      />
    );
  }
  render(<Consumer />);
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("3 B");
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("A");
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("3 B");
});
it("sends with the primary Enter shortcut while rejecting IME, repeats and extra modifiers", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  render(
    <SendPanel
      session={session()}
      draft="AT"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, ...extra });
  }
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(Array.from(send.mock.calls[0]![0] as Uint8Array)).toEqual([65, 84]);
});

it("keeps disconnected drafts editable and explains why sending is disabled", () => {
  const change = vi.fn();
  render(
    <SendPanel
      draft="AT"
      onDraftChange={change}
      labels={labels}
      onSend={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: "AT+GMR" } });
  expect(change).toHaveBeenCalledWith("AT+GMR");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByText("Disconnected")).toBeInTheDocument();
});
it("reports both converted draft and mode to a controlled owner without reinterpreting its bytes", () => {
  const changed = vi.fn();
  const draftChanged = vi.fn();
  const view = render(
    <SendPanel
      session={session()}
      labels={labels}
      draft="41"
      onDraftChange={draftChanged}
      onSend={vi.fn()}
      mode="hex"
      onSendModeChange={changed}
    />,
  );
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("1 B");
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(changed).toHaveBeenCalledWith("text");
  expect(draftChanged).toHaveBeenCalledWith("A");
  view.rerender(
    <SendPanel
      session={session()}
      labels={labels}
      draft="A"
      onDraftChange={() => {}}
      onSend={vi.fn()}
      mode="text"
    />,
  );
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("1 B");
});
it("previews and sends the same custom HEX suffix and blocks invalid suffix bytes", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  render(
    <SendPanel
      session={session()}
      labels={labels}
      draft="A"
      onDraftChange={() => {}}
      onSend={send}
      presentationLabels={{
        customLineEnding: "Custom",
        customLineEndingHex: "Custom ending (HEX)",
      }}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "Custom" }), {
    key: "Enter",
  });
  fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  const suffix = screen.getByRole("textbox", { name: "Custom ending (HEX)" });
  fireEvent.change(suffix, { target: { value: "00 FF 0A" } });
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("4 B");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(Array.from(send.mock.calls[0]![0] as Uint8Array)).toEqual([
    65, 0, 255, 10,
  ]);
  if (!screen.queryByRole("textbox", { name: "Custom ending (HEX)" }))
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Custom ending (HEX)" }),
    {
      target: { value: "0Z" },
    },
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledOnce();
});
it("keeps an explicit file picker available while ordinary sends are read-only", () => {
  const pick = vi.fn();
  render(
    <SendPanel
      session={{ ...session(), readOnly: true }}
      labels={labels}
      draft="AT"
      onDraftChange={vi.fn()}
      onSend={vi.fn()}
      onSendFile={pick}
    />,
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send file" }));
  expect(pick).toHaveBeenCalledOnce();
});
it("updates the receipt from the shared Host operation after admission", async () => {
  const accepted = { ...operation(), state: "queued" as const };
  const send = vi.fn().mockResolvedValue(accepted);
  const view = render(
    <SendPanel
      session={session()}
      draft="Hi"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const receipt = await openReceipt();
  expect(receipt).toHaveTextContent(labels.queued);
  expect(receipt).not.toHaveTextContent(labels.succeeded);
  view.rerender(
    <SendPanel
      session={session()}
      draft="Hi"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
      operations={[{ ...accepted, state: "succeeded", revision: "2" }]}
    />,
  );
  expect(screen.getByRole("status", { name: "Receipt" })).toHaveTextContent(
    labels.succeeded,
  );
});

it.each([
  {
    outcome: "partial",
    bytesBase64: "DQo=",
    byteEnd: "9007199254740995",
    acceptedRanges: [{ start: "0", end: "1" }],
    unknownRanges: [],
    expected: [
      "Requested bytes: [9007199254740993, 9007199254740995)",
      "Bytes accepted by backend: [9007199254740993, 9007199254740994)",
      "Bytes not accepted by backend: [9007199254740994, 9007199254740995)",
    ],
  },
  {
    outcome: "unknown",
    bytesBase64: "AQIDBAU=",
    byteEnd: "9007199254740998",
    acceptedRanges: [
      { start: "3", end: "4" },
      { start: "0", end: "1" },
    ],
    unknownRanges: [{ start: "2", end: "3" }],
    expected: [
      "Requested bytes: [9007199254740993, 9007199254740998)",
      "Bytes accepted by backend: [9007199254740996, 9007199254740997)",
      "Bytes accepted by backend: [9007199254740993, 9007199254740994)",
      "Bytes with unknown outcome: [9007199254740995, 9007199254740996)",
      "Bytes not accepted by backend: [9007199254740994, 9007199254740995)",
      "Bytes not accepted by backend: [9007199254740997, 9007199254740998)",
    ],
  },
] as const)(
  "keeps $outcome write results and exact TX stream ranges visible",
  async ({
    outcome,
    bytesBase64,
    byteEnd,
    acceptedRanges,
    unknownRanges,
    expected,
  }) => {
    const initial: Operation = { ...operation(), state: "queued" };
    const send = vi.fn().mockResolvedValue(initial);
    const props = {
      session: session(),
      draft: "original",
      onDraftChange: vi.fn(),
      labels,
      onSend: send,
    };
    const view = render(<SendPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: labels.send }));
    const receipt = await openReceipt();
    expect(receipt).toHaveTextContent(labels.queued);
    const settled: Operation = {
      ...initial,
      revision: "2",
      state: outcome === "unknown" ? "unknown" : "succeeded",
      result: {
        kind: "tx",
        value: {
          operationId: initial.operationId,
          sessionId: props.session.sessionId,
          sessionEpoch: props.session.sessionEpoch,
          bytesBase64,
          byteStart: "9007199254740993",
          byteEnd,
          acceptedRanges: [...acceptedRanges],
          unknownRanges: [...unknownRanges],
          peerAcknowledged: false,
          outcome,
        },
      },
    };
    view.rerender(<SendPanel {...props} operations={[settled]} />);
    expect(receipt).toHaveTextContent(labels[outcome]);
    expect(receipt).not.toHaveTextContent(labels.succeeded);
    for (const text of expected) expect(receipt).toHaveTextContent(text);
    expect(receipt).toHaveTextContent(labels.peerUnconfirmed);
    expect(screen.getByRole("textbox", { name: labels.draft })).toHaveValue(
      "original",
    );
    expect(send).toHaveBeenCalledOnce();
  },
);

it("uses the exact preview bytes for sending CRLF and preserves the draft", async () => {
  const send = vi.fn().mockResolvedValue(operation());
  render(
    <SendPanel
      session={session()}
      draft="Hi"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "CRLF" }), {
    key: "Enter",
  });
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("4 B");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(Array.from(send.mock.calls[0]![0] as Uint8Array)).toEqual([
    72, 105, 13, 10,
  ]);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("Hi");
});
it("never invokes send for invalid HEX or read-only sessions", () => {
  const send = vi.fn();
  const view = render(
    <SendPanel
      session={session()}
      draft="0Z"
      initialMode="hex"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.rerender(
    <SendPanel
      session={{ ...session(), readOnly: true }}
      draft="41"
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

it("keeps local drafts editable when the source send gate is read-only", () => {
  const change = vi.fn(),
    send = vi.fn();
  render(
    <SendPanel
      readOnly
      labels={labels}
      draft="AT"
      onDraftChange={change}
      onSend={send}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).not.toHaveAttribute("readonly");
  fireEvent.change(input, { target: { value: "AT+GMR" } });
  expect(change).toHaveBeenCalledWith("AT+GMR");
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByText("Read only")).toBeInTheDocument();
});

it("keeps caption actions keyboard reachable without admitting a readonly send", async () => {
  const action = vi.fn(),
    send = vi.fn(),
    user = userEvent.setup();
  render(
    <SendPanel
      readOnly
      draft="AT"
      draftCaption="Unconnected draft"
      draftActions={<button onClick={action}>Save drafts</button>}
      labels={labels}
      onDraftChange={vi.fn()}
      onSend={send}
    />,
  );
  const button = screen.getByRole("button", { name: "Save drafts" });
  expect(button).toBeVisible();
  button.focus();
  await user.keyboard("{Enter}");
  expect(action).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("textbox", { name: "Send input" }),
  ).toHaveAccessibleDescription("Unconnected draft");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

function holdSendFixture() {
  const current = session();
  const target = {
    hostId: "host",
    kind: "session" as const,
    id: current.sessionId,
    sessionId: current.sessionId,
    sessionEpoch: current.sessionEpoch,
  };
  const full: Operation = {
    ...operation(),
    actionId: "session.tx",
    target,
    result: {
      kind: "tx",
      value: {
        operationId: "operation",
        sessionId: current.sessionId,
        sessionEpoch: current.sessionEpoch,
        outcome: "accepted",
        bytesBase64: "QVQ=",
        byteStart: "0",
        byteEnd: "2",
        acceptedRanges: [{ start: "0", end: "2" }],
        unknownRanges: [],
        peerAcknowledged: false,
      },
    },
  };
  const send = vi
    .fn<SendPanelProps["onSend"]>()
    .mockResolvedValue({ ...full, state: "queued", result: undefined });
  const wait =
    vi.fn<(operation: Operation, signal: AbortSignal) => Promise<Operation>>();
  return {
    full,
    send,
    wait,
    props: {
      session: current,
      labels,
      draft: "AT",
      onDraftChange: vi.fn(),
      onSend: send,
      holdSend: { scope: "view", target, wait },
    },
  };
}

it("repeats only after complete Host settlement and stops on a partial write", async () => {
  vi.useFakeTimers();
  try {
    const { full, send, wait, props } = holdSendFixture();
    let finish!: (result: Operation) => void;
    const pending = new Promise<Operation>((resolve) => {
      finish = resolve;
    });
    const result = full.result;
    if (result?.kind !== "tx") throw new Error("Expected a TX receipt");
    wait.mockReturnValueOnce(pending).mockResolvedValueOnce({
      ...full,
      result: {
        kind: "tx",
        value: {
          ...result.value,
          outcome: "partial",
          acceptedRanges: [{ start: "0", end: "1" }],
        },
      },
    });
    render(<SendPanel {...props} />);
    const hold = screen.getByRole("button", { name: labels.holdSend });

    fireEvent.keyDown(hold, { key: " " });
    await act(() => vi.advanceTimersByTimeAsync(349));
    expect(send).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(send).toHaveBeenCalledExactlyOnceWith(
      Uint8Array.of(0x41, 0x54),
      expect.any(AbortSignal),
      undefined,
      props.session.revision,
    );
    expect(wait).toHaveBeenCalledOnce();
    fireEvent.keyDown(hold, { key: " ", repeat: true });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(send).toHaveBeenCalledOnce();

    await act(async () => finish(full));
    await act(() => vi.advanceTimersByTimeAsync(179));
    expect(send).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(send).toHaveBeenCalledTimes(2);
    expect(hold).not.toHaveAttribute("aria-busy");
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(send).toHaveBeenCalledTimes(2);
    fireEvent.keyUp(hold, { key: " " });
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("stops repeating and keeps the admitted receipt when status cannot be read", async () => {
  vi.useFakeTimers();
  try {
    const { send, wait, props } = holdSendFixture();
    wait.mockRejectedValue(new Error("Status read failed"));
    render(<SendPanel {...props} />);
    const hold = screen.getByRole("button", { name: labels.holdSend });

    fireEvent.keyDown(hold, { key: " " });
    await act(() => vi.advanceTimersByTimeAsync(950));

    expect(send).toHaveBeenCalledOnce();
    expect(hold).not.toHaveAttribute("aria-busy");
    expect(getUserLog()).toEqual([
      expect.objectContaining({ message: labels.holdSendWaitFailed }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: labels.receipt }));
    expect(
      screen.getByRole("status", { name: labels.receipt }),
    ).toHaveTextContent(labels.queued);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it.each([
  "short press",
  "release",
  "blur",
  "hidden",
  "draft",
  "permission",
  "disconnect",
  "epoch",
  "revision",
] as const)(
  "stops held TX on %s and keeps an admitted write intact",
  async (change) => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const { full, send, wait, props } = holdSendFixture();
      let finish!: (result: Operation) => void;
      wait.mockReturnValue(
        new Promise<Operation>((resolve) => {
          finish = resolve;
        }),
      );
      const view = render(<SendPanel {...props} />);
      const hold = screen.getByRole("button", { name: labels.holdSend });
      fireEvent.keyDown(hold, { key: "Enter" });
      if (change === "short press") {
        fireEvent.keyUp(hold, { key: "Enter" });
        await act(() => vi.advanceTimersByTimeAsync(600));
        expect(send).not.toHaveBeenCalled();
        return;
      }
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(send).toHaveBeenCalledOnce();
      const waitSignal = wait.mock.calls[0]?.[1];
      const sentSignal = send.mock.calls[0]?.[1];
      if (!waitSignal || !sentSignal)
        throw new Error("Missing active Host request signals");
      if (change === "release") fireEvent.keyUp(hold, { key: "Enter" });
      if (change === "blur") fireEvent(window, new Event("blur"));
      if (change === "hidden") {
        hidden.mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      }
      if (change === "draft")
        view.rerender(<SendPanel {...props} draft="other" />);
      if (change === "permission")
        view.rerender(<SendPanel {...props} permissionAllowed={false} />);
      if (change === "disconnect")
        view.rerender(
          <SendPanel
            {...props}
            session={{ ...props.session, state: "disconnected" }}
          />,
        );
      if (change === "epoch")
        view.rerender(
          <SendPanel
            {...props}
            session={{ ...props.session, sessionEpoch: "92" }}
          />,
        );
      if (change === "revision")
        view.rerender(
          <SendPanel
            {...props}
            session={{ ...props.session, revision: "31" }}
          />,
        );
      expect(waitSignal.aborted).toBe(true);
      if (change === "release") expect(sentSignal.aborted).toBe(false);
      await act(async () => finish(full));
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(send).toHaveBeenCalledOnce();
    } finally {
      hidden.mockRestore();
      cleanup();
      vi.useRealTimers();
    }
  },
);
