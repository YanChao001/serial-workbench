import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
  const view = render(<TransferOptions {...props} target={target} />);
  expect(screen.getByRole("button", { name: "Select source" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Select source" }));
  await screen.findByText("payload.bin");
  const button = () => screen.getByRole("button", { name: "Send file" });
  expect(button()).toBeDisabled();
  fireEvent.click(button());
  expect(transfer).not.toHaveBeenCalled();
  const first = observer.subscriptions.at(-1)!;
  act(() => observer.publish(first, () => false));
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Bytes per second"), {
    target: { value: "2000" },
  });
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeDisabled();
  const edited = observer.subscriptions.at(-1)!;
  expect(edited.inputs[0]).toMatchObject({
    actionId: "transfer.file",
    target,
    params: { bytesPerSecond: "2000", sourceRef: selectedFile.reference },
  });
  act(() => observer.publish(edited, () => true));
  expect(button()).toBeEnabled();
  view.rerender(
    <TransferOptions {...props} target={{ ...target, sessionEpoch: "2" }} />,
  );
  expect(button()).toBeDisabled();
  act(() => observer.publish(edited, () => true));
  expect(button()).toBeDisabled();
  view.unmount();
  expect(observer.subscriptions.at(-1)?.stopped).toBe(true);
});
