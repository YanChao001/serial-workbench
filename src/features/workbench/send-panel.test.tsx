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
import { SendPanel } from "./send-panel";
import { labels, operation, session } from "./test-fixtures";
afterEach(cleanup);
it.each([
  {
    byteCount: 14,
    draft: "AT+GMR\r\n123456",
    expected: "41 54 2B 47 4D 52 0D 0A 31 32 33 34 35 36 (14 bytes)",
  },
  {
    byteCount: 21,
    draft: "AT+GMR\r\n1234567890123",
    expected:
      "41 54 2B 47 4D 52 0D 0A 31 32 33 34 35 36 37 38 39 30 31 32 33 (21 bytes)",
  },
])(
  "includes the byte preview in keyboard navigation for $byteCount bytes",
  async ({ draft, expected }) => {
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
    const preview = screen.getByLabelText("Byte preview");
    expect(preview).toHaveTextContent(expected);
    screen.getByRole("button", { name: "Send file" }).focus();
    await user.tab();
    expect(preview).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(preview).toHaveFocus();
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
  expect(
    await screen.findByRole("status", { name: "Receipt" }),
  ).toHaveTextContent("old-receipt");
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
  expect(screen.getByRole("status", { name: "Receipt" })).toHaveTextContent(
    "new-receipt",
  );
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
    fontFamily: defaults.terminalTypography.fontFamily,
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
  expect(screen.getByText(labels.unavailable)).toBeInTheDocument();
  view.rerender(<SendPanel {...props} draft="" permissionAllowed={false} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.queryByText(labels.unavailable)).not.toBeInTheDocument();
  view.rerender(<SendPanel {...props} permissionAllowed />);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
});

it("notifies the final preview across mode, line ending and custom HEX changes, and clears it on unmount", () => {
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
  const view = render(<SendPanel {...props} />);
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([52, 49]));
  fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([65]));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "CRLF" }), {
    key: "Enter",
  });
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([65, 13, 10]));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Line ending" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: "Custom" }), {
    key: "Enter",
  });
  const suffix = screen.getByRole("textbox", { name: "Custom ending (HEX)" });
  fireEvent.change(suffix, { target: { value: "00 FF" } });
  expect(preview).toHaveBeenLastCalledWith(new Uint8Array([65, 0, 255]));
  fireEvent.change(suffix, { target: { value: "0Z" } });
  expect(preview).toHaveBeenLastCalledWith(null);
  fireEvent.change(suffix, { target: { value: "0A" } });
  view.rerender(<SendPanel {...props} draft="0Z" />);
  expect(preview).toHaveBeenLastCalledWith(null);
  view.rerender(<SendPanel {...props} draft="42" />);
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
  render(
    <SendPanel
      session={session()}
      draft="41"
      onDraftChange={() => {}}
      labels={labels}
      onSend={vi.fn()}
      terminalSettings={{
        receiveMode: "text",
        sendMode: "hex",
        lineEnding: { kind: "crlf" },
      }}
    />,
  );
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "41 0D 0A (3 bytes)",
  );
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "34 31 0D 0A (4 bytes)",
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
it("updates preview from controlled send mode and reports an explicit mode change", () => {
  const changed = vi.fn();
  const view = render(
    <SendPanel
      session={session()}
      labels={labels}
      draft="41"
      onDraftChange={() => {}}
      onSend={vi.fn()}
      mode="hex"
      onSendModeChange={changed}
    />,
  );
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "41 (1 bytes)",
  );
  fireEvent.click(screen.getByRole("radio", { name: "Text" }));
  expect(changed).toHaveBeenCalledWith("text");
  view.rerender(
    <SendPanel
      session={session()}
      labels={labels}
      draft="41"
      onDraftChange={() => {}}
      onSend={vi.fn()}
      mode="text"
    />,
  );
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "34 31 (2 bytes)",
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
  const suffix = screen.getByRole("textbox", { name: "Custom ending (HEX)" });
  fireEvent.change(suffix, { target: { value: "00 FF 0A" } });
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "41 00 FF 0A",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(Array.from(send.mock.calls[0]![0] as Uint8Array)).toEqual([
    65, 0, 255, 10,
  ]);
  fireEvent.change(suffix, { target: { value: "0Z" } });
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
  const receipt = await screen.findByRole("status", { name: "Receipt" });
  expect(receipt).toHaveTextContent("queued");
  expect(screen.getByText(/Receipt:/)).not.toHaveTextContent("operation");
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
    "succeeded",
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
  expect(screen.getByLabelText("Byte preview")).toHaveTextContent(
    "48 69 0D 0A",
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
      onDraftChange={() => {}}
      labels={labels}
      onSend={send}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "HEX" }));
  expect(screen.getByRole("alert")).toHaveTextContent(labels.invalidHex);
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
