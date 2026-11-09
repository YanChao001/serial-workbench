import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import { I18nContext } from "@/providers/i18n-context";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { HostRequestError } from "@serial-workbench/host-client";
import {
  createClientDraftStore,
  type ClientDraftPort,
} from "@/features/workbench/client-drafts";
import { snapshotWindowLayout } from "@/features/workbench/window-layout-template";
import { HostProvider } from "@/providers/host";
import { HostContext, type HostContextValue } from "@/providers/host-context";
import Overview from "./overview";
import { WorkbenchTools } from "@/features/workbench/workbench-tools";
import {
  session,
  operation,
  actionCatalog,
} from "@/features/workbench/test-fixtures";
import {
  browserClientStateStore,
  DEFAULT_CLIENT_STATE,
  type ClientStateSnapshot,
} from "@/lib/client-settings";
import {
  createHostConnection,
  createHostWorkspace,
  type HostNativePort,
} from "@/lib/host-client";
import { saveTextExport } from "@/lib/tauri";
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  saveTextExport: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());
const i18n = { language: "en" as const, t: createTranslator(en) };
const chinese = { language: "zh" as const, t: createTranslator(zhCN) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function localSnapshot(drafts: Record<string, string>): ClientStateSnapshot {
  return {
    formatVersion: "0.1",
    revision: "4",
    state: { ...structuredClone(DEFAULT_CLIENT_STATE), drafts },
  };
}
const startupError = () =>
  new HostRequestError({
    code: "HOST_START_FAILED",
    message:
      "cargo run --manifest-path D:/private/user/project/Cargo.toml token=private-token failed",
    retryable: true,
  });
function readyHost(): HostContextValue {
  const currentSession = session();
  return {
    state: {
      status: "ready",
      error: null,
      devices: [
        {
          deviceId: "device",
          hostId: "host",
          systemName: "Virtual serial",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          capabilities: currentSession.capabilities,
        },
      ],
      sessions: [currentSession],
      operations: [],
      operationSummaries: [],
      streams: new Map(),
      catalog: actionCatalog,
      devicesStale: false,
    },
    refresh: vi.fn(),
    operationInput: vi.fn(),
    pickFile: vi.fn(),
    trustedConnect: vi.fn(),
    metrics: vi.fn().mockRejectedValue(new Error("METRICS_UNAVAILABLE")),
    captureStatus: vi.fn(),
    readCaptureTail: vi.fn(),
    readFileReceipts: vi.fn(),
    readReplay: vi.fn(),
    readFile: vi.fn(),
    fileMetadata: vi.fn(),
    sessionMetrics: vi.fn(),
    sessionInputs: vi.fn(),
    readReplayRecord: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
    takeover: vi.fn(),
    invoke: vi.fn(),
    loadWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
    saveFavorites: vi.fn(),
    rebindDevice: vi.fn(),
    recentConnections: vi.fn(),
    exportWorkspace: vi.fn(),
    previewWorkspaceImport: vi.fn(),
    waitForOperation: vi.fn(),
    checkAction: vi.fn(
      async (
        input: import("@/providers/host-context").HostActionCheckInput,
      ) => ({ actionId: input.actionId, target: input.target, allowed: true }),
    ),
    watchActions: vi.fn((inputs, listener) => {
      listener(
        inputs.map(
          (input: import("@/providers/host-context").HostActionCheckInput) => ({
            input,
            result: {
              actionId: input.actionId,
              target: input.target,
              allowed: true,
            },
            error: null,
          }),
        ),
      );
      return () => {};
    }),
    watchSession: vi.fn(() => () => {}),
  };
}
async function attachment(generation: string) {
  return createHostConnection({
    attachment: vi.fn().mockResolvedValue({
      generation,
      attachment: {
        hostId: "host",
        instanceEpoch: generation,
        protocolVersion: "0.1",
        catalogVersion: "1",
        actorId: "actor",
        clientId: "client",
        requestContext: "signed-context",
        requestContextAcceptUntil: "2026-11-08T00:00:00Z",
        limits: {
          maxRequestBytes: "100000",
          maxPageItems: "100",
          maxBatchBytes: "100000",
          maxReaderQueueBytes: "100000",
          resultRetentionMs: "1000",
          maxLeaseTtlMs: "1000",
        },
      },
    }),
    request: vi.fn<HostNativePort["request"]>(async () => ({
      ok: true,
      result: { kind: "scopes", value: { scopes: [] } },
    })),
    subscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    rawRequest: vi.fn(),
    rawSubscribe: vi.fn(),
    rawUnsubscribe: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
  });
}
function workspace(
  id: string,
  name: string,
  revision = "1",
): import("@serial-workbench/contracts").WorkspaceDocumentResult {
  return {
    scope: {
      scopeId: `workspace/${id}`,
      target: { hostId: "host", kind: "workspace", id },
    },
    document: { revision, value: { ...defaults.workspace, name } },
  };
}
describe("Serial Workbench 首页", () => {
  it("edits and clones a document view from the workspace menu, CAS saves and reopens independent drafts on one session", async () => {
    const ready = readyHost();
    let saved = workspace("chosen", "Bench");
    saved.document.value = snapshotWindowLayout(
      saved.document.value,
      [{ id: "saved-view", sessionId: "session" }],
      ready.state.sessions,
      ready.state.devices,
      defaults.settings.terminal,
      {},
    );
    const connection = await attachment("9");
    vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
      if (query.actionId === "workspace.read")
        return { kind: "workspace", value: saved };
      throw new Error(query.actionId);
    });
    vi.spyOn(connection, "refreshScopes").mockResolvedValue([]);
    const applyDocumentIntent =
      vi.fn<typeof import("@/lib/tauri").hostApplyDocumentIntent>();
    applyDocumentIntent.mockImplementation(async (_generation, intent) => {
      if (
        intent.kind !== "workspaceSave" ||
        intent.workspaceId !== "chosen" ||
        intent.expectedRevision !== saved.document.revision
      )
        throw new Error("CAS mismatch");
      saved = {
        ...saved,
        document: { revision: "2", value: intent.params.value },
      };
      return {
        ...operation(),
        actionId: "workspace.save",
        target: saved.scope.target,
        result: { kind: "workspace", value: saved },
      };
    });
    const controller = createHostWorkspace(connection, {
      connectDevice: vi.fn(),
      chooseFile: vi.fn(),
      applyDocumentIntent,
    });
    await controller.loadWorkspace("chosen");
    const host = {
      ...ready,
      ...controller.getSnapshot(),
      state: { ...ready.state, workspace: saved },
    };
    const content = () => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content());
    fireEvent.click(await screen.findByRole("button", { name: "Bench" }));
    expect(screen.getByRole("combobox", { name: "Views" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Original view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Clone view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(saved.document.revision).toBe("2"));
    expect(applyDocumentIntent).toHaveBeenCalledWith(
      "9",
      expect.objectContaining({ expectedRevision: "1", workspaceId: "chosen" }),
    );
    expect(saved.document.value.views.map((value) => value.name)).toEqual([
      "Original view",
      "Clone view",
    ]);
    expect(saved.document.value.bindings).toHaveLength(2);
    expect(saved.document.value.bindings[1]?.deviceId).toBe("device");
    view.unmount();
    host.state.workspace = saved;
    render(content());
    fireEvent.click(await screen.findByRole("tab", { name: "Original view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "ORIGINAL" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Clone view" }));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "CLONE" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Original view" }));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "ORIGINAL",
    );
    expect(ready.open).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["saved.json", null])(
    "exports the Host JSON envelope through the file facade (result %s)",
    async (path) => {
      const host = readyHost();
      host.state.workspace = workspace("export", "Export bench");
      const json =
        '{"formatVersion":"0.1","kind":"workspace","value":{"name":"original envelope"}}';
      host.exportWorkspace = vi.fn().mockResolvedValue({ json });
      vi.mocked(saveTextExport).mockReset().mockResolvedValue(path);
      render(
        <I18nContext value={i18n}>
          <HostContext value={host}>
            <Overview />
          </HostContext>
        </I18nContext>,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Export bench" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
      await waitFor(() =>
        expect(saveTextExport).toHaveBeenCalledWith(
          "workspace-export.json",
          json,
        ),
      );
      if (path)
        expect(
          await screen.findByRole("textbox", {
            name: "Exported workspace JSON",
          }),
        ).toHaveValue(json);
      else
        expect(
          screen.queryByRole("textbox", { name: "Exported workspace JSON" }),
        ).not.toBeInTheDocument();
    },
  );
  it("keeps current editing and disables Host actions when menu Refresh loses an established attachment", async () => {
    const connection = await attachment("8");
    const current = session();
    const scope = {
      scopeId: "session/current",
      target: {
        hostId: "host",
        kind: "session",
        id: current.sessionId,
        sessionId: current.sessionId,
        sessionEpoch: current.sessionEpoch,
      },
    };
    vi.spyOn(connection, "refreshScopes").mockResolvedValue([scope]);
    let projection: Parameters<
      typeof connection.client.subscribe
    >[1] = () => {};
    vi.spyOn(connection.client, "subscribe").mockImplementation(
      async (_scope, listener) => {
        projection = listener;
        listener({
          type: "snapshot",
          snapshot: {
            hostId: "host",
            instanceEpoch: "8",
            revision: "1",
            cursor: {
              hostId: "host",
              instanceEpoch: "8",
              scopeId: scope.scopeId,
              position: "0",
            },
            state: JSON.parse(JSON.stringify(current)),
          },
        });
        return () => {};
      },
    );
    vi.spyOn(connection.transport, "rawRequest").mockReturnValue(
      new Promise(() => {}),
    );
    let failRefresh = false;
    vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
      switch (query.actionId) {
        case "catalog.list":
          if (failRefresh) throw startupError();
          return {
            kind: "catalog",
            value: { catalogVersion: "1", items: actionCatalog },
          };
        case "device.list":
          return {
            kind: "devices",
            value: { devices: readyHost().state.devices, stale: false },
          };
        case "workspace.read":
          return { kind: "workspace", value: workspace("default", "Bench") };
        case "action.check":
          return {
            kind: "action_check",
            value: {
              actionId: String(query.params.actionId),
              target: query.target,
              allowed: true,
            },
          };
        default:
          throw new Error(`Unexpected test query ${query.actionId}`);
      }
    });
    const connect = vi.fn(async () => connection);
    const port = {
      read: vi.fn().mockResolvedValue(localSnapshot({})),
      save: vi.fn().mockResolvedValue(localSnapshot({})),
    };
    const view = render(
      <I18nContext value={i18n}>
        <HostProvider desktop connect={connect}>
          <Overview draftStore={createClientDraftStore(port)} />
        </HostProvider>
      </I18nContext>,
    );
    const open = await screen.findByRole("button", {
      name: "Open Virtual serial",
    });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const tabId = screen.getByRole("tab", { selected: true }).id;
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "CURRENT EDIT" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
    );
    failRefresh = true;
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workspace menu" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    await screen.findByText(
      "The local service could not connect. Please retry.",
    );
    act(() =>
      projection({ type: "error", error: new Error("late old projection") }),
    );
    expect(
      screen.getByText("The local service could not connect. Please retry."),
    ).toBeVisible();
    expect(
      screen.queryByText(/cargo run|private-token|D:\/private/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute(
      "id",
      tabId,
    );
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "CURRENT EDIT",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New view" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: { "session-session": "CURRENT EDIT" },
        }),
        "4",
      ),
    );
    expect(connect).toHaveBeenCalledOnce();
    view.unmount();
  });
  it("shows safe localized errors for ordinary menu Refresh failures without pretending the Host disconnected", async () => {
    const host = readyHost();
    host.refresh = vi.fn().mockRejectedValue(
      new HostRequestError({
        code: "PERMISSION_DENIED",
        message:
          "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
        retryable: false,
      }),
    );
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "CURRENT EDIT" },
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workspace menu" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PERMISSION_DENIED",
    );
    expect(
      screen.queryByText(/EXPLICIT_FIXTURE_SECRET|cargo run|C:\/private/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("The local service could not connect. Please retry."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "CURRENT EDIT",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();
  });
  it("keeps the local workbench on first Host failure and retries only by explicit action", async () => {
    const retry = deferred<Awaited<ReturnType<typeof createHostConnection>>>();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(startupError())
      .mockImplementationOnce(() => retry.promise);
    const port = {
      read: vi
        .fn()
        .mockResolvedValue(localSnapshot({ unconnected: "STATUS?" })),
      save: vi.fn(),
    };
    render(
      <I18nContext value={chinese}>
        <HostProvider desktop connect={connect}>
          <Overview draftStore={createClientDraftStore(port)} />
        </HostProvider>
      </I18nContext>,
    );
    const draft = await screen.findByRole("textbox", { name: "发送草稿" });
    expect(draft).toHaveValue("STATUS?");
    expect(draft).toBeEnabled();
    expect(screen.getByText("本机服务连接失败，请重试。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "接收" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "选择设备" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建视图" })).toBeDisabled();
    expect(
      screen.queryByText(/cargo run|private-token|D:\/private/),
    ).not.toBeInTheDocument();
    expect(connect).toHaveBeenCalledOnce();
    const button = screen.getByRole("button", { name: "重试" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.change(draft, { target: { value: "KEEP ME" } });
    fireEvent.click(button);
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(screen.getByText("正在重新连接本机服务…")).toBeVisible();
    expect(button).toBeDisabled();
    await act(async () => retry.reject(startupError()));
    expect(screen.getByRole("textbox", { name: "发送草稿" })).toHaveValue(
      "KEEP ME",
    );
    expect(port.save).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText("查看详情"));
    expect(screen.getByText("HOST_START_FAILED")).toBeVisible();
    expect(screen.getByRole("link", { name: "诊断与恢复" })).toHaveAttribute(
      "href",
      "#/settings",
    );
  });
  it("shows recovered local drafts during the first Host connection", async () => {
    const connecting =
      deferred<Awaited<ReturnType<typeof createHostConnection>>>();
    const connect = vi.fn(() => connecting.promise);
    render(
      <I18nContext value={chinese}>
        <HostProvider desktop connect={connect}>
          <Overview
            draftStore={createClientDraftStore({
              read: async () => localSnapshot({ unconnected: "RESTORED" }),
              save: vi.fn(),
            })}
          />
        </HostProvider>
      </I18nContext>,
    );
    expect(
      await screen.findByRole("textbox", { name: "发送草稿" }),
    ).toHaveValue("RESTORED");
    expect(screen.getByText("正在连接本机服务…")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(
      screen.queryByText(/状态: connecting|状态：connecting/),
    ).not.toBeInTheDocument();
    expect(connect).toHaveBeenCalledOnce();
    await act(async () => connecting.reject(startupError()));
  });
  it("waits for the real local draft read before exposing editing or saving", async () => {
    const reading = deferred<ClientStateSnapshot>();
    const port = { read: vi.fn(() => reading.promise), save: vi.fn() };
    const connect = vi.fn().mockRejectedValue(startupError());
    render(
      <I18nContext value={chinese}>
        <HostProvider desktop connect={connect}>
          <Overview draftStore={createClientDraftStore(port)} />
        </HostProvider>
      </I18nContext>,
    );
    await waitFor(() => expect(port.read).toHaveBeenCalledOnce());
    expect(screen.getByText("正在恢复本地草稿…")).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "发送草稿" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存草稿" }),
    ).not.toBeInTheDocument();
    expect(port.save).not.toHaveBeenCalled();
    await act(async () =>
      reading.resolve(localSnapshot({ unconnected: "ORIGINAL" })),
    );
    expect(
      await screen.findByRole("textbox", { name: "发送草稿" }),
    ).toHaveValue("ORIGINAL");
    expect(port.save).not.toHaveBeenCalled();
  });
  it("preserves unread and future local drafts until an explicit successful recovery", async () => {
    const snapshot = localSnapshot({ unconnected: "ORIGINAL" });
    const port = {
      read: vi
        .fn()
        .mockRejectedValueOnce({ code: "STORAGE_IO" })
        .mockResolvedValueOnce({ ...snapshot, formatVersion: "9.0" })
        .mockResolvedValue(snapshot),
      save: vi.fn(),
    };
    const connect = vi.fn().mockRejectedValue(startupError());
    render(
      <I18nContext value={chinese}>
        <HostProvider desktop connect={connect}>
          <Overview draftStore={createClientDraftStore(port)} />
        </HostProvider>
      </I18nContext>,
    );
    expect(
      await screen.findByText(
        "本地草稿未恢复，原件已保留。请重试或前往设置中的诊断与恢复。",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "发送草稿" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试恢复草稿" }));
    await waitFor(() => expect(port.read).toHaveBeenCalledTimes(2));
    expect(
      screen.getByText(
        "本地草稿未恢复，原件已保留。请重试或前往设置中的诊断与恢复。",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "发送草稿" }),
    ).not.toBeInTheDocument();
    expect(port.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试恢复草稿" }));
    expect(
      await screen.findByRole("textbox", { name: "发送草稿" }),
    ).toHaveValue("ORIGINAL");
    expect(port.save).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });
  it("keeps the preconnection draft visible when the real workspace arrives without overwriting its saved drafts", async () => {
    const online = readyHost();
    const document = snapshotWindowLayout(
      { ...defaults.workspace, name: "Restored bench" },
      [{ id: "saved-view", sessionId: "session" }],
      online.state.sessions,
      online.state.devices,
      defaults.settings.terminal,
      {},
    );
    document.views.push({
      ...document.views[0]!,
      id: "unconnected",
      name: "Saved unconnected ID",
    });
    online.saveWorkspace = vi.fn(async (base, value) => ({
      ...base,
      document: { revision: "2", value },
    }));
    const offline = readyHost();
    offline.state = {
      ...offline.state,
      status: "error",
      error: startupError(),
      devices: [],
      sessions: [],
      catalog: [],
    };
    const storage = browserClientStateStore();
    const before = storage.read();
    storage.save(
      {
        ...before.state,
        drafts: {
          unconnected: "ORIGINAL",
          "saved-view": "SAVED VIEW DRAFT",
        },
      },
      before.revision,
    );
    const port = {
      read: vi.fn(async () => storage.read()),
      save: vi.fn<ClientDraftPort["save"]>(async (state, revision) =>
        storage.save(state, revision),
      ),
    };
    const draftStore = createClientDraftStore(port);
    const content = (host: HostContextValue) => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview draftStore={draftStore} />
        </HostContext>
      </I18nContext>
    );
    const view = render(content(offline));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Send draft" }),
      { target: { value: "EDITED BEFORE CONNECT" } },
    );
    online.state.workspace = {
      ...workspace("default", "Restored bench"),
      document: { revision: "1", value: document },
    };
    view.rerender(content(online));
    expect(
      screen.getByRole("button", { name: "Restored bench" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "EDITED BEFORE CONNECT",
    );
    const local = screen.getByRole("tab", { name: "Send draft" });
    expect(local).toHaveAttribute("aria-selected", "true");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
    expect(
      screen.getByRole("button", { name: "Save current layout" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "The current draft has no device binding. Connect before saving the window layout. Drafts can be saved separately.",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout" }),
    );
    expect(online.saveWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: document.views[0]!.name }));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "SAVED VIEW DRAFT",
    );
    const colliding = screen.getByRole("tab", { name: "Saved unconnected ID" });
    fireEvent.click(colliding);
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "REAL VIEW EDIT" },
    });
    fireEvent.click(local);
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "EDITED BEFORE CONNECT",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "LOCAL AFTER WORKSPACE" },
    });
    fireEvent.click(colliding);
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "REAL VIEW EDIT",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "REAL SECOND EDIT" },
    });
    fireEvent.click(local);
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "LOCAL AFTER WORKSPACE",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: {
            unconnected: "LOCAL AFTER WORKSPACE",
            "view/unconnected": "REAL SECOND EDIT",
            "saved-view": "SAVED VIEW DRAFT",
          },
        }),
        "1",
      ),
    );
    expect(online.trustedConnect).not.toHaveBeenCalled();
    expect(online.send).not.toHaveBeenCalled();
    expect(online.invoke).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    expect(
      screen.queryByRole("tab", { name: "Send draft" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "SAVED VIEW DRAFT",
    );
    const saveLayout = screen.getByRole("button", {
      name: "Save current layout",
    });
    expect(saveLayout).toBeEnabled();
    fireEvent.click(saveLayout);
    await waitFor(() =>
      expect(online.saveWorkspace).toHaveBeenCalledWith(
        online.state.workspace,
        expect.objectContaining({
          views: expect.arrayContaining(
            document.views.map((view) =>
              expect.objectContaining({ id: view.id }),
            ),
          ),
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(
      vi.mocked(online.saveWorkspace).mock.calls[0]![1].views,
    ).toHaveLength(2);
    view.unmount();
    const restored = render(content(offline));
    expect(
      await screen.findByRole("textbox", { name: "Send draft" }),
    ).toHaveValue("LOCAL AFTER WORKSPACE");
    restored.rerender(content(online));
    fireEvent.click(screen.getByRole("tab", { name: "Saved unconnected ID" }));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "REAL SECOND EDIT",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Send draft" }));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "LOCAL AFTER WORKSPACE",
    );
    expect(screen.getByRole("button", { name: "Save drafts" })).toBeDisabled();
  });
  it.each([false, true])(
    "restores an unconnected-named view draft independently from the local draft (separate saved value: %s)",
    async (hasSeparateValue) => {
      const host = readyHost();
      const document = snapshotWindowLayout(
        { ...defaults.workspace, name: "Restored bench" },
        [{ id: "unconnected", sessionId: "session" }],
        host.state.sessions,
        host.state.devices,
        defaults.settings.terminal,
        {},
      );
      host.state.workspace = {
        ...workspace("default", "Restored bench"),
        document: { revision: "1", value: document },
      };
      const port = {
        read: vi.fn().mockResolvedValue(
          localSnapshot({
            unconnected: "LOCAL ORIGINAL",
            ...(hasSeparateValue ? { "view/unconnected": "VIEW SAVED" } : {}),
          }),
        ),
        save: vi.fn().mockResolvedValue(localSnapshot({})),
      };
      render(
        <I18nContext value={i18n}>
          <HostContext value={host}>
            <Overview draftStore={createClientDraftStore(port)} />
          </HostContext>
        </I18nContext>,
      );
      const draft = await screen.findByRole("textbox", { name: "Send draft" });
      expect(draft).toHaveValue(
        hasSeparateValue ? "VIEW SAVED" : "LOCAL ORIGINAL",
      );
      expect(
        screen.getByRole("button", { name: "Save drafts" }),
      ).toBeDisabled();
      fireEvent.change(draft, { target: { value: "VIEW CHANGED" } });
      fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
      await waitFor(() =>
        expect(port.save).toHaveBeenCalledWith(
          expect.objectContaining({
            drafts: {
              unconnected: "LOCAL ORIGINAL",
              "view/unconnected": "VIEW CHANGED",
            },
          }),
          "4",
        ),
      );
      expect(host.send).not.toHaveBeenCalled();
      expect(host.invoke).not.toHaveBeenCalled();
    },
  );
  it("moves a new local composition to the independent unconnected-named view on explicit connection", async () => {
    const online = readyHost();
    const document = snapshotWindowLayout(
      defaults.workspace,
      [{ id: "unconnected", sessionId: "session" }],
      online.state.sessions,
      online.state.devices,
      defaults.settings.terminal,
      {},
    );
    online.state.workspace = {
      ...workspace("default", "Bench"),
      document: { revision: "1", value: document },
    };
    const offline = readyHost();
    offline.state = {
      ...offline.state,
      status: "error",
      error: startupError(),
      devices: [],
      sessions: [],
      catalog: [],
    };
    const port = {
      read: vi.fn().mockResolvedValue(localSnapshot({})),
      save: vi.fn().mockResolvedValue(localSnapshot({})),
    };
    const draftStore = createClientDraftStore(port);
    const content = (host: HostContextValue) => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview draftStore={draftStore} />
        </HostContext>
      </I18nContext>
    );
    const view = render(content(offline));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Send draft" }),
      { target: { value: "ATTACH LOCAL" } },
    );
    view.rerender(content(online));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "ATTACH LOCAL",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    expect(
      screen.queryByRole("tab", { name: "Send draft" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "ATTACH LOCAL",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: { "view/unconnected": "ATTACH LOCAL" },
        }),
        "4",
      ),
    );
    expect(online.send).not.toHaveBeenCalled();
  });
  it("keeps current editing visible after a ready Host loses its attachment and workspace", async () => {
    const online = readyHost();
    online.connection = await attachment("ready");
    online.state.workspace = workspace("default", "Bench");
    const port = {
      read: vi.fn().mockResolvedValue(localSnapshot({})),
      save: vi.fn().mockResolvedValue(localSnapshot({})),
    };
    const draftStore = createClientDraftStore(port);
    const content = (host: HostContextValue) => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview draftStore={draftStore} />
        </HostContext>
      </I18nContext>
    );
    const view = render(content(online));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "CURRENT EDIT" },
    });
    const offline = readyHost();
    offline.state = {
      ...offline.state,
      status: "error",
      error: startupError(),
      devices: [],
      sessions: [],
      catalog: [],
    };
    view.rerender(content(offline));
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "CURRENT EDIT",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: { "session-session": "CURRENT EDIT" },
        }),
        "4",
      ),
    );
    expect(offline.watchSession).not.toHaveBeenCalled();
    expect(offline.checkAction).not.toHaveBeenCalled();
    expect(offline.invoke).not.toHaveBeenCalled();
  });
  it("keeps loaded workspace B active when an earlier save of A returns its real receipt", async () => {
    const host = readyHost();
    host.connection = await attachment("1");
    const first = workspace("a", "Bench A"),
      next = workspace("b", "Bench B");
    host.state.workspace = first;
    let finish!: (
      value: import("@serial-workbench/contracts").WorkspaceDocumentResult,
    ) => void;
    host.saveWorkspace = vi.fn(
      () =>
        new Promise<
          import("@serial-workbench/contracts").WorkspaceDocumentResult
        >((resolve) => {
          finish = resolve;
        }),
    );
    host.loadWorkspace = vi.fn().mockResolvedValue(next);
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save current layout" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Bench A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace ID" }), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workspace" }));
    await waitFor(() => expect(host.loadWorkspace).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Bench B" })).toBeInTheDocument();
    await act(async () => finish(workspace("a", "Late A", "2")));
    expect(screen.getByRole("button", { name: "Bench B" })).toBeInTheDocument();
  });
  it("does not reuse a saved base or late receipt across an attachment generation", async () => {
    const host = readyHost();
    host.connection = await attachment("1");
    host.state.workspace = workspace("a", "Old attachment");
    let finish!: (
      value: import("@serial-workbench/contracts").WorkspaceDocumentResult,
    ) => void;
    host.saveWorkspace = vi
      .fn()
      .mockResolvedValueOnce(workspace("a", "Saved old attachment", "2"))
      .mockImplementationOnce(
        () =>
          new Promise<
            import("@serial-workbench/contracts").WorkspaceDocumentResult
          >((resolve) => {
            finish = resolve;
          }),
      );
    const content = (current: HostContextValue) => (
      <I18nContext value={i18n}>
        <HostContext value={current}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content(host));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save current layout" }),
    );
    await screen.findByRole("button", { name: "Saved old attachment" });
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout" }),
    );
    const next = { ...readyHost(), connection: await attachment("2") };
    next.state.workspace = workspace("a", "New attachment");
    view.rerender(content(next));
    expect
      .soft(screen.queryByRole("button", { name: "New attachment" }))
      .toBeInTheDocument();
    await act(async () => finish(workspace("a", "Late old attachment", "3")));
    expect(
      screen.getByRole("button", { name: "New attachment" }),
    ).toBeInTheDocument();
  });
  it("edits and connects the selected device B while session A remains active", async () => {
    const host = readyHost();
    host.state.devices = [
      ...host.state.devices,
      {
        ...host.state.devices[0]!,
        deviceId: "other-device",
        systemName: "Other serial",
      },
    ];
    host.trustedConnect = vi.fn().mockResolvedValue({
      ...session("other-session"),
      deviceId: "other-device",
    });
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    const choice = screen.getByRole("combobox", { name: "Choose device" });
    choice.focus();
    fireEvent.keyDown(choice, { key: "ArrowDown" });
    const option = await screen.findByRole("option", { name: "Other serial" });
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    fireEvent.click(
      screen.getByRole("button", { name: /^Connection parameters / }),
    );
    expect(screen.getByLabelText("Baud rate")).toHaveValue(
      defaults.serialConfiguration.baudRate,
    );
    fireEvent.change(screen.getByLabelText("Baud rate"), {
      target: { value: "230400" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use for next connection" }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Other serial" }));
    await waitFor(() =>
      expect(host.trustedConnect).toHaveBeenCalledWith(
        "other-device",
        expect.any(AbortSignal),
        expect.objectContaining({ baudRate: "230400" }),
      ),
    );
    expect(host.invoke).not.toHaveBeenCalled();
  });
  it("applies requested serial parameters to the next explicit native connection", async () => {
    const host = readyHost();
    host.state.sessions = [];
    host.trustedConnect = vi.fn().mockResolvedValue(session());
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Connection parameters / }),
    );
    fireEvent.change(screen.getByLabelText("Baud rate"), {
      target: { value: "9600" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use for next connection" }),
    );
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.trustedConnect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    await waitFor(() =>
      expect(host.trustedConnect).toHaveBeenCalledWith(
        "device",
        expect.any(AbortSignal),
        expect.objectContaining({ baudRate: "9600" }),
      ),
    );
  });
  it("acknowledges a saved workspace revision without replacing edits made while saving", async () => {
    const host = readyHost();
    const base = {
      scope: {
        scopeId: "workspace/default",
        target: { hostId: "host", kind: "workspace", id: "default" },
      },
      document: { revision: "1", value: defaults.workspace },
    };
    host.state.workspace = base;
    let finish!: (
      value: import("@serial-workbench/contracts").WorkspaceDocumentResult,
    ) => void;
    host.saveWorkspace = vi.fn(
      () =>
        new Promise<
          import("@serial-workbench/contracts").WorkspaceDocumentResult
        >((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Submitted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Newer draft" },
    });
    await act(async () =>
      finish({
        ...base,
        document: {
          revision: "2",
          value: { ...defaults.workspace, name: "Submitted" },
        },
      }),
    );
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
      "Newer draft",
    );
    expect(host.saveWorkspace).toHaveBeenCalledWith(
      base,
      expect.objectContaining({ name: "Submitted" }),
      expect.any(AbortSignal),
    );
  });
  it("loads a workspace without connecting, sending, or starting an operation", async () => {
    const host = readyHost();
    host.state.workspace = {
      scope: {
        scopeId: "workspace/default",
        target: { hostId: "host", kind: "workspace", id: "default" },
      },
      document: { revision: "1", value: defaults.workspace },
    };
    host.loadWorkspace = vi.fn().mockResolvedValue({
      scope: {
        scopeId: "workspace/next",
        target: { hostId: "host", kind: "workspace", id: "next" },
      },
      document: {
        revision: "3",
        value: { ...defaults.workspace, name: "Other bench" },
      },
    });
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace ID" }), {
      target: { value: "next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workspace" }));
    await waitFor(() =>
      expect(host.loadWorkspace).toHaveBeenCalledWith(
        "next",
        expect.any(AbortSignal),
      ),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Other bench" }),
    ).toBeInTheDocument();
    expect(host.trustedConnect).not.toHaveBeenCalled();
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });
  it("routes file and capture buttons through the trusted picker and real independent Host actions", async () => {
    const host = readyHost();
    host.pickFile = vi.fn().mockResolvedValue({
      reference: {
        hostId: "host",
        kind: "file",
        id: "selected",
        revision: "4",
      },
      name: "data.bin",
      length: "12",
      mime: "application/octet-stream",
    });
    host.invoke = vi.fn().mockResolvedValue(operation());
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    await waitFor(() =>
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "transfer.file",
          executionMode: "independent",
          params: expect.objectContaining({
            length: "12",
            sourceRef: {
              hostId: "host",
              kind: "file",
              id: "selected",
              revision: "4",
            },
          }),
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(host.pickFile).toHaveBeenCalledWith(
      "source",
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start capture" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() =>
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "capture.start",
          executionMode: "independent",
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(host.pickFile).toHaveBeenCalledWith(
      "captureTarget",
      expect.any(AbortSignal),
      "session",
    );
  });
  it("uses the live capture reference and explicit independent stop through the Provider", async () => {
    const host = readyHost();
    const reference = { hostId: "host", kind: "capture", id: "live" };
    host.state.operations = [
      {
        ...operation("capture"),
        actionId: "capture.start",
        state: "running",
        result: { kind: "reference", value: { resultRef: reference } },
      },
    ];
    host.state.operationSummaries = host.state.operations;
    host.captureStatus = vi.fn().mockResolvedValue({
      captureRef: reference,
      summary: {
        captureId: "live",
        state: "recording",
        watermarks: {
          written: "9",
          flushed: "8",
          synced: "7",
          verified: "0",
        },
        containerComplete: false,
        sourceContinuous: true,
      },
    });
    host.invoke = vi.fn().mockResolvedValue(operation("stop"));
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Capture" }));
    const stop = await screen.findByRole("button", { name: "Stop capture" });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);
    await waitFor(() =>
      expect(host.invoke).toHaveBeenCalledWith(
        {
          actionId: "capture.stop",
          target: reference,
          params: { captureRef: reference },
          executionMode: "independent",
        },
        expect.any(AbortSignal),
      ),
    );
  });
  it("浏览器草稿保存使用同一sessionStorage窗口状态并保留偏好", async () => {
    const storage = browserClientStateStore();
    const initial = storage.read();
    storage.save(
      {
        ...initial.state,
        preferences: { ...initial.state.preferences, menuBar: false },
        drafts: { "session-session": "STATUS?" },
      },
      initial.revision,
    );
    const host = readyHost();
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "STATUS?",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "VERSION?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(storage.read().state.drafts).toEqual({
        "session-session": "VERSION?",
      }),
    );
    expect(storage.read().state.preferences.menuBar).toBe(false);
    expect(host.send).not.toHaveBeenCalled();
  });
  it("恢复窗口草稿并通过统一存储保存，不调用发送", async () => {
    const currentSession = session();
    const host: HostContextValue = {
      state: {
        status: "ready",
        error: null,
        devices: [
          {
            deviceId: "device",
            hostId: "host",
            systemName: "Virtual serial",
            fingerprint: { transport: "virtual", evidence: "unreliable" },
            capabilities: currentSession.capabilities,
          },
        ],
        sessions: [currentSession],
        operations: [],
        operationSummaries: [],
        streams: new Map(),
        catalog: actionCatalog,
        devicesStale: false,
      },
      refresh: vi.fn(),
      operationInput: vi.fn(),
      pickFile: vi.fn(),
      trustedConnect: vi.fn(),
      metrics: vi.fn().mockRejectedValue(new Error("METRICS_UNAVAILABLE")),
      captureStatus: vi.fn(),
      readCaptureTail: vi.fn(),
      readFileReceipts: vi.fn(),
      readReplay: vi.fn(),
      readFile: vi.fn(),
      fileMetadata: vi.fn(),
      sessionMetrics: vi.fn(),
      sessionInputs: vi.fn(),
      readReplayRecord: vi.fn(),
      open: vi.fn(),
      send: vi.fn(),
      takeover: vi.fn(),
      invoke: vi.fn(),
      loadWorkspace: vi.fn(),
      saveWorkspace: vi.fn(),
      saveFavorites: vi.fn(),
      rebindDevice: vi.fn(),
      recentConnections: vi.fn(),
      exportWorkspace: vi.fn(),
      previewWorkspaceImport: vi.fn(),
      waitForOperation: vi.fn(),
      checkAction: vi.fn(
        async (
          input: import("@/providers/host-context").HostActionCheckInput,
        ) => ({
          actionId: input.actionId,
          target: input.target,
          allowed: true,
        }),
      ),
      watchActions: vi.fn((inputs, listener) => {
        listener(
          inputs.map(
            (
              input: import("@/providers/host-context").HostActionCheckInput,
            ) => ({
              input,
              result: {
                actionId: input.actionId,
                target: input.target,
                allowed: true,
              },
              error: null,
            }),
          ),
        );
        return () => {};
      }),
      watchSession: vi.fn(() => () => {}),
    };
    const draftStore = {
      read: vi.fn(async () => ({ "session-session": "STATUS?" })),
      save: vi.fn().mockResolvedValue(undefined),
    };
    render(
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview draftStore={draftStore} />
        </HostContext>
      </I18nContext>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
      "STATUS?",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Send draft" }), {
      target: { value: "VERSION?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
    await waitFor(() =>
      expect(draftStore.save).toHaveBeenCalledWith(
        { "session-session": "VERSION?" },
        expect.any(AbortSignal),
      ),
    );
    expect(host.send).not.toHaveBeenCalled();
  });
  it("等待默认工作区后恢复布局，并在连接错误时保留页面状态", async () => {
    const host: HostContextValue = {
      state: {
        status: "connecting",
        error: null,
        devices: [],
        sessions: [],
        operations: [],
        operationSummaries: [],
        streams: new Map(),
        catalog: actionCatalog,
        devicesStale: false,
      },
      refresh: vi.fn(),
      operationInput: vi.fn(),
      pickFile: vi.fn(),
      trustedConnect: vi.fn(),
      metrics: vi.fn().mockRejectedValue(new Error("METRICS_UNAVAILABLE")),
      captureStatus: vi.fn(),
      readCaptureTail: vi.fn(),
      readFileReceipts: vi.fn(),
      readReplay: vi.fn(),
      readFile: vi.fn(),
      fileMetadata: vi.fn(),
      sessionMetrics: vi.fn(),
      sessionInputs: vi.fn(),
      readReplayRecord: vi.fn(),
      open: vi.fn(),
      send: vi.fn(),
      takeover: vi.fn(),
      invoke: vi.fn(),
      loadWorkspace: vi.fn(),
      saveWorkspace: vi.fn(),
      saveFavorites: vi.fn(),
      rebindDevice: vi.fn(),
      recentConnections: vi.fn(),
      exportWorkspace: vi.fn(),
      previewWorkspaceImport: vi.fn(),
      waitForOperation: vi.fn(),
      checkAction: vi.fn(
        async (
          input: import("@/providers/host-context").HostActionCheckInput,
        ) => ({
          actionId: input.actionId,
          target: input.target,
          allowed: true,
        }),
      ),
      watchActions: vi.fn((inputs, listener) => {
        listener(
          inputs.map(
            (
              input: import("@/providers/host-context").HostActionCheckInput,
            ) => ({
              input,
              result: {
                actionId: input.actionId,
                target: input.target,
                allowed: true,
              },
              error: null,
            }),
          ),
        );
        return () => {};
      }),
      watchSession: vi.fn(() => () => {}),
    };
    const content = () => (
      <I18nContext value={i18n}>
        <HostContext value={{ ...host }}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content());
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    host.state = {
      ...host.state,
      status: "ready",
      workspace: {
        document: {
          revision: "1",
          value: {
            ...defaults.workspace,
            layout: { sidebarWidth: 300, panelHeight: 240 },
          },
        },
        scope: {
          scopeId: "workspace/default",
          target: { hostId: "host", kind: "workspace", id: "default" },
        },
      },
    };
    view.rerender(content());
    expect(
      await screen.findByRole("button", { name: "Workspace" }),
    ).toBeInTheDocument();
    host.state = {
      ...host.state,
      status: "error",
      error: new Error("connection closed"),
    };
    view.rerender(content());
    expect(
      screen.getByRole("button", { name: "Workspace" }),
    ).toBeInTheDocument();
  });
  it("浏览器呈现真实空状态且禁用未连接Host的操作", async () => {
    localStorage.clear();
    render(
      <I18nContext value={i18n}>
        <HostProvider desktop={false}>
          <Overview />
        </HostProvider>
      </I18nContext>,
    );
    expect(screen.getByTestId("serial-workbench-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("showroom")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Workspace menu" }),
      { button: 0, ctrlKey: false },
    );
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(
      (
        await screen.findAllByText("No devices. Refresh to discover devices.")
      )[0],
    ).toBeInTheDocument();
  });
});

it("keeps the same capture observation when its active session parent renders again", async () => {
  const host = readyHost();
  const reference = {
    hostId: "host",
    kind: "file",
    id: "target",
    revision: "3",
  };
  host.pickFile = vi.fn().mockResolvedValue({
    reference,
    name: "capture-target",
    mime: "application/octet-stream",
    length: "0",
  });
  host.fileMetadata = vi.fn().mockResolvedValue({
    fileRef: reference,
    purpose: "capture_target",
    length: "0",
    fingerprint: "c".repeat(64),
  });
  const current = session();
  const target = {
    hostId: "host",
    kind: "session",
    id: current.sessionId,
    sessionId: current.sessionId,
    sessionEpoch: current.sessionEpoch,
  };
  const context = {
    session: current,
    target,
    configuration: current.configuration,
    configurationKey: "session:1",
    onConfigurationChange: vi.fn(),
    onInspectMetrics: vi.fn(),
    onInspectBytes: vi.fn(),
    beforeReplace: async () => true,
    trackCapture: async (
      start: (
        signal?: AbortSignal,
      ) => Promise<import("@serial-workbench/contracts").Operation | undefined>,
      signal?: AbortSignal,
    ) => start(signal),
    isReplay: false,
    items: [],
  };
  const content = (
    changes: Partial<
      import("@/features/workbench/workspace-layout").WorkbenchToolContext
    > = {},
  ) => (
    <I18nContext value={i18n}>
      <WorkbenchTools
        tool="captureTools"
        context={{ ...context, target: { ...target }, ...changes }}
        host={host}
        onChange={vi.fn()}
        onAcknowledged={vi.fn()}
        onLoaded={vi.fn()}
      />
    </I18nContext>
  );
  const view = render(content());
  fireEvent.click(
    screen.getByRole("button", { name: "Select capture destination" }),
  );
  await screen.findByText("capture-target");
  await waitFor(() => expect(host.fileMetadata).toHaveBeenCalledOnce());
  await act(async () => {});
  const before = vi
    .mocked(host.watchActions)
    .mock.calls.filter(([inputs]) =>
      inputs.some((input) => input.actionId === "capture.start"),
    );
  expect(before.length).toBeGreaterThan(0);
  view.rerender(content());
  const after = vi
    .mocked(host.watchActions)
    .mock.calls.filter(([inputs]) =>
      inputs.some((input) => input.actionId === "capture.start"),
    );
  expect(after).toHaveLength(before.length);
  const nextTarget = { ...target, sessionEpoch: "2" };
  view.rerender(
    content({ target: nextTarget, session: { ...current, sessionEpoch: "2" } }),
  );
  const observed = vi
    .mocked(host.watchActions)
    .mock.calls.flatMap(([inputs]) => inputs)
    .filter((input) => input.actionId === "capture.start");
  expect(observed.at(-1)?.params).toMatchObject({ sessionRefs: [nextTarget] });
  for (const changes of [
    { session: { ...current, state: "disconnected" as const } },
    { session: { ...current, readOnly: true } },
    { isReplay: true },
  ]) {
    view.rerender(content(changes));
    expect(
      screen.getByRole("button", { name: "Start capture" }),
    ).toBeDisabled();
    view.rerender(content());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start capture" }),
      ).toBeEnabled(),
    );
  }
});

it.each(["quick", "tools"])(
  "retains %s capture's real result reference until explicit CAS save and restores its readonly tail",
  async (entry) => {
    const host = readyHost();
    host.connection = await attachment("1");
    const base = workspace("captures", "Capture bench");
    host.state.workspace = base;
    const reference = {
      hostId: "host",
      kind: "capture",
      id: "created",
      revision: "2",
    };
    const destination = {
      hostId: "host",
      kind: "file",
      id: "destination",
      revision: "1",
    };
    host.pickFile = vi.fn().mockResolvedValue({
      reference: destination,
      name: "capture-target",
      length: "0",
      mime: "application/octet-stream",
    });
    host.fileMetadata = vi.fn().mockResolvedValue({
      fileRef: destination,
      purpose: "capture_target",
      length: "0",
      fingerprint: "a".repeat(64),
    });
    const capture = {
      ...operation("created-here"),
      actionId: "capture.start",
      state: "running" as const,
      result: { kind: "reference" as const, value: { resultRef: reference } },
    };
    host.invoke = vi.fn().mockResolvedValue(capture);
    host.readCaptureTail = vi.fn().mockResolvedValue({
      captureRef: reference,
      sourceFingerprint: "b".repeat(64),
      state: "complete",
      verifiedPrefix: "0",
      firstRecord: "1",
      containerComplete: true,
      sourceContinuous: true,
      records: [],
    });
    let saved = base;
    host.saveWorkspace = vi.fn(async (_before, value) => {
      saved = { ...base, document: { revision: "2", value } };
      return saved;
    });
    const content = () => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content());
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    if (entry === "quick")
      fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    else {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Workspace menu" }),
        { button: 0, ctrlKey: false },
      );
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: "Capture and replay tools",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Select capture destination" }),
      );
      await screen.findByText("capture-target");
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start capture" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() =>
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "capture.start" }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const tab = await screen.findByRole("tab", { name: /Recording 1/ });
    expect(host.saveWorkspace).not.toHaveBeenCalled();
    fireEvent.click(tab);
    await waitFor(() =>
      expect(host.readCaptureTail).toHaveBeenCalledWith(
        reference,
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole("button", { name: /Connection parameters/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save current layout" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout" }),
    );
    await waitFor(() =>
      expect(host.saveWorkspace).toHaveBeenCalledWith(
        base,
        expect.objectContaining({
          captures: [reference],
          views: expect.any(Array),
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(
      saved.document.value.views.every(
        (value) => !value.id.includes("capture/"),
      ),
    ).toBe(true);
    view.unmount();
    host.state = { ...host.state, workspace: saved, operations: [] };
    render(content());
    fireEvent.click(await screen.findByRole("tab", { name: /Recording 1/ }));
    expect(await screen.findByText("No verified records")).toBeInTheDocument();
    expect(host.send).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  },
);

it.each(["owned-reference", "pending-status"])(
  "keeps %s capture ownership across a same-workspace CAS revision and saves its late real reference",
  async (timing) => {
    const host = readyHost();
    host.connection = await attachment("1");
    const base = workspace("capture-cas", "Capture CAS");
    host.state.workspace = base;
    const reference = {
      hostId: "host",
      kind: "capture",
      id: "late-capture",
      revision: "2",
    };
    host.pickFile = vi.fn().mockResolvedValue({
      reference: {
        hostId: "host",
        kind: "file",
        id: "capture-target",
        revision: "1",
      },
      name: "capture-target",
      length: "0",
      mime: "application/octet-stream",
    });
    const accepted: import("@serial-workbench/contracts").Operation = {
      ...operation("capture-cas"),
      actionId: "capture.start",
      state: "running",
    };
    const receipt = deferred<import("@serial-workbench/contracts").Operation>();
    host.invoke = vi
      .fn()
      .mockImplementation(() =>
        timing === "owned-reference"
          ? Promise.resolve(accepted)
          : receipt.promise,
      );
    host.saveWorkspace = vi.fn(async (before, value) => ({
      ...before,
      document: {
        revision: String(BigInt(before.document.revision) + 1n),
        value,
      },
    }));
    const content = () => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content());
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() =>
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "capture.start" }),
        expect.any(AbortSignal),
      ),
    );
    if (timing === "owned-reference")
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start capture" }),
        ).toBeEnabled(),
      );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout" }),
    );
    await waitFor(() => expect(host.saveWorkspace).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save current layout" }),
      ).toBeEnabled(),
    );
    expect(vi.mocked(host.saveWorkspace).mock.calls[0]?.[1].captures).toEqual(
      [],
    );
    if (timing === "owned-reference") {
      host.state = {
        ...host.state,
        operations: [
          {
            ...accepted,
            result: { kind: "reference", value: { resultRef: reference } },
          },
        ],
      };
      view.rerender(content());
    } else
      await act(async () =>
        receipt.resolve({
          ...accepted,
          state: "succeeded",
          result: {
            kind: "capture_status",
            value: {
              captureRef: reference,
              summary: {
                captureId: reference.id,
                state: "complete",
                watermarks: {
                  written: "2",
                  flushed: "2",
                  synced: "2",
                  verified: "2",
                },
                containerComplete: true,
                sourceContinuous: true,
              },
            },
          },
        }),
      );
    await screen.findByRole("tab", { name: /Recording 1/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout" }),
    );
    await waitFor(() => expect(host.saveWorkspace).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(host.saveWorkspace).mock.calls[1]?.[0].document.revision,
    ).toBe("2");
    expect(vi.mocked(host.saveWorkspace).mock.calls[1]?.[1].captures).toEqual([
      reference,
    ]);
  },
);

it.each(["workspace", "attachment", "selection"])(
  "rejects an old capture start receipt after the %s owner boundary changes",
  async (boundary) => {
    const host = readyHost();
    host.connection = await attachment("1");
    const base = workspace("capture-owner", "Capture owner");
    host.state.workspace = base;
    const receipt = deferred<import("@serial-workbench/contracts").Operation>();
    const reference = {
      hostId: "host",
      kind: "capture",
      id: "old-owner-capture",
      revision: "2",
    };
    host.pickFile = vi.fn().mockResolvedValue({
      reference: {
        hostId: "host",
        kind: "file",
        id: "capture-target",
        revision: "1",
      },
      name: "capture-target",
      length: "0",
      mime: "application/octet-stream",
    });
    host.invoke = vi.fn().mockReturnValue(receipt.promise);
    const content = () => (
      <I18nContext value={i18n}>
        <HostContext value={host}>
          <Overview />
        </HostContext>
      </I18nContext>
    );
    const view = render(content());
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Virtual serial" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(host.invoke).toHaveBeenCalledOnce());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    if (boundary === "workspace") {
      host.state = {
        ...host.state,
        workspace: workspace("other-owner", "Other owner"),
      };
      view.rerender(content());
    } else if (boundary === "attachment") {
      host.connection = await attachment("2");
      view.rerender(content());
    } else {
      host.loadWorkspace = vi.fn().mockResolvedValue(base);
      fireEvent.click(screen.getByRole("button", { name: "Capture owner" }));
      fireEvent.click(screen.getByRole("button", { name: "Load workspace" }));
      await waitFor(() => expect(host.loadWorkspace).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Load workspace" }),
        ).toBeEnabled(),
      );
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    }
    await act(async () =>
      receipt.resolve({
        ...operation("old-owner"),
        actionId: "capture.start",
        state: "running",
        result: { kind: "reference", value: { resultRef: reference } },
      }),
    );
    expect(
      screen.queryByRole("tab", { name: /Recording 1/ }),
    ).not.toBeInTheDocument();
  },
);

it("edits and restores the unconnected draft from a capture without persisting the full capture id or changing device drafts", async () => {
  const host = readyHost();
  host.connection = await attachment("1");
  const base = workspace("capture-drafts", "Draft bench");
  const reference = {
    hostId: "host",
    kind: "capture",
    id: "x".repeat(128),
    revision: "2",
  };
  const document = snapshotWindowLayout(
    base.document.value,
    [{ id: "saved-device", sessionId: "session" }],
    host.state.sessions,
    host.state.devices,
    defaults.settings.terminal,
    {},
  );
  document.views[0]!.name = "Device view";
  document.captures = [reference];
  host.state.workspace = {
    ...base,
    document: { revision: "1", value: document },
  };
  host.readCaptureTail = vi.fn().mockResolvedValue({
    captureRef: reference,
    sourceFingerprint: "a".repeat(64),
    state: "complete",
    verifiedPrefix: "0",
    firstRecord: "1",
    containerComplete: true,
    sourceContinuous: true,
    records: [],
  });
  const storage = browserClientStateStore(),
    before = storage.read();
  storage.save(
    {
      ...before.state,
      drafts: { unconnected: "UNBOUND", "saved-device": "DEVICE" },
    },
    before.revision,
  );
  const draftStore = createClientDraftStore({
    read: async () => storage.read(),
    save: async (value, revision) => storage.save(value, revision),
  });
  const content = () => (
    <I18nContext value={i18n}>
      <HostContext value={host}>
        <Overview draftStore={draftStore} />
      </HostContext>
    </I18nContext>
  );
  const view = render(content());
  fireEvent.click(await screen.findByRole("tab", { name: /Recording 1/ }));
  const input = screen.getByRole("textbox", { name: "Send draft" });
  expect(input).toHaveValue("UNBOUND");
  expect(input).not.toHaveAttribute("readonly");
  expect(screen.getByText("Unconnected draft")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "UNBOUND EDIT" } });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send file" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "New view" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Connection parameters/ }),
  ).toBeDisabled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
  await waitFor(() =>
    expect(storage.read().state.drafts).toEqual({
      unconnected: "UNBOUND EDIT",
      "saved-device": "DEVICE",
    }),
  );
  expect(
    Object.keys(storage.read().state.drafts).every(
      (key) =>
        new TextEncoder().encode(key).length <= 128 &&
        !key.startsWith("capture/"),
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Device view" }));
  expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
    "DEVICE",
  );
  view.unmount();
  render(content());
  fireEvent.click(await screen.findByRole("tab", { name: /Recording 1/ }));
  expect(screen.getByRole("textbox", { name: "Send draft" })).toHaveValue(
    "UNBOUND EDIT",
  );
  expect(host.send).not.toHaveBeenCalled();
  expect(host.invoke).not.toHaveBeenCalled();
  expect(host.trustedConnect).not.toHaveBeenCalled();
});
