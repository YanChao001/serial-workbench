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
import { defaults } from "@serial-workbench/contracts";
import type { Operation } from "@serial-workbench/contracts";
import type { LineEnding } from "@serial-workbench/contracts";
import { encodeSend, formatHex } from "@serial-workbench/host-client";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { SendPanel } from "./send-panel";
import { labels, operation, session } from "./test-fixtures";
afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
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
          onPreviewChange={observed}
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
          onPreviewChange={observed}
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
    expect(count).toHaveTextContent(`${byteCount} bytes`);
    expect(count).not.toHaveAttribute("tabindex");
    expect(count.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: /preview/i }),
    ).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Send file" }).focus();
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
    onPreviewChange: preview,
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
          onPreviewChange={(next) => setBytes(next)}
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
      onPreviewChange={(bytes) => {
        if (bytes) bytes[0] = 0;
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
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "3 bytes",
  );
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("A");
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "3 bytes",
  );
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
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "1 bytes",
  );
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
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "1 bytes",
  );
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
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "4 bytes",
  );
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
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent(
    "4 bytes",
  );
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
