import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { TransferOptions } from "./transfer-options";
import { operation } from "./test-fixtures";
import { selectedFile, toolLabels } from "./transfer-capture-test-helpers";
import {
  allowControlActions,
  observeControlActions,
  target,
} from "./session-controls.test-fixtures";
import {
  UnsavedWorkContext,
  type UnsavedWork,
} from "@/providers/unsaved-work-context";
afterEach(cleanup);
it("previews an exact large range without sending, then explicitly submits fixed source parameters", async () => {
  const transfer = vi.fn().mockResolvedValue(operation());
  render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="session:1"
      labels={toolLabels}
      pickSource={async () => selectedFile}
      onTransfer={transfer}
      writeWaitMs="1000"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  await screen.findByText("payload.bin");
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Offset"), {
    target: { value: "9007199254740990" },
  });
  fireEvent.change(screen.getByLabelText("Length"), { target: { value: "9" } });
  expect(screen.getByLabelText("Range preview")).toHaveTextContent(
    "[9007199254740990, 9007199254740999)",
  );
  expect(transfer).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send file" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send file" }));
  await waitFor(() =>
    expect(transfer).toHaveBeenCalledWith(
      {
        sourceRef: selectedFile.reference,
        offset: "9007199254740990",
        length: "9",
        chunkBytes: "4096",
        bytesPerSecond: "1048576",
        interChunkMs: "0",
        writeWaitMs: "1000",
      },
      expect.any(AbortSignal),
    ),
  );
});
it("keeps zero write wait out of an otherwise valid transfer request", async () => {
  render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="session:1"
      labels={toolLabels}
      pickSource={async () => selectedFile}
      onTransfer={vi.fn()}
      writeWaitMs="1000"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  await screen.findByText("payload.bin");
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Write wait milliseconds"), {
    target: { value: "0" },
  });
  expect(screen.getByRole("button", { name: "Send file" })).toBeDisabled();
});
it("prevents invalid ranges and ignores a picker result after unmount", async () => {
  const view = render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="session:1"
      labels={toolLabels}
      pickSource={async () => selectedFile}
      onTransfer={vi.fn()}
      writeWaitMs="1000"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  await screen.findByText("payload.bin");
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Offset"), {
    target: { value: "9007199254740999" },
  });
  fireEvent.change(screen.getByLabelText("Length"), { target: { value: "1" } });
  expect(screen.getByRole("button", { name: "Send file" })).toBeDisabled();
  view.unmount();
  let signal: AbortSignal | undefined;
  let resolve!: (value: typeof selectedFile) => void;
  const next = render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="session:2"
      labels={toolLabels}
      pickSource={(s) => {
        signal = s;
        return new Promise((done) => {
          resolve = done;
        });
      }}
      onTransfer={vi.fn()}
      writeWaitMs="1000"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  next.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(selectedFile));
});
it("registers edited parameters as unsaved work and saving options never submits a transfer", async () => {
  let work: UnsavedWork | undefined;
  const save = vi.fn().mockResolvedValue(undefined),
    transfer = vi.fn();
  render(
    <UnsavedWorkContext.Provider
      value={{
        requestLeave: async () => true,
        releaseScope: () => {},
        register: (value) => {
          work = value;
        },
        unregister: vi.fn(),
      }}
    >
      <TransferOptions
        target={target}
        watchActions={allowControlActions}
        contextKey="session:1"
        labels={toolLabels}
        pickSource={async () => selectedFile}
        onTransfer={transfer}
        onSaveDraft={save}
        writeWaitMs="1000"
      />
    </UnsavedWorkContext.Provider>,
  );
  expect(work?.dirty).toBe(false);
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Bytes per second"), {
    target: { value: "2500" },
  });
  expect(work?.dirty).toBe(true);
  await act(async () => work!.save!());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ bytesPerSecond: "2500" }),
    undefined,
  );
  expect(transfer).not.toHaveBeenCalled();
  expect(work?.dirty).toBe(false);
});

it("allows Native source selection while transfer rights are unknown and invalidates exact inputs on edits and epoch changes", async () => {
  const observer = observeControlActions();
  const transfer = vi.fn();
  const props = {
    contextKey: "session:1",
    labels: toolLabels,
    pickSource: async () => selectedFile,
    onTransfer: transfer,
    writeWaitMs: "1000",
    watchActions: observer.watchActions,
  };
  const observeTransfer = (sessionEpoch: string, bytesPerSecond?: string) =>
    waitFor(() => {
      const subscription = observer.subscriptions.at(-1);
      if (!subscription || subscription.stopped)
        throw new Error("The current transfer observation has not started");
      expect(subscription.inputs[0]).toMatchObject({
        actionId: "transfer.file",
        target: { ...target, sessionEpoch },
        params: {
          sourceRef: selectedFile.reference,
          ...(bytesPerSecond ? { bytesPerSecond } : {}),
        },
      });
      return subscription;
    });
  const view = render(<TransferOptions {...props} target={target} />);
  expect(screen.getByRole("button", { name: "Select source" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  await screen.findByText("payload.bin");
  const button = () => screen.getByRole("button", { name: "Send file" });
  expect(button()).toBeDisabled();
  fireEvent.click(button());
  expect(transfer).not.toHaveBeenCalled();
  const first = await observeTransfer("1");
  act(() => observer.publish(first, () => false));
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeEnabled();
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Bytes per second"), {
    target: { value: "2000" },
  });
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeDisabled();
  const edited = await observeTransfer("1", "2000");
  act(() => observer.publish(edited, () => true));
  expect(button()).toBeEnabled();
  view.rerender(
    <TransferOptions {...props} target={{ ...target, sessionEpoch: "2" }} />,
  );
  expect(button()).toBeDisabled();
  act(() => observer.publish(edited, () => true));
  expect(button()).toBeDisabled();
  const switched = await observeTransfer("2", "2000");
  view.unmount();
  expect(switched.stopped).toBe(true);
});

it("resumes a monitored transfer for this session, cancels the exact operation, and shows its terminal evidence", async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const sent = {
    ...operation("matching-file"),
    actionId: "transfer.file",
    state: "running",
    target,
    result: {
      kind: "file_transfer",
      value: {
        requested: "10",
        accepted: "4",
        unknown: "1",
        peerAcknowledged: false,
        receiptsRef: {
          hostId: "host",
          kind: "file",
          id: "receipts",
          revision: "1",
        },
      },
    },
  } as const;
  const stale = {
    ...sent,
    operationId: "old-file",
    target: { ...target, sessionEpoch: "0" },
  };
  const props = {
    labels: toolLabels,
    writeWaitMs: "1000",
    contextKey: "session:1",
    target,
    watchActions: allowControlActions,
    onCancel: cancel,
  };
  const view = render(
    <TransferOptions {...props} operations={[stale, sent]} />,
  );
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "4 B / 10 B",
  );
  const stop = screen.getByRole("button", { name: toolLabels.cancel });
  await waitFor(() => expect(stop).toBeEnabled());
  await userEvent.setup().click(stop);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(sent, expect.any(AbortSignal));
  expect(screen.getByText(toolLabels.cancelRequested)).toBeInTheDocument();

  view.rerender(
    <TransferOptions
      {...props}
      operations={[stale, { ...sent, state: "cancelled" }]}
    />,
  );
  expect(
    screen.getByText(toolLabels.operationText.states.cancelled),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText(toolLabels.operationText.transfer.acceptedBytes),
  ).toHaveTextContent("4 B");
  expect(
    screen.getByLabelText(toolLabels.operationText.transfer.unknownBytes),
  ).toHaveTextContent("1 B");
  expect(
    screen.queryByRole("button", { name: toolLabels.cancel }),
  ).not.toBeInTheDocument();
});

it("shows browser local byte preview without uploading and lets the user cancel the handoff", async () => {
  const selected = new File([new Uint8Array([0, 255, 36, 123])], "browser.bin");
  const browserFile = {
    hasPending: () => false,
    recover: vi.fn(),
    send: vi.fn(async (_target, _file, _draft, report, signal: AbortSignal) => {
      report({ kind: "upload", received: 2, total: 4 });
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return null;
    }),
  };
  const { container } = render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="browser:1"
      labels={toolLabels}
      browserFile={browserFile}
      browserTransferAvailable
      writeWaitMs="1000"
    />,
  );
  const chooser = screen.getByRole("button", { name: "Select source" });
  await waitFor(() => expect(chooser).toBeEnabled());
  const user = userEvent.setup();
  await user.upload(
    container.querySelector<HTMLInputElement>('input[type="file"]')!,
    selected,
  );
  expect(screen.getByRole("textbox", { name: toolLabels.source })).toHaveValue(
    "browser.bin",
  );
  fireEvent.change(screen.getByLabelText("Offset"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Length"), { target: { value: "2" } });
  await waitFor(() =>
    expect(
      screen.getByLabelText(toolLabels.browserFile.sample),
    ).toHaveTextContent("1: FF 24"),
  );
  expect(browserFile.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send file" }));
  expect(
    await screen.findByRole("progressbar", {
      name: toolLabels.browserFile.upload,
    }),
  ).toHaveAttribute("aria-valuetext", "2 B / 4 B");
  expect(browserFile.send).toHaveBeenCalledWith(
    target,
    selected,
    expect.objectContaining({ offset: "1", length: "2" }),
    expect.any(Function),
    expect.any(AbortSignal),
  );
  await user.click(
    screen.getByRole("button", { name: toolLabels.browserFile.cancelUpload }),
  );
  await screen.findByText(toolLabels.browserFile.uploadCancelled);
  expect(screen.getByRole("button", { name: "Send file" })).toBeEnabled();
});

it("keeps read-only browser file selection and sending unavailable", async () => {
  const browserFile = {
    hasPending: () => false,
    recover: vi.fn(),
    send: vi.fn(),
  };
  render(
    <TransferOptions
      target={target}
      watchActions={allowControlActions}
      contextKey="browser:1"
      labels={toolLabels}
      browserFile={browserFile}
      browserTransferAvailable={false}
      writeWaitMs="1000"
    />,
  );
  expect(screen.getByRole("button", { name: "Select source" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send file" })).toBeDisabled();
  expect(screen.getByText(toolLabels.browserFile.unavailable)).toBeVisible();
  expect(browserFile.send).not.toHaveBeenCalled();
});
