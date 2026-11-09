import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WorkspaceDocument,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import {
  WorkspaceEditor,
  type WorkspaceEditorLabels,
  type WorkspaceEditorProps,
} from "./workspace-editor";
import { session } from "./test-fixtures";
import {
  UnsavedWorkContext,
  type UnsavedWork,
} from "@/providers/unsaved-work-context";

afterEach(cleanup);
const labels: WorkspaceEditorLabels = {
  title: "Workspace configuration",
  workspaceName: "Workspace name",
  viewName: "View name",
  color: "Color",
  icon: "Icon",
  pinned: "Pinned",
  receiveMode: "Receive mode",
  sendMode: "Send mode",
  text: "Text",
  hex: "HEX",
  binding: "Device binding",
  configuration: "Connection configuration",
  baudRate: "Baud rate",
  dataBits: "Data bits",
  parity: "Parity",
  stopBits: "Stop bits",
  flowControl: "Flow control",
  readWaitMs: "Read wait (ms)",
  writeWaitMs: "Write wait (ms)",
  reconnectBackoffMs: "Reconnect backoff (ms)",
  sidebarWidth: "Sidebar width",
  panelHeight: "Panel height",
  save: "Save configuration",
  reload: "Reload saved configuration",
  discard: "Discard changes",
  clone: "Clone view",
  unavailable: "Unavailable",
  conflict: "Configuration changed. Reload to review the saved version.",
  saved: "Configuration saved",
  import: "Import JSON",
  export: "Export JSON",
  apply: "Apply import",
  cancelImport: "Cancel import",
  changes: "Import changes",
  noView: "Select a named view",
  importUnavailable: "Document preview is unavailable",
};
function base(): WorkspaceDocumentResult {
  return {
    scope: {
      scopeId: "scope",
      target: { hostId: "host", kind: "workspace", id: "bench" },
    },
    document: {
      revision: "7",
      value: {
        name: "Bench",
        layout: { sidebarWidth: 224, panelHeight: 192 },
        captures: [],
        favoriteBindingIds: ["binding"],
        bindings: [
          {
            bindingId: "binding",
            hostId: "host",
            deviceId: "device",
            fingerprint: { transport: "virtual", evidence: "unreliable" },
            configuration: session().configuration,
            reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
          },
        ],
        views: [
          {
            id: "view",
            name: "Motor",
            color: "#2266aa",
            icon: "terminal",
            pinned: false,
            receiveMode: "text",
            sendMode: "hex",
            bindingId: "binding",
          },
        ],
      },
    },
  };
}
it("saves edited view, connection and panel configuration with the original document revision", async () => {
  const original = base();
  const onSave = vi.fn(
    async (snapshot: WorkspaceDocumentResult, value: WorkspaceDocument) => ({
      ...snapshot,
      document: { revision: "8", value },
    }),
  );
  render(
    <WorkspaceEditor
      base={original}
      selectedViewId="view"
      labels={labels}
      onSave={onSave}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Motor 2" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Pinned" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Baud rate" }), {
    target: { value: "57600" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Panel height" }), {
    target: { value: "256" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await screen.findByRole("status");
  expect(onSave).toHaveBeenCalledWith(
    original,
    expect.objectContaining({
      layout: { sidebarWidth: 224, panelHeight: 256 },
      views: [expect.objectContaining({ name: "Motor 2", pinned: true })],
      bindings: [
        expect.objectContaining({
          configuration: expect.objectContaining({ baudRate: "57600" }),
        }),
      ],
    }),
    expect.any(AbortSignal),
  );
  expect(
    screen.getByRole("button", { name: "Save configuration" }),
  ).toBeDisabled();
});
it("keeps the draft and pending save when an equivalent scope uses another JSON field order", async () => {
  const original = base();
  let finish!: (value: WorkspaceDocumentResult) => void;
  const onSave = vi.fn<NonNullable<WorkspaceEditorProps["onSave"]>>(
    () =>
      new Promise<WorkspaceDocumentResult>((resolve) => {
        finish = resolve;
      }),
  );
  const content = (value: WorkspaceDocumentResult) => (
    <WorkspaceEditor base={value} labels={labels} onSave={onSave} />
  );
  const view = render(content(original));
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Unsent edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  const reordered = {
    ...original,
    scope: {
      target: { id: "bench", kind: "workspace", hostId: "host" },
      scopeId: original.scope.scopeId,
    },
  };
  view.rerender(content(reordered));
  expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
    "Unsent edit",
  );
  const signal = onSave.mock.calls[0]?.[2];
  expect(signal?.aborted).toBe(false);
  await act(async () =>
    finish({
      ...reordered,
      document: { revision: "8", value: onSave.mock.calls[0]![1] },
    }),
  );
  expect(
    screen.getByRole("button", { name: "Save configuration" }),
  ).toBeDisabled();
});

it("retains a conflicting draft until explicit reload and uses the reloaded revision", async () => {
  const original = base();
  const onSave = vi
    .fn()
    .mockRejectedValue({ code: "REVISION_CONFLICT", message: "Conflict" });
  const onReload = vi.fn().mockResolvedValue({
    ...original,
    document: { ...original.document, revision: "9" },
  });
  render(
    <WorkspaceEditor
      base={original}
      selectedViewId="view"
      labels={labels}
      onSave={onSave}
      onReload={onReload}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Unsent" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
    "Unsent",
  );
  expect(onReload).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved configuration" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
      "Motor",
    ),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Revised" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ revision: "9" }),
      }),
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
});
it("clones complete view configuration into new identities through the controlled draft", async () => {
  const original = base();
  let latest: WorkspaceDocument = original.document.value;
  function Controlled() {
    const [value, setValue] = useState(latest);
    const [selected, setSelected] = useState("view");
    return (
      <WorkspaceEditor
        base={original}
        value={value}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
        selectedViewId={selected}
        onSelectView={setSelected}
        labels={labels}
      />
    );
  }
  render(<Controlled />);
  fireEvent.click(screen.getByRole("button", { name: "Clone view" }));
  expect(latest.views).toHaveLength(2);
  expect(latest.views[1]).toEqual(
    expect.objectContaining({
      name: "Motor",
      receiveMode: "text",
      sendMode: "hex",
      color: "#2266aa",
      icon: "terminal",
    }),
  );
  expect(latest.views[1]!.id).not.toBe("view");
  expect(latest.views[1]!.bindingId).not.toBe("binding");
  expect(latest.bindings[1]!.configuration).toEqual(
    original.document.value.bindings[0]!.configuration,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Baud rate" }), {
    target: { value: "38400" },
  });
  expect(latest.bindings[0]!.configuration.baudRate).toBe(
    original.document.value.bindings[0]!.configuration.baudRate,
  );
});
it("aborts an outstanding save on unmount and ignores its late acknowledgment in StrictMode", async () => {
  let finish!: (value: WorkspaceDocumentResult) => void;
  let signal: AbortSignal | undefined;
  const onAcknowledged = vi.fn();
  const onSave = vi.fn(
    (
      _base: WorkspaceDocumentResult,
      _value: WorkspaceDocument,
      nextSignal?: AbortSignal,
    ) => {
      signal = nextSignal;
      return new Promise<WorkspaceDocumentResult>((resolve) => {
        finish = resolve;
      });
    },
  );
  const view = render(
    <StrictMode>
      <WorkspaceEditor
        base={base()}
        selectedViewId="view"
        labels={labels}
        onSave={onSave}
        onAcknowledged={onAcknowledged}
      />
    </StrictMode>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Changed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(base()));
  expect(onAcknowledged).not.toHaveBeenCalled();
});

it("releases a cancelled lifecycle save without losing the edited draft", async () => {
  let work: UnsavedWork | undefined;
  let finish!: (value: WorkspaceDocumentResult) => void;
  const original = base();
  const onSave = vi.fn(
    () =>
      new Promise<WorkspaceDocumentResult>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <UnsavedWorkContext.Provider
      value={{
        requestLeave: async () => true,
        releaseScope: () => {},
        register: (next) => {
          work = next;
        },
        unregister: () => {},
      }}
    >
      <WorkspaceEditor
        base={original}
        selectedViewId="view"
        labels={labels}
        onSave={onSave}
      />
    </UnsavedWorkContext.Provider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Still editing" },
  });
  expect(work?.dirty).toBe(true);
  const controller = new AbortController();
  let saving!: Promise<void>;
  act(() => {
    saving = work!.save!(controller.signal);
  });
  controller.abort();
  await act(async () => {
    finish(original);
    await expect(saving).rejects.toThrow();
  });
  expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
    "Still editing",
  );
  expect(screen.getByRole("textbox", { name: "View name" })).toBeEnabled();
});

it("shows document import and export as unavailable when real document file callbacks are absent", () => {
  render(
    <WorkspaceEditor base={base()} selectedViewId="view" labels={labels} />,
  );
  expect(screen.getByRole("button", { name: "Import JSON" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  expect(
    screen.getByText("Document preview is unavailable"),
  ).toBeInTheDocument();
});

it("exports the saved workspace only after an explicit click through the controlled file callback", async () => {
  const original = base();
  const onExport = vi.fn().mockResolvedValue(undefined);
  render(
    <WorkspaceEditor
      base={original}
      selectedViewId="view"
      labels={labels}
      onExport={onExport}
    />,
  );
  expect(onExport).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: "Draft stays local" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() =>
    expect(onExport).toHaveBeenCalledWith(original, expect.any(AbortSignal)),
  );
  expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
    "Draft stays local",
  );
});

it("previews Host-validated JSON against the edited draft and only saves on explicit apply", async () => {
  const original = base();
  const candidate = { ...original.document.value, name: "Imported", views: [] };
  const onPreviewImport = vi.fn().mockResolvedValue(candidate);
  const onSave = vi.fn(
    async (snapshot: WorkspaceDocumentResult, value: WorkspaceDocument) => ({
      ...snapshot,
      document: { revision: "8", value: { ...value, name: "Host receipt" } },
    }),
  );
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onSave={onSave}
      onPreviewImport={onPreviewImport}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "Current draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "raw envelope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByRole("region", { name: "Import changes" });
  expect(onPreviewImport).toHaveBeenCalledWith(
    "raw envelope",
    expect.any(AbortSignal),
  );
  expect(screen.getByText('"Current draft"')).toBeInTheDocument();
  expect(screen.getByText('"Imported"')).toBeInTheDocument();
  expect(screen.getByText("Removed")).toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Current draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
  await screen.findByRole("status");
  expect(onSave).toHaveBeenCalledWith(
    original,
    candidate,
    expect.any(AbortSignal),
  );
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Host receipt",
  );
});

it("cancels a validated candidate without saving or changing the local draft", async () => {
  const original = base();
  const onSave = vi.fn();
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onSave={onSave}
      onPreviewImport={async () => ({
        ...original.document.value,
        name: "Imported",
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "{}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByRole("region", { name: "Import changes" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
  expect(
    screen.queryByRole("region", { name: "Import changes" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Bench",
  );
  expect(onSave).not.toHaveBeenCalled();
});

it("preserves JSON, validated candidate and draft on CAS conflict and reviews against an explicit reload", async () => {
  const original = base();
  const candidate = { ...original.document.value, name: "Imported" };
  const onSave = vi
    .fn()
    .mockRejectedValueOnce({ code: "REVISION_CONFLICT", message: "Conflict" })
    .mockImplementationOnce(
      async (snapshot: WorkspaceDocumentResult, value: WorkspaceDocument) => ({
        ...snapshot,
        document: { revision: "10", value },
      }),
    );
  const onReload = vi.fn().mockResolvedValue({
    ...original,
    document: {
      revision: "9",
      value: { ...original.document.value, name: "New saved version" },
    },
  });
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onSave={onSave}
      onReload={onReload}
      onPreviewImport={async () => candidate}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "original imported envelope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByRole("region", { name: "Import changes" });
  fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(labels.conflict);
  expect(screen.getByRole("textbox", { name: "Workspace JSON" })).toHaveValue(
    "original imported envelope",
  );
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "My draft",
  );
  expect(screen.getByText('"Imported"')).toBeInTheDocument();
  expect(onReload).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved configuration" }),
  );
  await screen.findByText('"New saved version"');
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Workspace JSON" })).toHaveValue(
    "original imported envelope",
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
  await screen.findByRole("status");
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({
      document: expect.objectContaining({ revision: "9" }),
    }),
    candidate,
    expect.any(AbortSignal),
  );
});

it("ignores a late preview after newer JSON and allows a new preview without waiting for the old Host call", async () => {
  const original = base();
  let finish!: (value: WorkspaceDocument) => void;
  let signal: AbortSignal | undefined;
  const onPreviewImport = vi
    .fn()
    .mockImplementationOnce((_json: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<WorkspaceDocument>((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValueOnce({ ...original.document.value, name: "Newest" });
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onPreviewImport={onPreviewImport}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "old" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "new" },
  });
  expect(signal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByText('"Newest"');
  await act(async () => finish({ ...original.document.value, name: "Stale" }));
  expect(screen.queryByText('"Stale"')).not.toBeInTheDocument();
  expect(screen.getByText('"Newest"')).toBeInTheDocument();
});

it("reads a JSON file as text and requires the same explicit Host preview and apply", async () => {
  const original = base();
  const onPreviewImport = vi
    .fn()
    .mockResolvedValue({ ...original.document.value, name: "From file" });
  const onSave = vi.fn();
  const file = new File(["file envelope"], "workspace.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", { value: async () => "file envelope" });
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onSave={onSave}
      onPreviewImport={onPreviewImport}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByLabelText("Workspace JSON file"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Workspace JSON" })).toHaveValue(
      "file envelope",
    ),
  );
  expect(onPreviewImport).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByText('"From file"');
  expect(onPreviewImport).toHaveBeenCalledWith(
    "file envelope",
    expect.any(AbortSignal),
  );
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps rejected future-format input and the current draft without offering apply", async () => {
  const original = base();
  const onSave = vi.fn();
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onSave={onSave}
      onPreviewImport={async () => {
        throw {
          code: "UNSUPPORTED_FORMAT",
          message: "Future workspace format",
        };
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "future envelope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Future workspace format",
  );
  expect(screen.getByRole("textbox", { name: "Workspace JSON" })).toHaveValue(
    "future envelope",
  );
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Bench",
  );
  expect(
    screen.queryByRole("button", { name: "Apply import" }),
  ).not.toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
});

it("aborts an import preview when the workspace target changes and ignores late results", async () => {
  const original = base();
  let finish!: (value: WorkspaceDocument) => void;
  let signal: AbortSignal | undefined;
  const onPreviewImport = (_json: string, nextSignal?: AbortSignal) => {
    signal = nextSignal;
    return new Promise<WorkspaceDocument>((resolve) => {
      finish = resolve;
    });
  };
  const view = render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onPreviewImport={onPreviewImport}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "old target" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  view.rerender(
    <WorkspaceEditor
      base={{
        ...original,
        scope: { ...original.scope, scopeId: "other-scope" },
        document: {
          revision: "1",
          value: { ...original.document.value, name: "Other target" },
        },
      }}
      labels={labels}
      onPreviewImport={onPreviewImport}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    finish({ ...original.document.value, name: "Stale import" }),
  );
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Other target",
  );
  expect(
    screen.queryByRole("region", { name: "Import changes" }),
  ).not.toBeInTheDocument();
});

it("keeps edits made during import apply while acknowledging the actual saved document", async () => {
  const original = base();
  let finish!: (result: WorkspaceDocumentResult) => void;
  const onAcknowledged = vi.fn();
  const candidate = { ...original.document.value, name: "Imported" };
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onPreviewImport={async () => candidate}
      onAcknowledged={onAcknowledged}
      onSave={() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "envelope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByRole("region", { name: "Import changes" });
  fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "New edit" },
  });
  const receipt = {
    ...original,
    document: { revision: "8", value: candidate },
  };
  await act(async () => finish(receipt));
  expect(onAcknowledged).toHaveBeenCalledWith(receipt);
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "New edit",
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save configuration" }),
  ).toBeEnabled();
});

it("does not overwrite edits made while an explicit reload is waiting", async () => {
  const original = base();
  let finish!: (value: WorkspaceDocumentResult) => void;
  const onAcknowledged = vi.fn();
  render(
    <WorkspaceEditor
      base={original}
      labels={labels}
      onAcknowledged={onAcknowledged}
      onReload={() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      }
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved configuration" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "New edit" },
  });
  await act(async () =>
    finish({
      ...original,
      document: {
        revision: "9",
        value: { ...original.document.value, name: "Loaded" },
      },
    }),
  );
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "New edit",
  );
  expect(onAcknowledged).not.toHaveBeenCalled();
});

it("keeps lifecycle navigation pending when new edits arrive during its save", async () => {
  let work: UnsavedWork | undefined;
  let finish!: (value: WorkspaceDocumentResult) => void;
  const original = base();
  render(
    <UnsavedWorkContext.Provider
      value={{
        requestLeave: async () => true,
        releaseScope: () => {},
        register: (next) => {
          work = next;
        },
        unregister: () => {},
      }}
    >
      <WorkspaceEditor
        base={original}
        labels={labels}
        onSave={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
      />
    </UnsavedWorkContext.Provider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "Submitted" },
  });
  let saving!: Promise<void>;
  act(() => {
    saving = work!.save!(new AbortController().signal);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "Still unsaved" },
  });
  await act(async () => {
    finish({
      ...original,
      document: {
        revision: "8",
        value: { ...original.document.value, name: "Submitted" },
      },
    });
    await expect(saving).rejects.toThrow("New changes need saving");
  });
  expect(work?.dirty).toBe(true);
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Still unsaved",
  );
});

it("does not replace newer pasted JSON when an older file read completes", async () => {
  let finish!: (value: string) => void;
  const file = new File([], "workspace.json");
  Object.defineProperty(file, "text", {
    value: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  render(
    <WorkspaceEditor
      base={base()}
      labels={labels}
      onPreviewImport={async () => base().document.value}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  fireEvent.change(screen.getByLabelText("Workspace JSON file"), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace JSON" }), {
    target: { value: "new pasted envelope" },
  });
  await act(async () => finish("old file envelope"));
  expect(screen.getByRole("textbox", { name: "Workspace JSON" })).toHaveValue(
    "new pasted envelope",
  );
});
