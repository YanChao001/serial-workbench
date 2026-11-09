import {
  allowControlActions,
  observeControlActions,
} from "./session-controls.test-fixtures";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import { CaptureTools } from "./capture-tools";
import { operation } from "./test-fixtures";
import {
  selectedFile,
  toolLabels,
  verification,
} from "./transfer-capture-test-helpers";
afterEach(cleanup);
it("requires the current original fingerprint confirmation before a raw replace", async () => {
  const start = vi.fn().mockResolvedValue(operation());
  const readMetadata = vi.fn().mockResolvedValue({
    fileRef: selectedFile.reference,
    purpose: "capture_target",
    length: "123",
    fingerprint: "a".repeat(64),
  });
  const sessionRefs = [
    {
      hostId: "host",
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
  ];
  render(
    <CaptureTools
      watchActions={allowControlActions}
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={sessionRefs}
      pickFile={async () => selectedFile}
      onStart={start}
      {...{ readMetadata }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await screen.findByText("payload.bin");
  fireEvent.change(screen.getByLabelText("Write mode"), {
    target: { value: "replace" },
  });
  await waitFor(() =>
    expect(readMetadata).toHaveBeenCalledWith(
      selectedFile.reference,
      expect.any(AbortSignal),
    ),
  );
  expect(
    screen.getByLabelText("Expected original fingerprint"),
  ).toHaveAttribute("readonly");
  expect(screen.getByLabelText("Expected original fingerprint")).toHaveValue(
    "a".repeat(64),
  );
  expect(screen.getByLabelText("Target revision")).toHaveTextContent("3");
  expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Confirm this original fingerprint for replacement",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start capture" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      {
        targetRef: selectedFile.reference,
        sessionRefs,
        mode: "raw",
        overflowPolicy: "stop",
        writeMode: "replace",
        storageLimits: defaults.captureStorageLimits,
        expectedFingerprint: "a".repeat(64),
      },
      expect.any(AbortSignal),
    ),
  );
});
it("shows actual corrupt and discontinuous evidence then recovers only the verified prefix to a separately picked target", async () => {
  const destination = {
    ...selectedFile,
    reference: { ...selectedFile.reference, id: "new-target" },
    name: "recovered",
  };
  const pick = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(destination);
  const recover = vi.fn().mockResolvedValue(operation());
  const verify = vi.fn().mockResolvedValue({
    ...operation(),
    result: { kind: "capture_verification", value: verification },
  });
  render(
    <CaptureTools
      watchActions={allowControlActions}
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={[]}
      pickFile={pick}
      onVerify={verify}
      onRecover={recover}
    />,
  );
  expect(verify).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify capture" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify capture" }));
  await screen.findByText("corrupt");
  expect(screen.getByLabelText("Container complete")).toHaveTextContent("No");
  expect(screen.getByLabelText("Source continuous")).toHaveTextContent("No");
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save verified prefix as" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save verified prefix as" }),
  );
  await waitFor(() =>
    expect(recover).toHaveBeenCalledWith(
      {
        verificationId: "verified-source",
        sourceFingerprint: "a".repeat(64),
        targetRef: destination.reference,
      },
      expect.any(AbortSignal),
    ),
  );
  expect(pick).toHaveBeenLastCalledWith(
    "captureTarget",
    expect.any(AbortSignal),
  );
});
it("uses an explicitly picked destination for text export and sends selected read-only replay timing", async () => {
  const destination = {
    ...selectedFile,
    reference: { ...selectedFile.reference, id: "text-target" },
  };
  const pick = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(destination);
  const exportText = vi.fn().mockResolvedValue(operation()),
    replay = vi.fn().mockResolvedValue(operation());
  render(
    <CaptureTools
      watchActions={allowControlActions}
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={[]}
      pickFile={pick}
      onExport={exportText}
      onReplay={replay}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  expect(exportText).not.toHaveBeenCalled();
  expect(replay).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Export text as" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export text as" }));
  await waitFor(() =>
    expect(exportText).toHaveBeenCalledWith(
      { captureRef: selectedFile.reference, targetRef: destination.reference },
      expect.any(AbortSignal),
    ),
  );
  fireEvent.change(screen.getByLabelText("Replay timing"), {
    target: { value: "fastest" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
  await waitFor(() =>
    expect(replay).toHaveBeenCalledWith(
      { captureRef: selectedFile.reference, mode: "fastest" },
      expect.any(AbortSignal),
    ),
  );
});
it("tracks the actual verification operation and retains its report when recovery fails", async () => {
  const selected = { ...operation("verify"), state: "running" as const };
  const pick = vi.fn().mockResolvedValue(selectedFile);
  const props = {
    contextKey: "host:1",
    labels: toolLabels,
    sessionRefs: [],
    pickFile: pick,
    onVerify: async () => selected,
    onRecover: async () => {
      throw {
        code: "TARGET_EXISTS",
        message: "Original retained",
        retryable: false,
      };
    },
  };
  const view = render(
    <CaptureTools
      watchActions={allowControlActions}
      {...props}
      operations={[]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify capture" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify capture" }));
  await screen.findByText("verify · running");
  expect(
    screen.getByRole("button", { name: "Save verified prefix as" }),
  ).toBeDisabled();
  view.rerender(
    <CaptureTools
      watchActions={allowControlActions}
      {...props}
      operations={[
        {
          ...selected,
          state: "succeeded",
          result: { kind: "capture_verification", value: verification },
        },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save verified prefix as" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save verified prefix as" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("TARGET_EXISTS");
  expect(screen.getByLabelText("Source continuous")).toHaveTextContent("No");
  expect(screen.getByText("corrupt")).toBeInTheDocument();
});
it("aborts verification and drops a late report when attachment generation changes", async () => {
  let signal: AbortSignal | undefined,
    resolve!: (value: ReturnType<typeof operation>) => void;
  const props = {
    labels: toolLabels,
    sessionRefs: [],
    pickFile: async () => selectedFile,
    onVerify: (_params: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise<ReturnType<typeof operation>>((done) => {
        resolve = done;
      });
    },
  };
  const view = render(
    <CaptureTools
      watchActions={allowControlActions}
      {...props}
      contextKey="host:1"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify capture" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify capture" }));
  view.rerender(
    <CaptureTools
      watchActions={allowControlActions}
      {...props}
      contextKey="host:2"
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    resolve({
      ...operation(),
      result: { kind: "capture_verification", value: verification },
    }),
  );
  expect(screen.queryByText("corrupt")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save verified prefix as" }),
  ).toBeDisabled();
});

it("keeps source rights independent and invalidates replay timing and source reference grants", async () => {
  const observer = observeControlActions();
  const verify = vi.fn(),
    replay = vi.fn();
  const second = {
    ...selectedFile,
    name: "second.capture",
    reference: { ...selectedFile.reference, id: "second", revision: "4" },
  };
  const pick = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(second);
  render(
    <CaptureTools
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={[]}
      pickFile={pick}
      onVerify={verify}
      onReplay={replay}
      watchActions={observer.watchActions}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Select capture source" }),
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  const verifyButton = () =>
    screen.getByRole("button", { name: "Verify capture" });
  const replayButton = () =>
    screen.getByRole("button", { name: "Open replay" });
  expect(verifyButton()).toBeDisabled();
  expect(replayButton()).toBeDisabled();
  const first = observer.subscriptions.at(-1)!;
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.verify"),
  );
  expect(verifyButton()).toBeEnabled();
  expect(replayButton()).toBeDisabled();
  act(() =>
    observer.publish(first, (input) => input.actionId === "replay.open"),
  );
  expect(verifyButton()).toBeDisabled();
  expect(replayButton()).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Replay timing"), {
    target: { value: "fastest" },
  });
  expect(replayButton()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(replayButton()).toBeDisabled();
  const timing = observer.subscriptions.at(-1)!;
  expect(timing.inputs).toContainEqual({
    actionId: "replay.open",
    target: { hostId: "host", kind: "file", id: "source" },
    params: { captureRef: selectedFile.reference, mode: "fastest" },
  });
  act(() => observer.publish(timing, () => true));
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("second.capture");
  expect(replayButton()).toBeDisabled();
  act(() => observer.publish(timing, () => true));
  expect(replayButton()).toBeDisabled();
  fireEvent.click(replayButton());
  expect(replay).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
});
it("observes a complete recovery token and selected destination without starting work, then clears grants for a replacement token", async () => {
  const observer = observeControlActions();
  const selected = {
    ...operation("verification"),
    state: "succeeded" as const,
    result: { kind: "capture_verification" as const, value: verification },
  };
  const targetFile = {
    ...selectedFile,
    name: "recovery-target",
    reference: { ...selectedFile.reference, id: "target" },
  };
  const pick = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(targetFile);
  const recover = vi.fn(),
    exportText = vi.fn();
  const props = {
    contextKey: "host:1",
    labels: toolLabels,
    sessionRefs: [],
    pickFile: pick,
    onVerify: async () => selected,
    onRecover: recover,
    onExport: exportText,
    watchActions: observer.watchActions,
  };
  const view = render(<CaptureTools {...props} operations={[selected]} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  act(() =>
    observer.publish(
      observer.subscriptions.at(-1)!,
      (input) => input.actionId === "capture.verify",
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify capture" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify capture" }));
  await screen.findByText("corrupt");
  expect(
    screen.getByRole("button", { name: "Select capture target" }),
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await screen.findByText("recovery-target");
  expect(recover).not.toHaveBeenCalled();
  expect(exportText).not.toHaveBeenCalled();
  const recoverButton = () =>
    screen.getByRole("button", { name: "Save verified prefix as" });
  const exportButton = () =>
    screen.getByRole("button", { name: "Export text as" });
  expect(recoverButton()).toBeDisabled();
  expect(exportButton()).toBeDisabled();
  const first = observer.subscriptions.at(-1)!;
  expect(first.inputs).toContainEqual({
    actionId: "capture.recover",
    target: { hostId: "host", kind: "file", id: "target" },
    params: {
      verificationId: "verified-source",
      sourceFingerprint: "a".repeat(64),
      targetRef: targetFile.reference,
    },
  });
  act(() =>
    observer.publish(first, (input) => input.actionId === "capture.recover"),
  );
  expect(recoverButton()).toBeEnabled();
  expect(exportButton()).toBeDisabled();
  view.rerender(
    <CaptureTools
      {...props}
      operations={[
        {
          ...selected,
          result: {
            kind: "capture_verification",
            value: {
              ...verification,
              verificationId: "replacement-token",
              sourceFingerprint: "b".repeat(64),
            },
          },
        },
      ]}
    />,
  );
  expect(recoverButton()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(recoverButton()).toBeDisabled();
  expect(recover).not.toHaveBeenCalled();
});
it("gates capture start by exact target, write mode and source session epoch", async () => {
  const observer = observeControlActions();
  const start = vi.fn();
  const firstSession = {
    hostId: "host",
    kind: "session",
    id: "session",
    sessionId: "session",
    sessionEpoch: "1",
  };
  const props = {
    contextKey: "host:1",
    labels: toolLabels,
    pickFile: async () => selectedFile,
    onStart: start,
    watchActions: observer.watchActions,
  };
  const view = render(<CaptureTools {...props} sessionRefs={[firstSession]} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await screen.findByText("payload.bin");
  const button = () => screen.getByRole("button", { name: "Start capture" });
  expect(button()).toBeDisabled();
  const first = observer.subscriptions.at(-1)!;
  expect(first.inputs).toContainEqual({
    actionId: "capture.start",
    target: { hostId: "host", kind: "file", id: "source" },
    params: {
      targetRef: selectedFile.reference,
      sessionRefs: [firstSession],
      mode: "raw",
      overflowPolicy: "stop",
      writeMode: "create_new",
      storageLimits: defaults.captureStorageLimits,
    },
  });
  act(() => observer.publish(first, () => false));
  expect(button()).toBeDisabled();
  fireEvent.click(button());
  expect(start).not.toHaveBeenCalled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Write mode"), {
    target: { value: "append" },
  });
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeDisabled();
  const append = observer.subscriptions.at(-1)!;
  act(() => observer.publish(append, () => true));
  expect(button()).toBeEnabled();
  view.rerender(
    <CaptureTools
      {...props}
      sessionRefs={[{ ...firstSession, sessionEpoch: "2" }]}
    />,
  );
  expect(button()).toBeDisabled();
  act(() => observer.publish(append, () => true));
  expect(button()).toBeDisabled();
  expect(observer.subscriptions.at(-1)?.inputs).toContainEqual({
    actionId: "capture.start",
    target: { hostId: "host", kind: "file", id: "source" },
    params: {
      targetRef: selectedFile.reference,
      sessionRefs: [{ ...firstSession, sessionEpoch: "2" }],
      mode: "raw",
      overflowPolicy: "stop",
      writeMode: "append",
      storageLimits: defaults.captureStorageLimits,
    },
  });
});

it("clears replacement evidence and confirmation when selection is cancelled or metadata fails", async () => {
  const readMetadata = vi
    .fn()
    .mockResolvedValueOnce({
      fileRef: selectedFile.reference,
      purpose: "capture_target",
      length: "123",
      fingerprint: "a".repeat(64),
    })
    .mockRejectedValueOnce(new Error("REVISION_CONFLICT"));
  const pickFile = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(selectedFile);
  render(
    <CaptureTools
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={[{ hostId: "host", kind: "session", id: "session" }]}
      pickFile={pickFile}
      readMetadata={readMetadata}
      watchActions={allowControlActions}
      onStart={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Write mode"), {
    target: { value: "replace" },
  });
  const pick = () =>
    screen.getByRole("button", { name: "Select capture target" });
  fireEvent.click(pick());
  await waitFor(() =>
    expect(screen.getByLabelText("Expected original fingerprint")).toHaveValue(
      "a".repeat(64),
    ),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start capture" })).toBeEnabled(),
  );
  fireEvent.click(pick());
  await waitFor(() => expect(pick()).toBeEnabled());
  expect(screen.queryByLabelText("Target revision")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByLabelText("Expected original fingerprint")).toHaveValue(
    "",
  );
  expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
  fireEvent.click(pick());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "REVISION_CONFLICT",
  );
  expect(screen.queryByLabelText("Target revision")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Expected original fingerprint")).toHaveValue(
    "",
  );
});
it("aborts metadata on attachment change and ignores a late snapshot", async () => {
  let resolve!: (
    value: import("@serial-workbench/contracts").FileMetadata,
  ) => void;
  let pending: AbortSignal | undefined;
  const props = {
    labels: toolLabels,
    sessionRefs: [],
    watchActions: allowControlActions,
    pickFile: async () => selectedFile,
    readMetadata: vi.fn((_ref: unknown, signal?: AbortSignal) => {
      pending = signal;
      return new Promise<import("@serial-workbench/contracts").FileMetadata>(
        (done) => {
          resolve = done;
        },
      );
    }),
  };
  props.readMetadata.mockResolvedValueOnce({
    fileRef: selectedFile.reference,
    purpose: "capture_target",
    length: "123",
    fingerprint: "a".repeat(64),
  });
  const view = render(<CaptureTools {...props} contextKey="host:1" />);
  fireEvent.change(screen.getByLabelText("Write mode"), {
    target: { value: "replace" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Target revision")).toHaveTextContent("3"),
  );
  view.rerender(<CaptureTools {...props} contextKey="host:2" />);
  expect(screen.queryByLabelText("Target revision")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await waitFor(() => expect(props.readMetadata).toHaveBeenCalledTimes(2));
  view.rerender(<CaptureTools {...props} contextKey="host:3" />);
  expect(pending?.aborted).toBe(true);
  await act(async () =>
    resolve({
      fileRef: selectedFile.reference,
      purpose: "capture_target",
      length: "123",
      fingerprint: "b".repeat(64),
    }),
  );
  expect(screen.queryByText("payload.bin")).not.toBeInTheDocument();
  expect(screen.queryByText("b".repeat(64))).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Target revision")).not.toBeInTheDocument();
});

it("offers independent integer MiB storage limits from Host defaults", () => {
  render(
    <CaptureTools
      labels={{
        ...toolLabels,
        capacityMiB: "Capacity (MiB)",
        reserveMiB: "Disk reserve (MiB)",
        invalidLimits: "Enter valid limits",
      }}
      sessionRefs={[]}
      contextKey="host:1"
      watchActions={allowControlActions}
    />,
  );
  expect(screen.getByLabelText("Capacity (MiB)")).toHaveValue("1024");
  expect(screen.getByLabelText("Disk reserve (MiB)")).toHaveValue("128");
});

it("uses exact MiB bytes for both action checks and capture invocation and sends nothing for invalid limits", async () => {
  const observer = observeControlActions();
  const start = vi.fn().mockResolvedValue(operation());
  render(
    <CaptureTools
      contextKey="host:1"
      labels={{
        ...toolLabels,
        capacityMiB: "Capacity (MiB)",
        reserveMiB: "Disk reserve (MiB)",
        invalidLimits: "Enter valid limits",
      }}
      sessionRefs={[{ hostId: "host", kind: "session", id: "session" }]}
      pickFile={async () => selectedFile}
      watchActions={observer.watchActions}
      onStart={start}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture target" }),
  );
  await screen.findByText("payload.bin");
  fireEvent.change(screen.getByLabelText("Capacity (MiB)"), {
    target: { value: "9007199254741" },
  });
  fireEvent.change(screen.getByLabelText("Disk reserve (MiB)"), {
    target: { value: "0" },
  });
  const checked = observer.subscriptions.at(-1)!;
  act(() => observer.publish(checked, () => true));
  fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  const input = checked.inputs.find(
    (value) => value.actionId === "capture.start",
  )!;
  expect(start.mock.calls[0]?.[0]).toBe(input.params);
  expect(input.params).toMatchObject({
    storageLimits: {
      capacityBytes: (9007199254741n * 1048576n).toString(),
      reserveBytes: "0",
    },
  });
  for (const invalid of ["", "0", "1.5", "17592186044416", "-1"]) {
    fireEvent.change(screen.getByLabelText("Capacity (MiB)"), {
      target: { value: invalid },
    });
    expect(
      screen.getByRole("button", { name: "Start capture" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
  }
  expect(start).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Capacity (MiB)"), {
    target: { value: "1" },
  });
  for (const invalid of ["", "-1", "1.1", "17592186044416"]) {
    fireEvent.change(screen.getByLabelText("Disk reserve (MiB)"), {
      target: { value: invalid },
    });
    expect(
      screen.getByRole("button", { name: "Start capture" }),
    ).toBeDisabled();
  }
});

it("allows a new target selection while metadata is pending and ignores the old target snapshot", async () => {
  let finish!: (
    value: import("@serial-workbench/contracts").FileMetadata,
  ) => void;
  let pending: AbortSignal | undefined;
  const second = {
    ...selectedFile,
    name: "second-target",
    reference: { ...selectedFile.reference, id: "second", revision: "4" },
  };
  const pick = vi
    .fn()
    .mockResolvedValueOnce(selectedFile)
    .mockResolvedValueOnce(second);
  const readMetadata = vi
    .fn()
    .mockImplementationOnce((_ref: unknown, signal?: AbortSignal) => {
      pending = signal;
      return new Promise((done) => {
        finish = done;
      });
    })
    .mockResolvedValueOnce({
      fileRef: second.reference,
      purpose: "capture_target",
      length: "1",
      fingerprint: "b".repeat(64),
    });
  render(
    <CaptureTools
      contextKey="host:1"
      labels={toolLabels}
      sessionRefs={[]}
      pickFile={pick}
      readMetadata={readMetadata}
      watchActions={allowControlActions}
    />,
  );
  const select = () =>
    screen.getByRole("button", { name: "Select capture target" });
  fireEvent.change(screen.getByLabelText("Write mode"), {
    target: { value: "replace" },
  });
  fireEvent.click(select());
  await waitFor(() => expect(readMetadata).toHaveBeenCalledOnce());
  expect(screen.queryByLabelText("Target revision")).not.toBeInTheDocument();
  expect(select()).toBeEnabled();
  fireEvent.click(select());
  await screen.findByText("second-target");
  expect(pending?.aborted).toBe(true);
  await waitFor(() =>
    expect(screen.getByLabelText("Target revision")).toHaveTextContent("4"),
  );
  await act(async () =>
    finish({
      fileRef: selectedFile.reference,
      purpose: "capture_target",
      length: "1",
      fingerprint: "a".repeat(64),
    }),
  );
  expect(screen.getByLabelText("Expected original fingerprint")).toHaveValue(
    "b".repeat(64),
  );
  expect(screen.getByLabelText("Target revision")).toHaveTextContent("4");
});

it("keeps storage drafts independent between two capture forms", () => {
  render(
    <>
      <CaptureTools
        contextKey="one"
        labels={toolLabels}
        sessionRefs={[]}
        watchActions={allowControlActions}
      />
      <CaptureTools
        contextKey="two"
        labels={toolLabels}
        sessionRefs={[]}
        watchActions={allowControlActions}
      />
    </>,
  );
  const capacities = screen.getAllByLabelText("Capacity (MiB)");
  fireEvent.change(capacities[0]!, { target: { value: "4" } });
  expect(capacities[0]).toHaveValue("4");
  expect(capacities[1]).toHaveValue("1024");
  expect(screen.getAllByLabelText("Disk reserve (MiB)")[1]).toHaveValue("128");
});
