import {
  defaults,
  ContractValidationError,
  parseReply,
  parseWireFrame,
  type Operation,
  type SettingsSnapshot,
  type RpcRequest,
  type WireFrame,
} from "@serial-workbench/contracts";
import { describe, expect, it, vi } from "vitest";
import { createHostConnection, type HostNativePort } from "./host-client";
import { createHostSettingsBackend } from "./host-settings";
import { SettingsSync } from "./settings-sync";
import { operationFailureEventKey } from "./operation-failure";
import { HostRequestError } from "@serial-workbench/host-client";

const nativeIntent = vi.hoisted(() => vi.fn());
vi.mock("./tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tauri")>()),
  hostApplyDocumentIntent: nativeIntent,
}));

const target = { hostId: "host", kind: "settings", id: "shared" };
const scope = { scopeId: "opaque.settings.scope", target };
const document = { revision: "3", value: defaults.settings };
function setup(initial: SettingsSnapshot = document) {
  const requests: RpcRequest[] = [];
  let deliver: (frame: WireFrame) => void = () => {};
  let requestId = "";
  let invokes = 0;
  let gets = 0;
  let closed = 0;
  const deniedReads = new Map<string, { count: number; code: string }>();
  let currentDocument = initial;
  let terminalDocument = { ...initial, revision: "4" };
  let stateRevision = 89n;
  let onRead: ((action: string) => void) | undefined;
  const operation: Operation = {
    operationId: "save-op",
    executionHostId: "host",
    actorId: "actor",
    requestId: "00000000-0000-4000-8000-000000000001",
    admission: { kind: "request", requestContextDigest: "a".repeat(64) },
    rootOperationId: "save-op",
    childHighWatermark: "0",
    actionId: "settings.save",
    target,
    executionMode: "interactive",
    state: "queued",
    revision: "1",
    revealTarget: { pageId: "settings" },
    acceptedAt: "2026-11-08T00:00:00Z",
    owner: { kind: "host", id: "host" },
  };
  const port: HostNativePort = {
    attachment: async () => ({
      generation: "1",
      attachment: {
        hostId: "host",
        instanceEpoch: "7",
        protocolVersion: "0.1",
        catalogVersion: "1",
        actorId: "actor",
        clientId: "client",
        requestContext: "context",
        requestContextAcceptUntil: "2026-11-09T00:00:00Z",
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
    request: async (request) => {
      requests.push(request);
      if (request.method === "action.invoke") {
        invokes++;
        return parseReply({ ok: true, result: { operation } });
      }
      if (request.method !== "action.query") throw Error("Unexpected request");
      const action = request.params.actionId;
      onRead?.(action);
      const denied = deniedReads.get(action);
      if (denied && denied.count > 0) {
        denied.count--;
        return parseReply({
          ok: false,
          error: {
            code: denied.code,
            message: "Authorization changed",
            retryable: false,
          },
        });
      }
      if (action === "state.scopes")
        return parseReply({
          ok: true,
          result: { kind: "scopes", value: { scopes: [scope] } },
        });
      if (action === "settings.read")
        return parseReply({
          ok: true,
          result: {
            kind: "settings",
            value: { document: currentDocument, scope },
          },
        });
      if (action === "state.snapshot")
        return parseReply({
          ok: true,
          result: {
            kind: "snapshot",
            value: {
              hostId: "host",
              instanceEpoch: "7",
              revision: String(stateRevision),
              cursor: {
                hostId: "host",
                instanceEpoch: "7",
                scopeId: scope.scopeId,
                position: String(stateRevision),
              },
              state: { document: currentDocument, scope },
            },
          },
        });
      if (action === "operation.get") {
        gets++;
        return parseReply({
          ok: true,
          result: {
            kind: "operation",
            value: {
              operation: {
                ...operation,
                state: "succeeded",
                revision: "2",
                result: {
                  kind: "settings",
                  value: { document: terminalDocument, scope },
                },
              },
            },
          },
        });
      }
      throw Error(action);
    },
    subscribe: async (request, listener) => {
      deliver = listener;
      requestId = request.requestId;
      return "subscription";
    },
    unsubscribe: async () => {
      closed++;
    },
    rawRequest: vi.fn(),
    rawSubscribe: vi.fn(),
    rawUnsubscribe: vi.fn(),
    ack: async () => {},
  };
  return {
    port,
    operation,
    requests,
    denyReads(action: string, count = 1, code = "PERMISSION_DENIED") {
      deniedReads.set(action, { count, code });
    },
    beforeRead(callback: (action: string) => void) {
      onRead = callback;
    },
    terminal(snapshot: SettingsSnapshot) {
      terminalDocument = snapshot;
    },
    publish(snapshot: SettingsSnapshot) {
      currentDocument = snapshot;
      const previous = String(stateRevision++);
      const cursor = (position: string) => ({
        hostId: "host",
        instanceEpoch: "7",
        scopeId: scope.scopeId,
        position,
      });
      deliver(
        parseWireFrame({
          requestId,
          channel: "state",
          body: {
            type: "delta",
            subscriptionId: "subscription",
            delta: {
              previousCursor: cursor(previous),
              cursor: cursor(String(stateRevision)),
              revision: String(stateRevision),
              eventType: "settings.changed",
              payload: { document: snapshot, scope },
            },
          },
        }),
      );
    },
    counts: () => ({ invokes, gets, closed }),
    deliver: (frame: Omit<WireFrame, "requestId">) =>
      deliver({ ...frame, requestId } as WireFrame),
  };
}

describe("settings adapter on the existing Host connection", () => {
  it.each(["foreign-target", "rpc"])(
    "does not attach operation identity to an unverified %s failure",
    async (kind) => {
      const env = setup();
      const error = {
        code: "STORAGE_IO",
        message: "private diagnostic",
        retryable: false,
      };
      if (kind === "rpc")
        nativeIntent.mockRejectedValueOnce(new HostRequestError(error));
      else
        nativeIntent.mockResolvedValueOnce({
          ...env.operation,
          target: { ...target, id: "other" },
          state: "failed",
          error,
        });
      const connection = await createHostConnection(env.port);
      const backend = createHostSettingsBackend(connection);
      backend.markExplicitEdit();
      try {
        await backend.save(defaults.settings, "3");
        expect.unreachable("The failed save must reject");
      } catch (reason) {
        expect(reason).toBeInstanceOf(
          kind === "rpc" ? HostRequestError : ContractValidationError,
        );
        expect(operationFailureEventKey(reason)).toBeUndefined();
      } finally {
        backend.dispose();
        connection.dispose();
      }
    },
  );
  it("settles one admitted save after a terminal-read race without hiding a newer remote language", async () => {
    const initial: SettingsSnapshot = {
      revision: "3",
      value: { ...defaults.settings, language: "en" },
    };
    const env = setup(initial);
    const chinese: SettingsSnapshot = {
      revision: "4",
      value: { ...initial.value, language: "zh" },
    };
    env.terminal(chinese);
    nativeIntent.mockResolvedValue(env.operation);
    const before = nativeIntent.mock.calls.length;
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    let latest = { status: "loading", language: "en" };
    const coordinator = new SettingsSync(
      defaults.settings,
      backend,
      (state) => {
        latest = { status: state.status, language: state.settings.language };
      },
    );
    let interrupted = false;
    env.beforeRead((action) => {
      if (action !== "operation.get" || interrupted) return;
      interrupted = true;
      env.publish(chinese);
      env.publish({ revision: "5", value: initial.value });
      env.denyReads("operation.get");
    });
    try {
      await coordinator.start();
      backend.markExplicitEdit();
      coordinator.update({ language: "zh" });
      await vi.waitFor(() => expect(interrupted).toBe(true));
      await vi.waitFor(() =>
        expect(latest).toEqual({ status: "saved", language: "en" }),
      );
      expect(nativeIntent.mock.calls.length).toBe(before + 1);
      expect(env.counts().invokes).toBe(0);
    } finally {
      coordinator.stop();
      backend.dispose();
      connection.dispose();
    }
  });

  it.each(["settings.read", "state.scopes", "operation.get"])(
    "stops a continuously denied %s after three reads",
    async (action) => {
      const env = setup();
      const connection = await createHostConnection(env.port);
      const backend = createHostSettingsBackend(connection);
      const before = env.requests.length;
      env.denyReads(action, 10);
      nativeIntent.mockResolvedValue(env.operation);
      backend.markExplicitEdit();
      try {
        await expect(
          action === "operation.get"
            ? backend.save(defaults.settings, "3")
            : backend.subscribe(() => {}),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(
          env.requests
            .slice(before)
            .filter(
              (request) =>
                request.method === "action.query" &&
                request.params.actionId === action,
            ),
        ).toHaveLength(3);
        expect(env.counts().invokes).toBe(0);
      } finally {
        backend.dispose();
        connection.dispose();
      }
    },
  );

  it("does not retry a read after an attachment generation mismatch", async () => {
    const env = setup();
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    const before = env.requests.length;
    env.denyReads("settings.read", 10, "EPOCH_MISMATCH");
    try {
      await expect(backend.read()).rejects.toMatchObject({
        code: "EPOCH_MISMATCH",
      });
      expect(env.requests.slice(before)).toHaveLength(1);
    } finally {
      backend.dispose();
      connection.dispose();
    }
  });

  it.each(["reply", "rejection"])(
    "stops a pending %s read when its owner is disposed without retiring the shared connection",
    async (outcome) => {
      const env = setup();
      const connection = await createHostConnection(env.port);
      const backend = createHostSettingsBackend(connection);
      const before = env.requests.length;
      env.denyReads("settings.read", 10);
      env.beforeRead((action) => {
        if (action !== "settings.read") return;
        backend.dispose();
        if (outcome === "rejection")
          throw new Error("Late transport rejection");
      });
      try {
        await expect(backend.read()).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(env.requests.slice(before)).toHaveLength(1);
        expect((await connection.refreshScopes())[0]?.scopeId).toBe(
          scope.scopeId,
        );
      } finally {
        backend.dispose();
        connection.dispose();
      }
    },
  );

  it.each(["settings.read", "state.scopes"])(
    "establishes the settings subscription after one %s authorization race",
    async (action) => {
      const env = setup();
      const connection = await createHostConnection(env.port);
      const backend = createHostSettingsBackend(connection);
      env.denyReads(action);
      const received: string[] = [];
      try {
        const stop = await backend.subscribe((snapshot) =>
          received.push(snapshot.revision),
        );
        expect(received).toEqual(["3"]);
        expect(env.counts().invokes).toBe(0);
        stop();
      } finally {
        backend.dispose();
        connection.dispose();
      }
    },
  );

  it("reads the same admitted save after an interrupted terminal query without replaying the intent", async () => {
    const env = setup();
    nativeIntent.mockResolvedValue(env.operation);
    const before = nativeIntent.mock.calls.length;
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    env.denyReads("operation.get");
    backend.markExplicitEdit();
    try {
      expect((await backend.save(defaults.settings, "3")).revision).toBe("4");
      expect(nativeIntent.mock.calls.length).toBe(before + 1);
      expect(env.counts().invokes).toBe(0);
      const reads = env.requests.filter(
        (request) =>
          request.method === "action.query" &&
          request.params.actionId === "operation.get",
      );
      expect(reads).toHaveLength(2);
      expect(
        new Set(
          reads.flatMap((request) =>
            request.method === "action.query" ? [request.params.requestId] : [],
          ),
        ).size,
      ).toBe(2);
      for (const request of reads) {
        if (request.method === "action.query")
          expect(request.params.params.operationId).toBe("save-op");
      }
    } finally {
      backend.dispose();
      connection.dispose();
    }
  });

  it("waits for the native intent's terminal operation without reinvoking a save", async () => {
    const env = setup();
    nativeIntent.mockResolvedValue(env.operation);
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    backend.markExplicitEdit();
    expect((await backend.save(defaults.settings, "3")).revision).toBe("4");
    expect(nativeIntent).toHaveBeenLastCalledWith("1", {
      kind: "settingsSave",
      expectedRevision: "3",
      params: { value: defaults.settings },
    });
    expect(env.counts()).toMatchObject({ invokes: 0, gets: 1 });
    backend.dispose();
    connection.dispose();
  });

  it.each(["operation-target", "document-target", "document-revision"])(
    "rejects a terminal intent receipt with an invalid %s",
    async (invalid) => {
      const env = setup();
      nativeIntent.mockResolvedValue({
        ...env.operation,
        target:
          invalid === "operation-target" ? { ...target, id: "other" } : target,
        state: "succeeded",
        result: {
          kind: "settings",
          value: {
            document: {
              ...document,
              revision: invalid === "document-revision" ? "3" : "4",
            },
            scope:
              invalid === "document-target"
                ? { ...scope, target: { ...target, id: "other" } }
                : scope,
          },
        },
      });
      const connection = await createHostConnection(env.port);
      const backend = createHostSettingsBackend(connection);
      backend.markExplicitEdit();
      await expect(backend.save(defaults.settings, "3")).rejects.toMatchObject({
        name: "ContractValidationError",
      });
      backend.dispose();
      connection.dispose();
    },
  );

  it("preserves a failed operation's Core code and ignores a disposed native save's late completion", async () => {
    const env = setup();
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    nativeIntent.mockResolvedValue({
      ...env.operation,
      state: "failed",
      error: { code: "PERMISSION_DENIED", message: "revoked" },
    });
    backend.markExplicitEdit();
    await expect(backend.save(defaults.settings, "3")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    let finish!: (operation: Operation) => void;
    nativeIntent.mockImplementation(
      () =>
        new Promise<Operation>((resolve) => {
          finish = resolve;
        }),
    );
    backend.markExplicitEdit();
    const waiting = backend.save(defaults.settings, "3");
    backend.dispose();
    finish(env.operation);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(env.counts()).toMatchObject({ invokes: 0, gets: 0 });
    connection.dispose();
  });

  it("serializes tagged selections without undefined fields from other variants", async () => {
    const env = setup();
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    await backend.save(
      {
        ...defaults.settings,
        background: { kind: "preset", value: "plain", id: undefined },
      },
      "3",
    );
    const invocation = env.requests.find((r) => r.method === "action.invoke");
    expect(invocation?.params.params).not.toHaveProperty("value.background.id");
    backend.dispose();
    connection.dispose();
  });
  it("saves with document CAS revision, waits for a terminal receipt, and never re-invokes", async () => {
    const env = setup();
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    expect(await backend.read()).toEqual(document);
    const saved = await backend.save(defaults.settings, "3");
    expect(saved.revision).toBe("4");
    expect(env.counts()).toMatchObject({ invokes: 1, gets: 1 });
    const invocation = env.requests.find((r) => r.method === "action.invoke");
    expect(invocation).toMatchObject({
      params: {
        expectedRevision: "3",
        target,
        params: { value: defaults.settings },
      },
    });
    if (invocation?.method === "action.invoke")
      expect(invocation.params.params).not.toHaveProperty("expectedRevision");
    backend.dispose();
    connection.dispose();
  });
  it("subscribes to the returned scope and reads document revision independently from scope revision", async () => {
    const env = setup();
    const connection = await createHostConnection(env.port);
    const backend = createHostSettingsBackend(connection);
    const received: string[] = [];
    const stop = await backend.subscribe((snapshot) =>
      received.push(snapshot.revision),
    );
    expect(received).toEqual(["3"]);
    stop();
    backend.dispose();
    expect(env.counts().closed).toBe(1);
    // Closing settings does not dispose the shared Host connection.
    expect((await connection.refreshScopes())[0]?.scopeId).toBe(scope.scopeId);
    connection.dispose();
  });
});
