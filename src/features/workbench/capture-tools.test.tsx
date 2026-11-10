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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import userEvent from "@testing-library/user-event";
import { defaults } from "@serial-workbench/contracts";
import { CaptureTools } from "./capture-tools";
import { operation } from "./test-fixtures";
import {
  selectedFile,
  toolLabels,
  verification,
} from "./transfer-capture-test-helpers";
afterEach(cleanup);
beforeEach(() => {
  clearUserLog();
  render(<Toaster />);
});
async function selectOption(label: string, name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name }));
}
it("uses the shared popup for recording mode and replay timing without starting a task", async () => {
  const start = vi.fn();
  const replay = vi.fn();
  render(
    <CaptureTools
      contextKey="dropdown-host"
      watchActions={allowControlActions}
      labels={toolLabels}
      sessionRefs={[]}
      onStart={start}
      onReplay={replay}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Write mode" }));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: toolLabels.append }));
  expect(
    screen.getByRole("combobox", { name: "Write mode" }),
  ).toHaveTextContent(toolLabels.append);
  await user.click(screen.getByRole("tab", { name: "Playback" }));
  await user.click(screen.getByRole("combobox", { name: "Replay timing" }));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: toolLabels.fastest }));
  expect(
    screen.getByRole("combobox", { name: "Replay timing" }),
  ).toHaveTextContent(toolLabels.fastest);
  expect(start).not.toHaveBeenCalled();
  expect(replay).not.toHaveBeenCalled();
});
it.each([
  ["1234567", "1,234,567 records"],
  ["18446744073709551615", "18,446,744,073,709,551,615 records"],
])(
  "preserves the exact verified record prefix %s in recovery preview instead of converting it to bytes",
  async (prefix, expected) => {
    const verify = vi.fn().mockResolvedValue({
      ...operation("verify-record-prefix"),
      actionId: "capture.verify",
      result: {
        kind: "capture_verification",
        value: {
          ...verification,
          verifiedPrefix: prefix,
          volumeResults: verification.volumeResults.map((volume) => ({
            ...volume,
            verifiedPrefix: prefix,
          })),
        },
      },
    });
    render(
      <CaptureTools
        watchActions={allowControlActions}
        contextKey="host:record-prefix"
        labels={toolLabels}
        sessionRefs={[]}
        pickFile={async () => selectedFile}
        onVerify={verify}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Playback" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select capture source" }),
    );
    await screen.findByText("payload.bin");
    const verifyButton = screen.getByRole("button", { name: "Verify capture" });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    fireEvent.click(verifyButton);
    expect(await screen.findByText(expected)).toHaveAttribute("title", prefix);
    expect(screen.queryByText("1.23 MB")).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "View details" }));
    const details = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "View details",
    });
    const value: unknown = JSON.parse(details.value);
    expect(value).toMatchObject({ verifiedPrefix: prefix });
  },
);
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
  await selectOption("Write mode", toolLabels.replace);
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
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
  await screen.findByLabelText("Container complete");
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
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
  await selectOption("Replay timing", toolLabels.fastest);
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
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
  await screen.findByText("Running");
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
  expect(screen.getByRole("alert")).toHaveTextContent(
    toolLabels.operationText.failure("TARGET_EXISTS"),
  );
  expect(getUserLog().some((entry) => entry.code === "TARGET_EXISTS")).toBe(
    true,
  );
  expect(screen.getByLabelText("Source continuous")).toHaveTextContent("No");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "View details" }));
  expect(screen.getByRole("textbox", { name: "View details" })).toHaveProperty(
    "value",
    expect.stringContaining('"status": "corrupt"'),
  );
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
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
  expect(screen.queryByLabelText("Container complete")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
  expect(
    screen.getByRole("button", { name: "Save verified prefix as" }),
  ).toBeDisabled();
});

it("keeps source rights independent and invalidates replay timing and source reference grants", async () => {
  const observer = observeControlActions();
  const verify = vi.fn(),
    replay = vi.fn();
  const sourceSubscription = async (
    reference: typeof selectedFile.reference,
    mode: "original_timing" | "fastest",
  ) =>
    waitFor(() => {
      const subscription = observer.subscriptions
        .slice()
        .reverse()
        .find((value) => !value.stopped);
      expect(subscription?.inputs).toEqual([
        {
          actionId: "capture.verify",
          target: {
            hostId: reference.hostId,
            kind: reference.kind,
            id: reference.id,
          },
          params: { captureRef: reference },
        },
        {
          actionId: "replay.open",
          target: {
            hostId: reference.hostId,
            kind: reference.kind,
            id: reference.id,
          },
          params: { captureRef: reference, mode },
        },
      ]);
      if (!subscription)
        throw new Error("Capture source action subscription is not registered");
      return subscription;
    });
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
  expect(
    screen.getByRole("button", { name: "Select capture source" }),
  ).toBeEnabled();
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
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
  const first = await sourceSubscription(
    selectedFile.reference,
    "original_timing",
  );
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
  await selectOption("Replay timing", toolLabels.fastest);
  expect(replayButton()).toBeDisabled();
  const timing = await sourceSubscription(selectedFile.reference, "fastest");
  act(() => observer.publish(first, () => true));
  expect(replayButton()).toBeDisabled();
  expect(timing.inputs).toContainEqual({
    actionId: "replay.open",
    target: { hostId: "host", kind: "file", id: "source" },
    params: { captureRef: selectedFile.reference, mode: "fastest" },
  });
  act(() => observer.publish(timing, () => true));
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("second.capture");
  expect(replayButton()).toBeDisabled();
  await sourceSubscription(second.reference, "fastest");
  act(() => observer.publish(timing, () => true));
  expect(replayButton()).toBeDisabled();
  fireEvent.click(replayButton());
  expect(replay).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
});
it("observes a complete recovery token and selected destination without starting work, then clears grants for a replacement token", async () => {
  const observer = observeControlActions();
  const actionSubscription = (expected: {
    actionId: string;
    target: { hostId: string; kind: string; id: string };
    params: unknown;
  }) =>
    waitFor(() => {
      // 文件名已渲染不代表权限 effect 已建立；等待当前输入的订阅。
      const subscription = observer.subscriptions
        .slice()
        .reverse()
        .find((value) => !value.stopped);
      expect(subscription?.inputs).toContainEqual(expected);
      if (!subscription)
        throw new Error("Capture action subscription is not registered");
      return subscription;
    });
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Playback" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture source" }),
  );
  await screen.findByText("payload.bin");
  const source = await actionSubscription({
    actionId: "capture.verify",
    target: { hostId: "host", kind: "file", id: "source" },
    params: { captureRef: selectedFile.reference },
  });
  act(() =>
    observer.publish(source, (input) => input.actionId === "capture.verify"),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify capture" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify capture" }));
  await screen.findByLabelText("Container complete");
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
  const first = await actionSubscription({
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
  await selectOption("Write mode", toolLabels.append);
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
    .mockRejectedValueOnce(
      Object.assign(new Error("Private metadata failure"), {
        code: "REVISION_CONFLICT",
      }),
    );
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
  await selectOption("Write mode", toolLabels.replace);
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
    toolLabels.operationText.failure("REVISION_CONFLICT"),
  );
  expect(getUserLog().some((entry) => entry.code === "REVISION_CONFLICT")).toBe(
    true,
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
  await selectOption("Write mode", toolLabels.replace);
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

it("offers independent integer MiB storage limits from Host defaults in Advanced", async () => {
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
  expect(screen.queryByLabelText("Capacity (MiB)")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
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
  await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }));
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
  await selectOption("Write mode", toolLabels.replace);
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

it("keeps storage drafts independent between two capture forms", async () => {
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
  for (const tab of screen.getAllByRole("tab", { name: "Advanced" }))
    await userEvent.setup().click(tab);
  const capacities = screen.getAllByLabelText("Capacity (MiB)");
  fireEvent.change(capacities[0]!, { target: { value: "4" } });
  expect(capacities[0]).toHaveValue("4");
  expect(capacities[1]).toHaveValue("1024");
  expect(screen.getAllByLabelText("Disk reserve (MiB)")[1]).toHaveValue("128");
});
