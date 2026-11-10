import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type {
  OperationSummary,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { createTranslator } from "../../i18n/translate";
import { en } from "../../i18n/en";
import { WorkspaceEditor } from "./workspace-editor";
import { DeviceLibrary } from "./device-library";
import { OperationFailureNotices } from "./operation-failure-notices";
import { workbenchToolLabels } from "./tool-labels";
import { labels, operation } from "./test-fixtures";
import {
  device,
  deviceLabels,
  favoriteSaved,
  workspace,
} from "./device-library.test-fixtures";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});
const editorLabels = workbenchToolLabels(createTranslator(en)).workspace;

it("shares a verified workspace-save failure with the permanent observer while later RPC and export errors remain independent", async () => {
  const running = {
    ...operation("workspace-editor-save"),
    actionId: "workspace.save",
    state: "running" as const,
  };
  const terminal = {
    ...running,
    state: "failed" as const,
    errorCode: "PERMISSION_DENIED",
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      executionHostId: running.executionHostId,
      operationId: running.operationId,
      message: "private workspace path",
    })
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" })
    .mockResolvedValueOnce({
      ...workspace(),
      document: {
        revision: "8",
        value: { ...workspace().document.value, name: "Changed" },
      },
    });
  const exportConfiguration = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    executionHostId: running.executionHostId,
    operationId: running.operationId,
  });
  const content = (operations: readonly OperationSummary[]) => (
    <StrictMode>
      <OperationFailureNotices
        ready
        scopeKey="document-editor-host"
        operations={operations}
        text={labels.operationText}
      />
      <WorkspaceEditor
        base={workspace()}
        labels={editorLabels}
        onSave={save}
        onExport={exportConfiguration}
      />
    </StrictMode>
  );
  const view = render(content([running]));
  fireEvent.change(
    screen.getByRole("textbox", { name: editorLabels.workspaceName }),
    { target: { value: "Changed" } },
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: editorLabels.save })),
  );
  view.rerender(content([terminal]));
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toHaveLength(1);
  expect(getUserLog()[0]?.count).toBe(1);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: editorLabels.save })),
  );
  expect(toast.custom).toHaveBeenCalledTimes(2);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: editorLabels.save })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: editorLabels.export })),
  );
  expect(toast.custom).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private workspace path|workspace-editor-save/,
  );
});

it("shares a verified favorite-save failure with the permanent observer without suppressing a later ordinary request failure", async () => {
  const running = {
    ...operation("device-favorite-save"),
    actionId: "favorites.save",
    state: "running" as const,
  };
  const terminal = {
    ...running,
    state: "failed" as const,
    errorCode: "PERMISSION_DENIED",
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      executionHostId: running.executionHostId,
      operationId: running.operationId,
      message: "private device input",
    })
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" })
    .mockResolvedValueOnce(favoriteSaved());
  const content = (operations: readonly OperationSummary[]) => (
    <StrictMode>
      <OperationFailureNotices
        ready
        scopeKey="document-library-host"
        operations={operations}
        text={labels.operationText}
      />
      <DeviceLibrary
        workspace={workspace()}
        devices={[device()]}
        labels={deviceLabels}
        onSaveFavorites={save}
      />
    </StrictMode>
  );
  const view = render(content([running]));
  fireEvent.keyDown(screen.getByRole("tab", { name: deviceLabels.favorites }), {
    key: "Enter",
  });
  const remove = () =>
    screen.getByRole("button", { name: "Remove favorite Binding 1" });
  await act(async () => fireEvent.click(remove()));
  view.rerender(content([terminal]));
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toHaveLength(1);
  expect(getUserLog()[0]?.count).toBe(1);
  await act(async () => fireEvent.click(remove()));
  expect(toast.custom).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.click(remove()));
  expect(
    screen.getByRole("button", { name: "Add favorite Binding 1" }),
  ).toBeEnabled();
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private device input|device-favorite-save/,
  );
});

it("keeps an observer-first device rebind failure in the workspace module when the local waiter settles later", async () => {
  const running = {
    ...operation("observer-first-device-rebind"),
    actionId: "device.rebind",
    target: workspace().scope.target,
    state: "running" as const,
  };
  const terminal = {
    ...running,
    state: "failed" as const,
    errorCode: "PERMISSION_DENIED",
  };
  let rejectSave!: (reason: unknown) => void;
  const rebind = vi.fn(
    () =>
      new Promise<WorkspaceDocumentResult>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const content = (operations: readonly OperationSummary[]) => (
    <StrictMode>
      <OperationFailureNotices
        ready
        scopeKey="observer-first-rebind-host"
        operations={operations}
        text={labels.operationText}
      />
      <DeviceLibrary
        workspace={workspace()}
        devices={[device()]}
        labels={deviceLabels}
        onRebindDevice={rebind}
      />
    </StrictMode>
  );
  const view = render(content([running]));
  fireEvent.keyDown(screen.getByRole("tab", { name: deviceLabels.favorites }), {
    key: "Enter",
  });
  const select = screen.getByRole("combobox", {
    name: "Choose a device explicitly Binding 1",
  });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const option = screen.getByRole("option", { name: "COM9 · serial-42" });
  option.focus();
  fireEvent.keyDown(option, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
  expect(rebind).toHaveBeenCalledWith(
    expect.objectContaining({
      document: expect.objectContaining({ revision: "7" }),
    }),
    { bindingId: "probe", deviceId: "device-a" },
    expect.any(AbortSignal),
  );
  view.rerender(content([terminal]));
  expect(getUserLog()).toEqual([
    expect.objectContaining({
      module: "workspace",
      code: "PERMISSION_DENIED",
      count: 1,
    }),
  ]);
  await act(async () =>
    rejectSave({
      code: "PERMISSION_DENIED",
      executionHostId: terminal.executionHostId,
      operationId: terminal.operationId,
      message: "private rebind input",
    }),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()[0]?.count).toBe(1);
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private rebind input|observer-first-device-rebind/,
  );
});
