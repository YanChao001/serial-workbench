import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { HostProvider } from "./host";
import { OperationFailureObserver } from "@/features/workbench/operation-failure-notices";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { I18nContext } from "./i18n-context";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { CaptureTailPanel } from "@/features/workbench/capture-tail-panel";
import { labels as workbenchLabels } from "@/features/workbench/test-fixtures";
import { HostContext, useHost } from "./host-context";
import { createHostConnection } from "@/lib/host-client";
import { createHostWorkspace } from "./host-controller";
import type { HostConnection, HostNativePort } from "@/lib/host-client";
import fixtures from "../../packages/contracts/src/generated/fixtures.json";
import { parseReply } from "@serial-workbench/contracts";
import type {
  Call,
  CaptureStatusResult,
  ObjectRef,
  Query,
  SessionSnapshot,
  WireFrame,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));

function fixture(schema: string): unknown {
  const found = fixtures.valid.find((value) => value.schema === schema);
  if (!found) throw new Error(`Missing fixture ${schema}`);
  return found.value;
}
function port() {
  return {
    attachment: vi.fn().mockResolvedValue({
      attachment: {
        hostId: "host",
        instanceEpoch: "7",
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
      generation: "1",
    }),
    request: vi.fn<HostNativePort["request"]>(async (request) => {
      if (request.method !== "action.query")
        throw new Error("Unexpected request");
      switch (request.params.actionId) {
        case "workspace.read": {
          const reply = parseReply({
            ok: true,
            result: {
              kind: "workspace",
              value: fixture("WorkspaceDocumentResult"),
            },
          });
          if (
            !reply.ok ||
            !("kind" in reply.result) ||
            reply.result.kind !== "workspace"
          )
            throw new Error("fixture");
          return {
            ok: true,
            result: {
              kind: "workspace",
              value: {
                ...reply.result.value,
                scope: {
                  ...reply.result.value.scope,
                  target: request.params.target,
                },
              },
            },
          };
        }
        case "state.scopes":
          return {
            ok: true,
            result: { kind: "scopes", value: { scopes: [] } },
          };
        case "device.list":
          return {
            ok: true,
            result: { kind: "devices", value: { devices: [], stale: false } },
          };
        case "catalog.list":
          return {
            ok: true,
            result: {
              kind: "catalog",
              value: { catalogVersion: "1", items: [] },
            },
          };
        default:
          throw new Error(`Unexpected query ${request.params.actionId}`);
      }
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    rawRequest: vi.fn(),
    rawSubscribe: vi.fn(),
    rawUnsubscribe: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
  } satisfies HostNativePort;
}
it("publishes connection readiness before unrelated historical projections finish loading", async () => {
  const connection = await createHostConnection(port());
  let release!: (
    value: Awaited<ReturnType<HostConnection["refreshScopes"]>>,
  ) => void;
  const scopes = new Promise<
    Awaited<ReturnType<HostConnection["refreshScopes"]>>
  >((resolve) => {
    release = resolve;
  });
  const history = vi.spyOn(connection, "refreshScopes").mockReturnValue(scopes);
  const workspace = createHostWorkspace(connection);
  const pending = workspace.refresh();
  try {
    await waitFor(() => expect(history).toHaveBeenCalled());
    expect(workspace.getSnapshot().state.status).toBe("ready");
  } finally {
    release([]);
    await pending;
    workspace.dispose();
  }
});

it("does not publish a ready empty workspace before the selected workspace document arrives", async () => {
  const connection = await createHostConnection(port());
  const original = connection.client.query.bind(connection.client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input, signal) => {
      if (input.actionId === "workspace.read") await gate;
      return original(input, signal);
    });
  const workspace = createHostWorkspace(connection);
  const pending = workspace.refresh();
  try {
    await waitFor(() =>
      expect(
        query.mock.calls.some(([input]) => input.actionId === "workspace.read"),
      ).toBe(true),
    );
    expect(workspace.getSnapshot().state.status).toBe("connecting");
  } finally {
    release();
    await pending;
    workspace.dispose();
  }
});

function Probe() {
  const host = useHost();
  return <span>{host.state.status}</span>;
}

async function sessionProjectionRace(
  mode: "once" | "always" | "live" | "directory-once" | "directory-always",
) {
  const parsed = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (
    !parsed.ok ||
    !("kind" in parsed.result) ||
    parsed.result.kind !== "session"
  )
    throw new Error("session fixture");
  let session: SessionSnapshot = parsed.result.value;
  const firstEpoch = session.sessionEpoch;
  const scopeId = "fixture-session-state";
  let failSnapshot = mode === "once" || mode === "always";
  let failDirectory = false;
  let directoryFailures = 0;
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  const snapshots: string[] = [];
  const deliveries: Array<{
    query: Query;
    deliver: (frame: WireFrame) => void;
    id: string;
  }> = [];
  native.subscribe.mockImplementation(async (query, deliver) => {
    const id = `session-state-${deliveries.length}`;
    deliveries.push({ query, deliver, id });
    return id;
  });
  native.request.mockImplementation(async (request, generation) => {
    if (request.method !== "action.query") throw new Error("read-only fixture");
    const query = request.params;
    if (query.actionId === "state.scopes") {
      if (failDirectory) {
        directoryFailures++;
        if (mode === "directory-once") {
          failDirectory = false;
          session = {
            ...session,
            sessionEpoch: String(BigInt(session.sessionEpoch) + 1n),
            revision: String(BigInt(session.revision) + 1n),
          };
        }
        return parseReply({
          ok: false,
          error: {
            code: "EPOCH_MISMATCH",
            message: "Fixture session directory changed during authorization",
            retryable: false,
          },
        });
      }
      return parseReply({
        ok: true,
        result: {
          kind: "scopes",
          value: {
            scopes: [
              {
                scopeId,
                target: {
                  hostId: "host",
                  kind: "session",
                  id: session.sessionId,
                  sessionId: session.sessionId,
                  sessionEpoch: session.sessionEpoch,
                },
              },
            ],
          },
        },
      });
    }
    if (query.actionId === "device.list")
      return parseReply({
        ok: true,
        result: {
          kind: "devices",
          value: {
            stale: false,
            devices: [
              {
                hostId: "host",
                deviceId: session.deviceId,
                systemName: "COM14",
                fingerprint: { transport: "virtual", evidence: "unreliable" },
                capabilities: session.capabilities,
              },
            ],
          },
        },
      });
    if (query.actionId === "state.snapshot") {
      snapshots.push(query.target.sessionEpoch ?? "missing");
      if (failSnapshot) {
        if (mode === "once") {
          failSnapshot = false;
          session = {
            ...session,
            sessionEpoch: String(BigInt(session.sessionEpoch) + 1n),
            revision: String(BigInt(session.revision) + 1n),
          };
        }
        return parseReply({
          ok: false,
          error: {
            code: "EPOCH_MISMATCH",
            message: "Fixture session projection changed",
            retryable: false,
          },
        });
      }
      return parseReply({
        ok: true,
        result: {
          kind: "snapshot",
          value: {
            hostId: "host",
            instanceEpoch: "7",
            revision: session.revision,
            cursor: {
              hostId: "host",
              instanceEpoch: "7",
              scopeId,
              position: "0",
            },
            state: session,
          },
        },
      });
    }
    return fallback(request, generation);
  });
  const connection = await createHostConnection(native);
  // 只覆盖工作区恢复阶段，不把构造连接的首个目录读取伪造成失败。
  failDirectory = mode === "directory-once" || mode === "directory-always";
  const dispose = vi.spyOn(connection, "dispose");
  const connect = vi.fn(async () => connection);
  let current: ReturnType<typeof useHost> | undefined;
  function RaceProbe() {
    current = useHost();
    return <span>{current.state.status}</span>;
  }
  const view = render(
    <HostProvider desktop connect={connect}>
      <RaceProbe />
    </HostProvider>,
  );
  return {
    native,
    connection,
    dispose,
    connect,
    snapshots,
    deliveries,
    firstEpoch,
    view,
    current: () => current!,
    directoryFailures: () => directoryFailures,
    advance() {
      failSnapshot = false;
      failDirectory = false;
      session = {
        ...session,
        sessionEpoch: String(BigInt(session.sessionEpoch) + 1n),
        revision: String(BigInt(session.revision) + 1n),
      };
    },
    session: () => session,
  };
}

describe("session projection epoch recovery", () => {
  it("confirms the original attachment before retrying a changed session scope directory", async () => {
    const h = await sessionProjectionRace("directory-once");
    try {
      await waitFor(() => expect(h.current().state.status).toBe("ready"));
      expect(h.directoryFailures()).toBe(1);
      const probes = h.native.request.mock.calls.flatMap(([request]) =>
        request.method === "action.query" &&
        request.params.actionId === "catalog.list" &&
        request.params.params.pageSize === "1"
          ? [request.params]
          : [],
      );
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({
        hostId: "host",
        instanceEpoch: "7",
        target: { kind: "host", hostId: "host", id: "host" },
      });
      expect(h.current().connection).toBe(h.connection);
      expect(
        h.current().state.devices.map((device) => device.systemName),
      ).toEqual(["COM14"]);
      expect(h.current().state.sessions).toEqual([h.session()]);
      expect(h.current().state.error).toBeNull();
      expect(h.snapshots).toEqual([h.session().sessionEpoch]);
      expect(h.dispose).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
    } finally {
      h.view.unmount();
    }
  });

  it("bounds a repeatedly changed session directory while retaining devices and explicit recovery", async () => {
    const h = await sessionProjectionRace("directory-always");
    try {
      await waitFor(() => {
        expect(h.current().state.status).toBe("ready");
        expect(h.current().state.error).toMatchObject({
          code: "EPOCH_MISMATCH",
        });
      });
      expect(h.directoryFailures()).toBe(3);
      expect(h.current().state.error).not.toBeInstanceOf(HostRequestError);
      expect(h.current().connection).toBe(h.connection);
      expect(
        h.current().state.devices.map((device) => device.systemName),
      ).toEqual(["COM14"]);
      const probes = h.native.request.mock.calls.filter(
        ([request]) =>
          request.method === "action.query" &&
          request.params.actionId === "catalog.list" &&
          request.params.params.pageSize === "1",
      );
      expect(probes).toHaveLength(3);
      expect(h.dispose).not.toHaveBeenCalled();
      h.advance();
      await act(async () => {
        await h.current().refresh();
      });
      expect(h.current().state.status).toBe("ready");
      expect(h.current().state.error).toBeNull();
      expect(h.current().state.sessions).toEqual([h.session()]);
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
    } finally {
      h.view.unmount();
    }
  });

  it("refreshes the session directory after snapshot epoch changes without retiring the authenticated Host", async () => {
    const h = await sessionProjectionRace("once");
    try {
      await waitFor(() => expect(h.current().state.status).toBe("ready"));
      expect(h.current().connection).toBe(h.connection);
      expect(
        h.current().state.devices.map((device) => device.systemName),
      ).toEqual(["COM14"]);
      expect(h.current().state.sessions).toEqual([h.session()]);
      expect(h.current().state.error).toBeNull();
      expect(h.snapshots).toEqual([h.firstEpoch, h.session().sessionEpoch]);
      expect(h.deliveries[0]?.query.target.sessionEpoch).toBe(
        h.session().sessionEpoch,
      );
      expect(h.dispose).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
      expect(h.native.rawRequest).not.toHaveBeenCalled();
    } finally {
      h.view.unmount();
    }
  });

  it("bounds repeated session epoch changes while keeping devices and permits an explicit retry", async () => {
    const h = await sessionProjectionRace("always");
    try {
      await waitFor(() => {
        expect(h.current().state.status).toBe("ready");
        expect(h.current().state.error).toMatchObject({
          code: "EPOCH_MISMATCH",
        });
      });
      expect(h.current().state.error).not.toBeInstanceOf(HostRequestError);
      expect(h.current().connection).toBe(h.connection);
      expect(
        h.current().state.devices.map((device) => device.systemName),
      ).toEqual(["COM14"]);
      expect(h.snapshots).toHaveLength(3);
      expect(h.dispose).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledOnce();
      h.advance();
      await act(async () => {
        await h.current().refresh();
      });
      expect(h.current().state.status).toBe("ready");
      expect(h.current().state.error).toBeNull();
      expect(h.current().state.sessions).toEqual([h.session()]);
      expect(h.deliveries).toHaveLength(1);
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
    } finally {
      h.view.unmount();
    }
  });

  it("replaces an ended session projection and ignores late frames from its former epoch", async () => {
    const h = await sessionProjectionRace("live");
    try {
      await waitFor(() => expect(h.current().state.status).toBe("ready"));
      const old = h.deliveries[0]!;
      h.advance();
      act(() =>
        old.deliver({
          requestId: old.query.requestId,
          channel: "state",
          body: {
            type: "subscriptionEnded",
            subscriptionId: old.id,
            error: {
              code: "EPOCH_MISMATCH",
              message: "Fixture session reopened",
              retryable: false,
            },
          },
        }),
      );
      await waitFor(() => expect(h.deliveries).toHaveLength(2));
      expect(h.native.unsubscribe).toHaveBeenCalledWith(old.id, "1");
      expect(h.deliveries[1]?.query.target.sessionEpoch).toBe(
        h.session().sessionEpoch,
      );
      expect(h.current().state.sessions).toEqual([h.session()]);
      act(() =>
        old.deliver({
          requestId: old.query.requestId,
          channel: "state",
          body: {
            type: "error",
            error: {
              code: "EPOCH_MISMATCH",
              message: "late old projection",
              retryable: false,
            },
          },
        }),
      );
      expect(h.current().state.status).toBe("ready");
      expect(h.current().state.error).toBeNull();
      expect(h.current().connection).toBe(h.connection);
      expect(h.dispose).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledOnce();
    } finally {
      h.view.unmount();
    }
  });
  it("bounds session epoch endings across completed recovery tasks until an explicit refresh", async () => {
    const h = await sessionProjectionRace("live");
    try {
      await waitFor(() => expect(h.current().state.status).toBe("ready"));
      for (let failure = 1; failure <= 3; failure++) {
        const active = h.deliveries.at(-1)!;
        h.advance();
        act(() =>
          active.deliver({
            requestId: active.query.requestId,
            channel: "state",
            body: {
              type: "subscriptionEnded",
              subscriptionId: active.id,
              error: {
                code: "EPOCH_MISMATCH",
                message: "Fixture session reopened after completed recovery",
                retryable: false,
              },
            },
          }),
        );
        if (failure < 3) {
          // 新订阅及新 epoch 快照均已交付，下一次结束发生在另一轮恢复任务之后。
          await waitFor(() => {
            expect(h.deliveries).toHaveLength(failure + 1);
            expect(h.current().state.sessions).toEqual([h.session()]);
          });
        }
      }
      await waitFor(() =>
        expect({
          deliveries: h.deliveries.length,
          error: h.current().state.error,
        }).toMatchObject({ deliveries: 3, error: { code: "EPOCH_MISMATCH" } }),
      );
      expect(h.snapshots).toHaveLength(3);
      expect(h.current().state.status).toBe("ready");
      expect(h.current().connection).toBe(h.connection);
      expect(
        h.current().state.devices.map((device) => device.systemName),
      ).toEqual(["COM14"]);
      expect(h.dispose).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
      expect(h.native.rawRequest).not.toHaveBeenCalled();
      expect(h.native.rawSubscribe).not.toHaveBeenCalled();
      await act(async () => {
        await h.current().refresh();
      });
      expect(h.deliveries).toHaveLength(4);
      expect(h.current().state.sessions).toEqual([h.session()]);
      expect(h.current().state.error).toBeNull();
      expect(h.connect).toHaveBeenCalledOnce();
    } finally {
      h.view.unmount();
    }
  });
  it("retires a genuinely failed attachment when its session recovery budget is exhausted", async () => {
    const h = await sessionProjectionRace("live");
    try {
      await waitFor(() => expect(h.current().state.status).toBe("ready"));
      for (let recovery = 1; recovery <= 2; recovery++) {
        const active = h.deliveries.at(-1)!;
        h.advance();
        act(() =>
          active.deliver({
            requestId: active.query.requestId,
            channel: "state",
            body: {
              type: "subscriptionEnded",
              subscriptionId: active.id,
              error: {
                code: "EPOCH_MISMATCH",
                message: "Fixture session reopened before attachment failure",
                retryable: false,
              },
            },
          }),
        );
        await waitFor(() => {
          expect(h.deliveries).toHaveLength(recovery + 1);
          expect(h.current().state.sessions).toEqual([h.session()]);
        });
      }
      const original = h.native.request.getMockImplementation()!;
      const failedProbe = vi.fn(() =>
        parseReply({
          ok: false,
          error: {
            code: "EPOCH_MISMATCH",
            message: "Fixture original Host instance is no longer current",
            retryable: false,
          },
        }),
      );
      h.native.request.mockImplementation(async (request, generation) => {
        if (
          request.method === "action.query" &&
          request.params.actionId === "catalog.list" &&
          request.params.params.pageSize === "1"
        )
          return failedProbe();
        return original(request, generation);
      });
      const active = h.deliveries.at(-1)!;
      h.advance();
      act(() =>
        active.deliver({
          requestId: active.query.requestId,
          channel: "state",
          body: {
            type: "subscriptionEnded",
            subscriptionId: active.id,
            error: {
              code: "EPOCH_MISMATCH",
              message: "Fixture final session projection ended",
              retryable: false,
            },
          },
        }),
      );
      await waitFor(() => expect(h.current().state.status).toBe("error"));
      expect(failedProbe).toHaveBeenCalledOnce();
      expect(h.current().state.error).toBeInstanceOf(HostRequestError);
      expect(h.current().state.error).toMatchObject({ code: "EPOCH_MISMATCH" });
      expect(h.current().connection).toBeUndefined();
      expect(h.dispose).toHaveBeenCalledOnce();
      expect(h.deliveries).toHaveLength(3);
      expect(h.connect).toHaveBeenCalledOnce();
      expect(
        h.native.request.mock.calls.every(
          ([request]) => request.method === "action.query",
        ),
      ).toBe(true);
      expect(h.native.rawRequest).not.toHaveBeenCalled();
      expect(h.native.rawSubscribe).not.toHaveBeenCalled();
    } finally {
      h.view.unmount();
    }
  });
});
describe("HostProvider lifecycle", () => {
  it("ordinary browser preview never initializes native attachment", () => {
    const connect = vi.fn();
    render(
      <HostProvider connect={connect} desktop={false}>
        <Probe />
      </HostProvider>,
    );
    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });
  it("StrictMode discards the first late connection and closes the live one on unmount", async () => {
    const first = await createHostConnection(port());
    const second = await createHostConnection(port());
    const disposeFirst = vi.spyOn(first, "dispose");
    const disposeSecond = vi.spyOn(second, "dispose");
    let finish: (connection: HostConnection) => void = () => {};
    const connect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<HostConnection>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(second);
    const view = render(
      <StrictMode>
        <HostProvider connect={connect} desktop>
          <Probe />
        </HostProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    await act(async () => finish(first));
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).not.toHaveBeenCalled();
    view.unmount();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });
  it("two opens for one device share the in-flight invocation and reuse its session", async () => {
    const native = port();
    const connection = await createHostConnection(native);
    const parsedSession = parseReply({
      ok: true,
      result: { kind: "session", value: fixture("SessionSnapshot") },
    });
    if (
      !parsedSession.ok ||
      !("kind" in parsedSession.result) ||
      parsedSession.result.kind !== "session"
    )
      throw new Error("session fixture");
    const session = parsedSession.result.value;
    const parsedOperation = parseReply({
      ok: true,
      result: { operation: fixture("Operation") },
    });
    if (!parsedOperation.ok || !("operation" in parsedOperation.result))
      throw new Error("operation fixture");
    const operation = {
      ...parsedOperation.result.operation,
      state: "succeeded" as const,
      result: {
        kind: "opened" as const,
        value: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          revision: session.revision,
          reused: false,
        },
      },
    };
    const invoke = vi
      .spyOn(connection.client, "invoke")
      .mockResolvedValue(operation);
    vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
      if (query.actionId === "session.get")
        return { kind: "session", value: session };
      if (query.actionId === "state.scopes")
        return { kind: "scopes", value: { scopes: [] } };
      throw new Error(query.actionId);
    });
    const workspace = createHostWorkspace(connection);
    const configuration = { ...session.configuration, baudRate: "115200" };
    const a = workspace.open(session.deviceId, undefined, configuration);
    const b = workspace.open(session.deviceId);
    expect(await a).toEqual(session);
    expect(await b).toEqual(session);
    expect(await workspace.open(session.deviceId)).toEqual(session);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ params: { configuration } }),
      expect.any(AbortSignal),
    );
    expect(workspace.getSnapshot().connection).toBe(connection);
    await expect(
      workspace.send(
        {
          hostId: "host",
          kind: "session",
          id: session.sessionId,
          sessionId: session.sessionId,
          sessionEpoch: "999",
        },
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "EPOCH_MISMATCH" });
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockRejectedValueOnce(
      new HostRequestError({
        code: "PERMISSION_DENIED",
        message: "current target denied",
        retryable: false,
      }),
    );
    await expect(
      workspace.send(
        {
          hostId: "host",
          kind: "session",
          id: session.sessionId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
        },
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(invoke).toHaveBeenCalledTimes(2);
    workspace.dispose();
  });
});

it("two views share one reader startup and only the final unmount aborts it", async () => {
  const native = port();
  const connection = await createHostConnection(native);
  const sessionReply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (
    !sessionReply.ok ||
    !("kind" in sessionReply.result) ||
    sessionReply.result.kind !== "session"
  )
    throw new Error("fixture");
  const session = sessionReply.result.value;
  const scope = {
    scopeId: "opaque-session",
    target: {
      hostId: connection.attachment.hostId,
      kind: "session",
      id: session.sessionId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    },
  };
  vi.spyOn(connection, "refreshScopes").mockResolvedValue([scope]);
  vi.spyOn(connection.client, "subscribe").mockImplementation(
    async (_scope, listener) => {
      listener({
        type: "snapshot",
        snapshot: {
          hostId: connection.attachment.hostId,
          instanceEpoch: connection.attachment.instanceEpoch,
          revision: "1",
          cursor: {
            hostId: connection.attachment.hostId,
            instanceEpoch: connection.attachment.instanceEpoch,
            scopeId: scope.scopeId,
            position: "0",
          },
          state: JSON.parse(JSON.stringify(session)),
        },
      });
      return () => {};
    },
  );
  let readerSignal: AbortSignal | undefined;
  vi.spyOn(connection.transport, "rawRequest").mockImplementation(
    (_request, signal) => {
      readerSignal = signal;
      return new Promise(() => {});
    },
  );
  const workspace = createHostWorkspace(connection);
  await workspace.refresh();
  const first = workspace.watchSession(session.sessionId, () => {});
  const second = workspace.watchSession(session.sessionId, () => {});
  expect(connection.transport.rawRequest).toHaveBeenCalledTimes(1);
  first();
  expect(readerSignal?.aborted).toBe(false);
  second();
  expect(readerSignal?.aborted).toBe(true);
  expect(workspace.getSnapshot().state.streams.has(session.sessionId)).toBe(
    false,
  );
  workspace.dispose();
});

it("retries attachment only after an explicit refresh following a connection failure", async () => {
  let current: ReturnType<typeof useHost> | undefined;
  function RetryProbe() {
    current = useHost();
    return <span>{current.state.status}</span>;
  }
  const connected = await createHostConnection(port());
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(connected);
  const view = render(
    <HostProvider desktop connect={connect}>
      <RetryProbe />
    </HostProvider>,
  );
  await waitFor(() => expect(current?.state.status).toBe("error"));
  expect(connect).toHaveBeenCalledTimes(1);
  await act(async () => {
    await current?.refresh();
  });
  expect(current?.state.status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("forwards explicit COM enumeration through the published Host provider", async () => {
  const connection = await createHostConnection(port());
  const read = connection.client.query;
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input, signal) => {
      if (input.actionId === "device.refresh")
        return { kind: "devices", value: { devices: [], stale: false } };
      return read(input, signal);
    });
  let current: ReturnType<typeof useHost> | undefined;
  function Probe() {
    current = useHost();
    return null;
  }
  const connect = vi.fn().mockResolvedValue(connection);
  const view = render(
    <HostProvider desktop connect={connect}>
      <Probe />
    </HostProvider>,
  );
  try {
    await waitFor(() => expect(current?.state.status).toBe("ready"));
    await act(async () => {
      if (!current) throw new Error("Missing published Host");
      await current.refresh({ enumerateDevices: true });
    });
    expect(
      query.mock.calls.filter(([input]) => input.actionId === "device.refresh"),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([input]) => input.actionId === "device.list"),
    ).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
});

async function establishedProvider() {
  const connection = await createHostConnection(port());
  vi.spyOn(connection, "refreshScopes").mockResolvedValue([
    { scopeId: "host.devices", target: connection.hostTarget },
  ]);
  let projection: Parameters<typeof connection.client.subscribe>[1] = () => {};
  const stop = vi.fn();
  vi.spyOn(connection.client, "subscribe").mockImplementation(
    async (_scope, listener) => {
      projection = listener;
      return stop;
    },
  );
  let current: ReturnType<typeof useHost> | undefined;
  function EstablishedProbe() {
    current = useHost();
    return <span>{current.state.status}</span>;
  }
  const connect = vi.fn(async () => connection);
  const view = render(
    <HostProvider desktop connect={connect}>
      <EstablishedProbe />
    </HostProvider>,
  );
  await waitFor(() => expect(current?.state.status).toBe("ready"));
  expect(connection.client.subscribe).toHaveBeenCalledOnce();
  return {
    connection,
    connect,
    stop,
    view,
    current: () => current!,
    lateProjection: () =>
      projection({ type: "error", error: new Error("late old projection") }),
    failProjection: (error: Error) => projection({ type: "error", error }),
  };
}

it("keeps an old render's action effect safe when its Host retires during commit", async () => {
  const established = await establishedProvider();
  const failure = new HostRequestError({
    code: "UNAUTHENTICATED",
    message: "Owned Host stopped",
    retryable: true,
  });
  const query = vi.spyOn(established.connection.client, "query");
  const dispose = vi.spyOn(established.connection, "dispose");
  const observed = vi.fn();
  const pendingInput = {
    actionId: "session.open",
    target: established.connection.hostTarget,
    params: {},
  };
  function OldRender() {
    const watch = established.current().watchActions;
    useLayoutEffect(() => established.failProjection(failure), []);
    useEffect(() => watch([pendingInput], observed), [watch]);
    return <input aria-label="Preserved draft" defaultValue="UNSENT" />;
  }
  // 固定交错：渲染捕获旧观察器，layout 阶段退休 Host，随后提交旧 passive effect。
  const committed = render(<OldRender />);
  expect(screen.getByRole("textbox", { name: "Preserved draft" })).toHaveValue(
    "UNSENT",
  );
  expect(established.current().state.status).toBe("error");
  expect(established.current().state.error).toBe(failure);
  expect(dispose).toHaveBeenCalledOnce();
  expect(observed).toHaveBeenCalledExactlyOnceWith([
    { input: pendingInput, result: null, error: null },
  ]);
  expect(query).not.toHaveBeenCalled();
  expect(established.connect).toHaveBeenCalledOnce();
  committed.unmount();
  established.view.unmount();
});

it.each(["HOST_START_FAILED", "UNAUTHENTICATED", "EPOCH_MISMATCH"])(
  "retires a %s attachment and restores reads only after explicit Retry",
  async (code) => {
    const established = await establishedProvider();
    const retiredWatch = established.current().watchActions;
    const failure = new HostRequestError({
      code,
      message:
        "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
      retryable: true,
    });
    const dispose = vi.spyOn(established.connection, "dispose");
    vi.spyOn(established.connection.client, "query").mockRejectedValueOnce(
      failure,
    );
    await act(async () => {
      await expect(established.current().refresh()).rejects.toBe(failure);
    });
    expect(established.current().state.status).toBe("error");
    act(established.lateProjection);
    expect(established.current().state.status).toBe("error");
    expect(established.current().state.error).toBe(failure);
    expect(established.current().connection).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(established.stop).toHaveBeenCalledOnce();
    expect(established.connect).toHaveBeenCalledOnce();
    const observed = vi.fn();
    const pendingInput = {
      actionId: "session.open",
      target: established.connection.hostTarget,
      params: {},
    };
    function LateCommittedWatcher() {
      useEffect(() => retiredWatch([pendingInput], observed), []);
      return <span>Preserved draft</span>;
    }
    // Host 退休后仍可能提交持有旧快照的被动 effect；它不能使路由进入错误边界。
    const late = render(<LateCommittedWatcher />);
    expect(screen.getByText("Preserved draft")).toBeInTheDocument();
    expect(observed).toHaveBeenCalledExactlyOnceWith([
      { input: pendingInput, result: null, error: null },
    ]);
    late.unmount();
    const native = port();
    const old = await native.attachment();
    native.attachment.mockResolvedValue({
      ...old,
      generation: "2",
      attachment: { ...old.attachment, instanceEpoch: "8" },
    });
    const replacement = await createHostConnection(native);
    established.connect.mockResolvedValue(replacement);
    await act(async () => {
      await established.current().refresh();
    });
    expect(established.current().state.status).toBe("ready");
    expect(established.current().connection?.generation).toBe("2");
    expect(established.current().connection?.attachment.instanceEpoch).toBe(
      "8",
    );
    act(established.lateProjection);
    expect(established.current().state.status).toBe("ready");
    expect(
      native.request.mock.calls.some(
        ([request]) =>
          request.method === "action.query" &&
          request.params.instanceEpoch === "8",
      ),
    ).toBe(true);
    expect(
      native.request.mock.calls.every(
        ([request]) => request.method !== "action.invoke",
      ),
    ).toBe(true);
    established.view.unmount();
  },
);

it("keeps an established attachment ready after an ordinary refresh query permission failure", async () => {
  const established = await establishedProvider();
  const failure = new HostRequestError({
    code: "PERMISSION_DENIED",
    message:
      "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
    retryable: false,
  });
  const dispose = vi.spyOn(established.connection, "dispose");
  vi.spyOn(established.connection.client, "query").mockRejectedValueOnce(
    failure,
  );
  await act(async () => {
    await expect(established.current().refresh()).rejects.toBe(failure);
  });
  expect(established.current().state.status).toBe("ready");
  expect(established.current().connection).toBe(established.connection);
  expect(dispose).not.toHaveBeenCalled();
  expect(established.stop).not.toHaveBeenCalled();
  expect(established.connect).toHaveBeenCalledOnce();
  established.view.unmount();
});

it.each(["PERMISSION_DENIED", "STORAGE_UNAVAILABLE"])(
  "keeps the authenticated connection when the first workspace refresh fails with %s",
  async (code) => {
    const native = port();
    const connection = await createHostConnection(native);
    const dispose = vi.spyOn(connection, "dispose");
    const failure = new HostRequestError({
      code,
      message: "metadata failed",
      retryable: false,
    });
    vi.spyOn(connection.client, "query").mockRejectedValueOnce(failure);
    const connect = vi.fn(async () => connection);
    let current: ReturnType<typeof useHost> | undefined;
    function InitialRefreshProbe() {
      current = useHost();
      return <span>{current.state.status}</span>;
    }
    const view = render(
      <HostProvider desktop connect={connect}>
        <InitialRefreshProbe />
      </HostProvider>,
    );
    try {
      await waitFor(() => expect(current?.state.status).toBe("error"));
      expect(current?.state.error).toBe(failure);
      expect(current?.connection).toBe(connection);
      expect(dispose).not.toHaveBeenCalled();
      await act(async () => current?.refresh());
      expect(current?.state.status).toBe("ready");
      expect(current?.connection).toBe(connection);
      expect(connect).toHaveBeenCalledOnce();
      expect(
        native.request.mock.calls.every(
          ([request]) => request.method !== "action.invoke",
        ),
      ).toBe(true);
    } finally {
      view.unmount();
    }
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it("loads workspace configuration without opening devices and saves against the returned revision and target", async () => {
  const connection = await createHostConnection(port());
  const parsed = parseReply({
    ok: true,
    result: { kind: "workspace", value: fixture("WorkspaceDocumentResult") },
  });
  if (
    !parsed.ok ||
    !("kind" in parsed.result) ||
    parsed.result.kind !== "workspace"
  )
    throw new Error("workspace fixture");
  const document = {
    ...parsed.result.value,
    scope: {
      ...parsed.result.value.scope,
      target: {
        hostId: connection.attachment.hostId,
        kind: "workspace",
        id: "chosen",
      },
    },
  };
  const query = vi
    .spyOn(connection.client, "query")
    .mockResolvedValue({ kind: "workspace", value: document });
  vi.spyOn(connection, "refreshScopes").mockResolvedValue([document.scope]);
  vi.spyOn(connection.client, "subscribe").mockResolvedValue(() => {});
  const invoke = vi.spyOn(connection.client, "invoke");
  const applyDocumentIntent = vi.fn();
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi.fn(),
    chooseFile: vi.fn(),
    applyDocumentIntent,
  });
  const directory = {
    workspaces: [
      {
        scope: document.scope,
        name: document.document.value.name,
        revision: document.document.revision,
      },
    ],
  };
  query.mockResolvedValueOnce({ kind: "workspaces", value: directory });
  expect(await workspace.listWorkspaces()).toEqual(directory);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ actionId: "workspace.list" }),
    expect.any(AbortSignal),
  );
  expect(workspace.getSnapshot().state.workspace).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
  const loaded = await workspace.loadWorkspace("chosen");
  expect(loaded).toEqual(document);
  expect(workspace.getSnapshot().state.workspace).toEqual(document);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      actionId: "workspace.read",
      target: expect.objectContaining({ id: "chosen" }),
    }),
    expect.any(AbortSignal),
  );
  expect(invoke).not.toHaveBeenCalled();
  const operationReply = parseReply({
    ok: true,
    result: { operation: fixture("Operation") },
  });
  if (!operationReply.ok || !("operation" in operationReply.result))
    throw new Error("operation fixture");
  const receipt = {
    ...document,
    document: {
      ...document.document,
      revision: (BigInt(document.document.revision) + 1n).toString(),
    },
  };
  applyDocumentIntent.mockResolvedValue({
    ...operationReply.result.operation,
    actionId: "workspace.save",
    executionHostId: "host",
    target: document.scope.target,
    state: "succeeded",
    result: { kind: "workspace", value: receipt },
  });
  await expect(
    workspace.saveWorkspace(document, document.document.value),
  ).resolves.toEqual(receipt);
  expect(invoke).not.toHaveBeenCalled();
  expect(applyDocumentIntent).toHaveBeenCalledWith(connection.generation, {
    kind: "workspaceSave",
    workspaceId: "chosen",
    expectedRevision: document.document.revision,
    params: { value: document.document.value },
  });
  workspace.dispose();
});

it("preserves explicit independent execution, revision and lease through generic invocation", async () => {
  const connection = await createHostConnection(port());
  const reply = parseReply({
    ok: true,
    result: { operation: fixture("Operation") },
  });
  if (!reply.ok || !("operation" in reply.result)) throw new Error("fixture");
  const invoke = vi
    .spyOn(connection.client, "invoke")
    .mockResolvedValue(reply.result.operation);
  const workspace = createHostWorkspace(connection);
  const signal = new AbortController().signal;
  const input = {
    actionId: "transfer.start",
    target: connection.hostTarget,
    params: { objectId: "chosen-source" },
    executionMode: "independent",
    expectedRevision: "9",
    leaseId: "issued-lease",
  } satisfies Pick<
    Call,
    | "actionId"
    | "target"
    | "params"
    | "executionMode"
    | "expectedRevision"
    | "leaseId"
  >;
  await workspace.invoke(input, signal);
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      ...input,
      requestContext: connection.attachment.requestContext,
    }),
    signal,
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(workspace.getSnapshot().state.operations).toEqual([
    reply.result.operation,
  ]);
  workspace.dispose();
});

async function operationProjection() {
  const connection = await createHostConnection(port());
  const reply = parseReply({
    ok: true,
    result: { operation: fixture("Operation") },
  });
  if (!reply.ok || !("operation" in reply.result)) throw new Error("fixture");
  const operation = reply.result.operation;
  let publish: Parameters<typeof connection.client.subscribe>[1] = () => {};
  vi.spyOn(connection, "refreshScopes").mockResolvedValue([
    { scopeId: "host.operations", target: connection.hostTarget },
  ]);
  vi.spyOn(connection.client, "subscribe").mockImplementation(
    async (_scope, listener) => {
      publish = listener;
      return () => {};
    },
  );
  const workspace = createHostWorkspace(connection);
  await workspace.refresh();
  return {
    connection,
    workspace,
    operation,
    metadata(
      ids: string[],
      source = operation,
      options?: { delta?: boolean; revisions?: Record<string, string> },
    ) {
      const snapshot = {
        hostId: connection.attachment.hostId,
        instanceEpoch: connection.attachment.instanceEpoch,
        revision: "1",
        cursor: {
          hostId: connection.attachment.hostId,
          instanceEpoch: connection.attachment.instanceEpoch,
          scopeId: "host.operations",
          position: "1",
        },
        state: {
          items: ids.map((operationId) => ({
            operationId,
            executionHostId: source.executionHostId,
            actorId: source.actorId,
            actionId: source.actionId,
            target: source.target,
            executionMode: source.executionMode,
            state: source.state,
            revision: options?.revisions?.[operationId] ?? source.revision,
            revealTarget: source.revealTarget,
            acceptedAt: source.acceptedAt,
            ...(source.error ? { errorCode: source.error.code } : {}),
          })),
        },
      };
      if (options?.delta) {
        publish({
          type: "delta",
          delta: {
            cursor: snapshot.cursor,
            previousCursor: { ...snapshot.cursor, position: "0" },
            revision: "1",
            eventType: "operations",
            payload: snapshot.state,
          },
        });
      } else
        publish({
          type: "snapshot",
          snapshot,
        });
    },
  };
}

it.each([false, true])(
  "keeps delayed startup history quiet and reports a later capture failure (persisted failures: %s)",
  async (persisted) => {
    const { connection, workspace, operation, metadata } =
      await operationProjection();
    const failure = {
      ...operation,
      actionId: "capture.start",
      state: "failed" as const,
      error: {
        code: "PERMISSION_DENIED",
        message: "Fixture denied",
        retryable: false,
      },
    };
    vi.spyOn(connection.client, "query").mockResolvedValue({
      kind: "operation",
      value: { operation: failure },
    });
    function Observer() {
      const value = useSyncExternalStore(
        workspace.subscribe,
        workspace.getSnapshot,
      );
      return (
        <HostContext value={value}>
          <I18nContext value={{ language: "en", t: createTranslator(en) }}>
            <OperationFailureObserver />
          </I18nContext>
        </HostContext>
      );
    }
    clearUserLog();
    vi.mocked(toast.custom).mockClear();
    const view = render(
      <StrictMode>
        <Observer />
      </StrictMode>,
    );
    try {
      expect(workspace.getSnapshot().state.status).toBe("ready");
      expect(workspace.getSnapshot().state.operationSummaries).toEqual([]);
      const history = persisted
        ? ["old-capture-1", "old-capture-2", "old-capture-3"]
        : [];
      await act(async () => metadata(history, failure));
      expect(workspace.getSnapshot().state.operationSummaries).toHaveLength(
        history.length,
      );
      expect(toast.custom).not.toHaveBeenCalled();
      expect(getUserLog()).toEqual([]);

      await act(async () =>
        metadata([`new-capture-failure-${persisted}`, ...history], failure),
      );
      expect(toast.custom).toHaveBeenCalledOnce();
      expect(getUserLog()).toEqual([
        expect.objectContaining({
          module: "capture",
          code: "PERMISSION_DENIED",
          count: 1,
        }),
      ]);
    } finally {
      view.unmount();
      workspace.dispose();
      clearUserLog();
      vi.mocked(toast.custom).mockClear();
    }
  },
);

it("selects the first 128 active-first newest operation metadata entries", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const queried: string[] = [];
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    const id = query.params.operationId;
    if (typeof id !== "string") throw new Error("operation id");
    queried.push(id);
    return {
      kind: "operation",
      value: { operation: { ...operation, operationId: id } },
    };
  });
  const ids = Array.from({ length: 256 }, (_, index) => `priority-${index}`);
  metadata(ids);
  await waitFor(() => expect(queried).toHaveLength(128));
  expect(queried).toEqual(ids.slice(0, 128));
  expect(
    workspace
      .getSnapshot()
      .state.operationSummaries.map((item) => item.operationId),
  ).toEqual(ids.slice(0, 128));
  expect(
    workspace.getSnapshot().state.operations.map((item) => item.operationId),
  ).toEqual(ids.slice(0, 128));
  workspace.dispose();
});

it("serves newest operation metadata after the in-flight batch instead of draining an obsolete history round", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queried: string[] = [];
  vi.spyOn(connection.client, "query").mockImplementation(async (input) => {
    const id = input.params.operationId;
    if (typeof id !== "string") throw new Error("operation id");
    queried.push(id);
    if (queried.length <= 8) await gate;
    return {
      kind: "operation",
      value: { operation: { ...operation, operationId: id } },
    };
  });
  const ids = Array.from({ length: 128 }, (_, index) => `older-${index}`);
  try {
    metadata(ids);
    await waitFor(() => expect(queried).toHaveLength(8));
    metadata(["newest-operation", ...ids]);
    release();
    await waitFor(() => expect(queried.length).toBeGreaterThan(8));
    expect(queried[8]).toBe("newest-operation");
  } finally {
    release();
    workspace.dispose();
  }
});

it("reads only changed operation details for a delta but reauthorizes all details for a fresh snapshot", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const ids = Array.from(
    { length: 128 },
    (_, index) => `delta-detail-${index}`,
  );
  const changedId = ids[0]!;
  let revision = operation.revision;
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => {
      const id = input.params.operationId;
      if (typeof id !== "string") throw new Error("operation id");
      return {
        kind: "operation",
        value: {
          operation: {
            ...operation,
            operationId: id,
            revision: id === changedId ? revision : operation.revision,
          },
        },
      };
    });
  try {
    metadata(ids);
    await waitFor(() =>
      expect(workspace.getSnapshot().state.operations).toHaveLength(128),
    );
    query.mockClear();
    revision = String(BigInt(revision) + 1n);
    const options = { delta: true, revisions: { [changedId]: revision } };
    metadata(ids, operation, options);
    await waitFor(() =>
      expect(
        workspace
          .getSnapshot()
          .state.operations.find((value) => value.operationId === changedId)
          ?.revision,
      ).toBe(revision),
    );
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    metadata(ids, operation, options);
    expect(query).not.toHaveBeenCalled();
    metadata(ids, operation, { delta: true });
    expect(query).not.toHaveBeenCalled();
    metadata(ids, operation, { revisions: options.revisions });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(128));
  } finally {
    workspace.dispose();
  }
});

it("finishes fresh authorization reads even if an unchanged delta arrives mid-refresh", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const ids = Array.from(
    { length: 16 },
    (_, index) => `authorized-detail-${index}`,
  );
  let sanitize = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => {
      const id = input.params.operationId;
      if (typeof id !== "string") throw new Error("operation id");
      if (sanitize) await gate;
      return {
        kind: "operation",
        value: {
          operation: {
            ...operation,
            operationId: id,
            error: {
              code: "STORAGE_IO",
              message: "write failed",
              retryable: false,
              ...(sanitize
                ? {}
                : { details: { privateDiagnostic: "old details" } }),
            },
          },
        },
      };
    });
  try {
    metadata(ids);
    await waitFor(() =>
      expect(workspace.getSnapshot().state.operations).toHaveLength(16),
    );
    query.mockClear();
    sanitize = true;
    metadata(ids);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(8));
    metadata(ids, operation, { delta: true });
    release();
    await waitFor(() =>
      expect(
        workspace
          .getSnapshot()
          .state.operations.every(
            (value) => value.error?.details === undefined,
          ),
      ).toBe(true),
    );
    expect(query).toHaveBeenCalledTimes(16);
  } finally {
    release();
    workspace.dispose();
  }
});

it("does not republish unchanged operation details while still reading each operation with current permissions", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const ids = ["stable-a", "stable-b", "stable-c", "changing"];
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => {
      const id = input.params.operationId;
      if (typeof id !== "string") throw new Error("operation id");
      return {
        kind: "operation",
        value: {
          operation: structuredClone({ ...operation, operationId: id }),
        },
      };
    });
  metadata(ids);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(ids.length),
  );
  const before = workspace.getSnapshot().state.operations;
  const published = vi.fn();
  const stop = workspace.subscribe(published);
  try {
    query.mockClear();
    metadata(ids);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(ids.length));
    await Promise.all(query.mock.results.map((result) => result.value));
    expect({
      notifications: published.mock.calls.length,
      stableOperationObjects: workspace
        .getSnapshot()
        .state.operations.every((value, index) => value === before[index]),
    }).toEqual({ notifications: 1, stableOperationObjects: true });
    expect(workspace.getSnapshot().state.operations).toBe(before);
    expect(query.mock.calls.map(([input]) => input.params.operationId)).toEqual(
      ids,
    );
  } finally {
    stop();
    workspace.dispose();
  }
});

it("publishes a new operation revision once while retaining other operation objects", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const ids = ["stable-a", "stable-b", "stable-c", "changing"];
  let changed = false;
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => {
      const id = input.params.operationId;
      if (typeof id !== "string") throw new Error("operation id");
      return {
        kind: "operation",
        value: {
          operation: structuredClone({
            ...operation,
            operationId: id,
            revision:
              id === "changing" && changed
                ? String(BigInt(operation.revision) + 1n)
                : operation.revision,
          }),
        },
      };
    });
  metadata(ids);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(ids.length),
  );
  const before = workspace.getSnapshot().state.operations;
  const published = vi.fn();
  const stop = workspace.subscribe(published);
  try {
    changed = true;
    query.mockClear();
    metadata(ids);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(ids.length));
    await Promise.all(query.mock.results.map((result) => result.value));
    expect(published).toHaveBeenCalledTimes(2);
    const current = workspace.getSnapshot().state.operations;
    for (const id of ids.slice(0, -1))
      expect(current.find((value) => value.operationId === id)).toBe(
        before.find((value) => value.operationId === id),
      );
    expect(
      current.find((value) => value.operationId === "changing"),
    ).toHaveProperty("revision", String(BigInt(operation.revision) + 1n));
  } finally {
    stop();
    workspace.dispose();
  }
});

it("accepts same-revision operation detail redaction returned by a fresh authorized read", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const full = {
    ...operation,
    error: {
      code: "STORAGE_IO",
      message: "write failed",
      retryable: false,
      details: { privateDiagnostic: "not displayed" },
    },
  };
  const query = vi
    .spyOn(connection.client, "query")
    .mockResolvedValue({ kind: "operation", value: { operation: full } });
  metadata([operation.operationId]);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(1),
  );
  const sanitized = {
    ...full,
    error: { code: "STORAGE_IO", message: "write failed", retryable: false },
  };
  query.mockResolvedValue({
    kind: "operation",
    value: { operation: sanitized },
  });
  metadata([operation.operationId]);
  await waitFor(() =>
    expect(
      workspace.getSnapshot().state.operations[0]?.error?.details,
    ).toBeUndefined(),
  );
  expect(workspace.getSnapshot().state.operations[0]?.revision).toBe(
    full.revision,
  );
  expect(query).toHaveBeenCalledTimes(2);
  workspace.dispose();
});

it("still resolves a missing replay session after a same-revision operation is read again", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const parsed = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (
    !parsed.ok ||
    !("kind" in parsed.result) ||
    parsed.result.kind !== "session"
  )
    throw new Error("session fixture");
  const session = parsed.result.value;
  const replay = {
    ...operation,
    actionId: "replay.open",
    state: "succeeded" as const,
    result: {
      kind: "opened" as const,
      value: {
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        revision: session.revision,
        reused: false,
      },
    },
  };
  let denied = true;
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => {
      if (input.actionId === "operation.get")
        return {
          kind: "operation",
          value: { operation: structuredClone(replay) },
        };
      if (input.actionId === "session.get") {
        if (denied)
          throw new HostRequestError({
            code: "PERMISSION_DENIED",
            message: "old authorization",
            retryable: false,
          });
        return { kind: "session", value: session };
      }
      throw new Error(input.actionId);
    });
  try {
    metadata([replay.operationId], replay);
    await waitFor(() =>
      expect(workspace.getSnapshot().state.error).toMatchObject({
        code: "PERMISSION_DENIED",
      }),
    );
    expect(workspace.getSnapshot().state.sessions).toHaveLength(0);
    denied = false;
    metadata([replay.operationId], replay);
    await waitFor(() =>
      expect(workspace.getSnapshot().state.sessions).toEqual([session]),
    );
    expect(
      query.mock.calls.filter(([input]) => input.actionId === "session.get"),
    ).toHaveLength(2);
  } finally {
    workspace.dispose();
  }
});

it("continues authorized operation detail reads after another actor's detail is denied", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const queried: string[] = [];
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    const id = query.params.operationId;
    if (typeof id !== "string") throw new Error("operation id");
    queried.push(id);
    if (id === "mcp-private")
      throw new HostRequestError({
        code: "PERMISSION_DENIED",
        message: "owner only",
        retryable: false,
      });
    return {
      kind: "operation",
      value: { operation: { ...operation, operationId: id } },
    };
  });
  const own = Array.from({ length: 10 }, (_, index) => `own-${index}`);
  metadata(["mcp-private", ...own]);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(10),
  );
  expect(queried).toEqual(["mcp-private", ...own]);
  expect(
    workspace.getSnapshot().state.operations.map((item) => item.operationId),
  ).toEqual(own);
  expect(
    workspace
      .getSnapshot()
      .state.operationSummaries.map((item) => item.operationId),
  ).toEqual(["mcp-private", ...own]);
  expect(
    workspace.getSnapshot().state.operationSummaries[0],
  ).not.toHaveProperty("requestId");
  expect(
    workspace.getSnapshot().state.operationSummaries[0],
  ).not.toHaveProperty("admission");
  expect(
    workspace.getSnapshot().state.operationSummaries[0],
  ).not.toHaveProperty("result");
  expect(workspace.getSnapshot().state.error).toBeNull();
  workspace.dispose();
});

it("stops queued detail lookups after disposal while at most eight reads are pending", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const release: (() => void)[] = [];
  const queried: string[] = [];
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    const id = query.params.operationId;
    if (typeof id !== "string") throw new Error("operation id");
    queried.push(id);
    await new Promise<void>((resolve) => release.push(resolve));
    return {
      kind: "operation",
      value: { operation: { ...operation, operationId: id } },
    };
  });
  metadata(Array.from({ length: 20 }, (_, index) => `own-${index}`));
  expect(queried).toHaveLength(8);
  workspace.dispose();
  await act(async () => {
    for (const resolve of release) resolve();
  });
  expect(queried).toHaveLength(8);
  expect(workspace.getSnapshot().state.operations).toHaveLength(0);
});

it("drops previously readable details when permission is revoked while retaining the safe summary", async () => {
  const { connection, workspace, operation, metadata } =
    await operationProjection();
  const query = vi
    .spyOn(connection.client, "query")
    .mockResolvedValue({ kind: "operation", value: { operation } });
  metadata([operation.operationId]);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(1),
  );
  query.mockRejectedValue(
    new HostRequestError({
      code: "PERMISSION_DENIED",
      message: "revoked",
      retryable: false,
    }),
  );
  metadata([operation.operationId]);
  await waitFor(() =>
    expect(workspace.getSnapshot().state.operations).toHaveLength(0),
  );
  expect(workspace.getSnapshot().state.operationSummaries[0]?.operationId).toBe(
    operation.operationId,
  );
  expect(workspace.getSnapshot().state.error).toBeNull();
  workspace.dispose();
});

it("loads the authoritative replay session from a successful replay.open operation", async () => {
  const connection = await createHostConnection(port());
  const operationReply = parseReply({
    ok: true,
    result: { operation: fixture("Operation") },
  });
  const sessionReply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (
    !operationReply.ok ||
    !("operation" in operationReply.result) ||
    !sessionReply.ok ||
    !("kind" in sessionReply.result) ||
    sessionReply.result.kind !== "session"
  )
    throw new Error("fixtures");
  const session = {
    ...sessionReply.result.value,
    sessionId: "replay-real",
    readOnly: true,
  };
  const operation = {
    ...operationReply.result.operation,
    actionId: "replay.open",
    state: "succeeded" as const,
    result: {
      kind: "opened" as const,
      value: {
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        revision: session.revision,
        reused: false,
      },
    },
  };
  vi.spyOn(connection.client, "invoke").mockResolvedValue(operation);
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (query) => {
      if (query.actionId === "session.get")
        return { kind: "session", value: session };
      if (query.actionId === "state.scopes")
        return { kind: "scopes", value: { scopes: [] } };
      throw new Error(query.actionId);
    });
  const raw = vi.spyOn(connection.transport, "rawRequest");
  const workspace = createHostWorkspace(connection);
  await workspace.invoke({
    actionId: "replay.open",
    target: { hostId: "host", kind: "capture", id: "selected" },
    params: {},
    executionMode: "interactive",
  });
  await waitFor(() =>
    expect(workspace.getSnapshot().state.sessions).toEqual([session]),
  );
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      actionId: "session.get",
      target: expect.objectContaining({
        id: session.sessionId,
        sessionEpoch: session.sessionEpoch,
      }),
    }),
    expect.any(AbortSignal),
  );
  expect(raw).not.toHaveBeenCalled();
  workspace.dispose();
});

it("uses the native user entry only for explicit connection and deduplicates simultaneous clicks", async () => {
  const connection = await createHostConnection(port());
  const reply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (!reply.ok || !("kind" in reply.result) || reply.result.kind !== "session")
    throw new Error("fixture");
  const session = reply.result.value;
  const userActions = {
    connectDevice: vi.fn().mockResolvedValue(session),
    chooseFile: vi.fn().mockResolvedValue(null),
    applyDocumentIntent: vi.fn(),
  };
  const workspace = createHostWorkspace(connection, userActions);
  await workspace.refresh();
  expect(userActions.connectDevice).not.toHaveBeenCalled();
  const configuration = { ...session.configuration, baudRate: "115200" };
  const first = workspace.trustedConnect(
    session.deviceId,
    undefined,
    configuration,
  );
  const second = workspace.trustedConnect(
    session.deviceId,
    undefined,
    configuration,
  );
  expect(await first).toEqual(session);
  expect(await second).toEqual(session);
  expect(userActions.connectDevice).toHaveBeenCalledExactlyOnceWith(
    connection.generation,
    session.deviceId,
    { configuration },
  );
  expect(workspace.getSnapshot().state.sessions).toEqual([session]);
  vi.spyOn(connection.client, "invoke").mockRejectedValue(
    new HostRequestError({
      code: "PERMISSION_DENIED",
      message: "target revoked",
      retryable: false,
    }),
  );
  await expect(
    workspace.send(
      {
        hostId: "host",
        kind: "session",
        id: session.sessionId,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
      },
      new Uint8Array([1]),
    ),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(userActions.connectDevice).toHaveBeenCalledTimes(1);
  await expect(workspace.pickFile("source")).resolves.toBeNull();
  expect(userActions.chooseFile).toHaveBeenCalledExactlyOnceWith(
    "source",
    connection.generation,
  );
  workspace.dispose();
});

it("discards a late trusted connection result after the provider is disposed", async () => {
  const connection = await createHostConnection(port());
  const reply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (!reply.ok || !("kind" in reply.result) || reply.result.kind !== "session")
    throw new Error("fixture");
  const session = reply.result.value;
  let finish = (_value: typeof session) => {};
  const userActions = {
    connectDevice: vi.fn(
      () =>
        new Promise<typeof session>((resolve) => {
          finish = resolve;
        }),
    ),
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  };
  const workspace = createHostWorkspace(connection, userActions);
  const pending = workspace.trustedConnect(session.deviceId);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  workspace.dispose();
  finish(session);
  await rejected;
  expect(workspace.getSnapshot().state.sessions).toEqual([]);
});

it("keeps a confirmed native open successful when its later metadata refresh fails", async () => {
  const connection = await createHostConnection(port());
  const reply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (!reply.ok || !("kind" in reply.result) || reply.result.kind !== "session")
    throw new Error("fixture");
  const session = reply.result.value;
  const userActions = {
    connectDevice: vi.fn().mockResolvedValue(session),
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  };
  const workspace = createHostWorkspace(connection, userActions);
  await workspace.refresh();
  const error = new HostRequestError({
    code: "STORAGE_IO",
    message: "metadata unavailable",
    retryable: false,
  });
  vi.spyOn(connection.client, "query").mockRejectedValue(error);
  try {
    await expect(workspace.trustedConnect(session.deviceId)).resolves.toEqual(
      session,
    );
    await waitFor(() =>
      expect(workspace.getSnapshot().state.error).toBe(error),
    );
    expect(workspace.getSnapshot().state.sessions).toEqual([session]);
    expect(userActions.connectDevice).toHaveBeenCalledOnce();
  } finally {
    workspace.dispose();
  }
});

it("reads typed operation input through the raw channel without constructing it from summary metadata", async () => {
  const connection = await createHostConnection(port());
  const raw = vi.spyOn(connection.transport, "rawRequest").mockResolvedValue({
    ok: true,
    result: {
      kind: "operation_input",
      value: { kind: "redacted", value: { reason: "sensitive_path" } },
    },
  });
  const workspace = createHostWorkspace(connection);
  await expect(workspace.operationInput("selected-operation")).resolves.toEqual(
    { kind: "redacted", value: { reason: "sensitive_path" } },
  );
  expect(raw).toHaveBeenCalledWith(
    {
      method: "action.query",
      params: expect.objectContaining({
        actionId: "operation.input",
        params: { operationId: "selected-operation" },
        target: connection.hostTarget,
      }),
    },
    expect.any(AbortSignal),
  );
  expect(workspace.getSnapshot().state.operations).toEqual([]);
  workspace.dispose();
});

it("routes typed workspace queries through their registered control and raw channels", async () => {
  const connection = await createHostConnection(port());
  const requests: Query[] = [];
  const response = (query: Query) => {
    requests.push(query);
    return parseReply({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "revoked",
        retryable: false,
      },
    });
  };
  const control = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (query) => {
      const reply = response(query);
      if (!reply.ok) throw new HostRequestError(reply.error);
      if (!("kind" in reply.result)) throw new Error("fixture");
      return reply.result;
    });
  const raw = vi
    .spyOn(connection.transport, "rawRequest")
    .mockImplementation(async (request) => {
      if (request.method !== "action.query") throw new Error("query required");
      return response(request.params);
    });
  const workspace = createHostWorkspace(connection);
  const signal = new AbortController().signal;
  const ref: ObjectRef = {
    hostId: connection.attachment.hostId,
    kind: "capture",
    id: "selected-capture",
  };
  await expect(workspace.metrics(signal)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(workspace.captureStatus(ref, signal)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    workspace.readFile({ fileRef: ref, offset: "0", maxBytes: "1024" }, signal),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(
    workspace.readFileReceipts(
      {
        receiptsRef: { ...ref, kind: "transfer_receipts" },
        startOrdinal: "0",
        maxReceipts: "10",
        maxBytes: "1024",
      },
      signal,
    ),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(
    workspace.readReplay(
      {
        sessionId: "replay-session",
        sessionEpoch: "8",
        maxRecords: "10",
        maxBytes: "1024",
      },
      signal,
    ),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(control.mock.calls.map(([query]) => query.actionId)).toEqual([
    "host.metrics",
    "capture.status",
  ]);
  expect(raw.mock.calls.map(([request]) => request.method)).toEqual([
    "action.query",
    "action.query",
    "action.query",
  ]);
  expect(requests.map((query) => query.actionId)).toEqual([
    "host.metrics",
    "capture.status",
    "file.read",
    "transfer.receiptsRead",
    "replay.read",
  ]);
  expect(requests[4]?.target).toEqual({
    hostId: ref.hostId,
    kind: "session",
    id: "replay-session",
    sessionId: "replay-session",
    sessionEpoch: "8",
  });
  expect(
    raw.mock.calls.every(([, actualSignal]) => actualSignal === signal),
  ).toBe(true);
  workspace.dispose();
});
function workspaceFixture(): WorkspaceDocumentResult {
  const reply = parseReply({
    ok: true,
    result: { kind: "workspace", value: fixture("WorkspaceDocumentResult") },
  });
  if (
    !reply.ok ||
    !("kind" in reply.result) ||
    reply.result.kind !== "workspace"
  )
    throw new Error("fixture");
  return {
    ...reply.result.value,
    scope: {
      ...reply.result.value.scope,
      target: { hostId: "host", kind: "workspace", id: "chosen" },
    },
  };
}
function workspaceOperation(
  base: ReturnType<typeof workspaceFixture>,
  state: "queued" | "succeeded" | "failed" = "succeeded",
) {
  const reply = parseReply({
    ok: true,
    result: { operation: fixture("Operation") },
  });
  if (!reply.ok || !("operation" in reply.result)) throw new Error("fixture");
  const receipt = {
    ...base,
    document: {
      ...base.document,
      revision: (BigInt(base.document.revision) + 1n).toString(),
    },
  };
  return {
    ...reply.result.operation,
    actionId: "workspace.save",
    executionHostId: "host",
    target: base.scope.target,
    state,
    result: { kind: "workspace" as const, value: receipt },
  };
}

function captureStatusFixture(reference: ObjectRef): CaptureStatusResult {
  return {
    captureRef: reference,
    summary: {
      captureId: reference.id,
      state: "complete",
      containerComplete: true,
      sourceContinuous: true,
      watermarks: {
        written: "100",
        flushed: "100",
        synced: "100",
        verified: "100",
      },
    },
  };
}

it.each(["host", "kind", "id", "revision"] as const)(
  "rejects a capture status from a different %s before it can become a stop target",
  async (mismatch) => {
    const connection = await createHostConnection(port());
    const reference: ObjectRef = {
      hostId: "host",
      kind: "capture",
      id: "selected",
      revision: "3",
    };
    const returned: ObjectRef = {
      ...reference,
      ...(mismatch === "host" ? { hostId: "other" } : {}),
      ...(mismatch === "kind" ? { kind: "file" } : {}),
      ...(mismatch === "id" ? { id: "other" } : {}),
      ...(mismatch === "revision" ? { revision: "4" } : {}),
    };
    vi.spyOn(connection.client, "query").mockResolvedValue({
      kind: "capture_status",
      value: captureStatusFixture(returned),
    });
    const workspace = createHostWorkspace(connection);
    try {
      await expect(workspace.captureStatus(reference)).rejects.toThrow(
        "Invalid Host RPC reply",
      );
    } finally {
      workspace.dispose();
    }
  },
);

it("accepts the current capture status revision when the caller did not request a fixed revision", async () => {
  const connection = await createHostConnection(port());
  const reference: ObjectRef = {
    hostId: "host",
    kind: "capture",
    id: "selected",
  };
  const current = captureStatusFixture({ ...reference, revision: "4" });
  vi.spyOn(connection.client, "query").mockResolvedValue({
    kind: "capture_status",
    value: current,
  });
  const workspace = createHostWorkspace(connection);
  try {
    await expect(workspace.captureStatus(reference)).resolves.toEqual(current);
  } finally {
    workspace.dispose();
  }
});

it("attaches verified terminal operation identity while preserving its HostRequestError", async () => {
  const connection = await createHostConnection(port());
  const base = workspaceFixture();
  const terminal = {
    ...workspaceOperation(base, "failed"),
    error: { code: "STORAGE_IO", message: "write failed", retryable: false },
  };
  vi.spyOn(connection.client, "query").mockResolvedValue({
    kind: "operation",
    value: { operation: terminal },
  });
  const workspace = createHostWorkspace(connection);
  try {
    const error: unknown = await workspace
      .waitForOperation(workspaceOperation(base, "queued"))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HostRequestError);
    expect(error).toMatchObject({
      code: "STORAGE_IO",
      executionHostId: terminal.executionHostId,
      operationId: terminal.operationId,
    });
  } finally {
    workspace.dispose();
  }
});

it("keeps an operation-wait RPC failure free of terminal operation identity", async () => {
  const connection = await createHostConnection(port());
  const rpcError = new HostRequestError({
    code: "HOST_START_FAILED",
    message: "connection closed",
    retryable: false,
  });
  vi.spyOn(connection.client, "query").mockRejectedValue(rpcError);
  const workspace = createHostWorkspace(connection);
  try {
    const error: unknown = await workspace
      .waitForOperation(workspaceOperation(workspaceFixture(), "queued"))
      .catch((reason: unknown) => reason);
    expect(error).toBe(rpcError);
    expect(error).not.toHaveProperty("operationId");
    expect(error).not.toHaveProperty("executionHostId");
  } finally {
    workspace.dispose();
  }
});

it.each(["operationId", "target"] as const)(
  "does not attach terminal identity from a mismatched operation %s",
  async (mismatch) => {
    const connection = await createHostConnection(port());
    const initial = workspaceOperation(workspaceFixture(), "queued");
    const terminal = {
      ...initial,
      state: "failed" as const,
      error: { code: "STORAGE_IO", message: "write failed", retryable: false },
      ...(mismatch === "operationId"
        ? { operationId: "other" }
        : { target: { ...initial.target, id: "other" } }),
    };
    vi.spyOn(connection.client, "query").mockResolvedValue({
      kind: "operation",
      value: { operation: terminal },
    });
    const workspace = createHostWorkspace(connection);
    try {
      const error: unknown = await workspace
        .waitForOperation(initial)
        .catch((reason: unknown) => reason);
      expect(error).not.toBeInstanceOf(HostRequestError);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("operationId");
      expect(error).not.toHaveProperty("executionHostId");
    } finally {
      workspace.dispose();
    }
  },
);

it("exposes the real catalog and stale devices without inventing global write permission", async () => {
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "device.list"
    )
      return {
        ok: true,
        result: { kind: "devices", value: { devices: [], stale: true } },
      };
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  await workspace.refresh();
  expect(workspace.getSnapshot().state.devicesStale).toBe(true);
  expect(workspace.getSnapshot().state.catalog).toEqual([]);
  expect(workspace.getSnapshot().state).not.toHaveProperty("readOnly");
  workspace.dispose();
});

it("checks the exact action and complete target and rejects a receipt for an older epoch", async () => {
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  let epoch = "2";
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    )
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: {
            actionId: "session.tx",
            target: { ...request.params.target, sessionEpoch: epoch },
            allowed: false,
          },
        },
      };
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const input = {
    actionId: "session.tx",
    target: {
      hostId: "host",
      kind: "session",
      id: "s",
      sessionId: "s",
      sessionEpoch: "2",
    },
    params: { bytesBase64: "AQ==", writeWaitMs: "0" },
  };
  await expect(workspace.checkAction(input)).resolves.toEqual({
    actionId: "session.tx",
    target: input.target,
    allowed: false,
  });
  epoch = "1";
  await expect(workspace.checkAction(input)).rejects.toThrow();
  workspace.dispose();
});

it("refreshes visible target rights after revocation even when catalog remains unchanged", async () => {
  vi.useFakeTimers();
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  let allowed = true;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    )
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: {
            actionId: "session.tx",
            target: request.params.target,
            allowed,
          },
        },
      };
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const observed: (boolean | null)[] = [];
  const stop = workspace.watchActions(
    [
      {
        actionId: "session.tx",
        target: {
          hostId: "host",
          kind: "session",
          id: "s",
          sessionId: "s",
          sessionEpoch: "2",
        },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.at(-1)).toBe(true);
  allowed = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(observed.at(-1)).toBe(false);
  expect(observed).toEqual([null, true, false]);
  stop();
  const calls = native.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(native.request.mock.calls.length).toBe(calls);
  workspace.dispose();
  vi.useRealTimers();
});

it("keeps an existing unexpired action observation while unrelated controls subscribe and unsubscribe", async () => {
  vi.useFakeTimers();
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    ) {
      const actionId = request.params.params.actionId;
      if (typeof actionId !== "string")
        throw new Error("fixture action required");
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: { actionId, target: request.params.target, allowed: true },
        },
      };
    }
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const target = {
    hostId: "host",
    kind: "session",
    id: "s",
    sessionId: "s",
    sessionEpoch: "2",
  };
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      { actionId: "session.close", target, params: {} },
      { actionId: "session.close", target, params: {} },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    expect(
      native.request.mock.calls.filter(
        ([request]) =>
          request.method === "action.query" &&
          request.params.actionId === "action.check",
      ),
    ).toHaveLength(1);
    const stopOther = workspace.watchActions(
      [{ actionId: "session.tx", target, params: {} }],
      () => {},
    );
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    stopOther();
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.slice(1)).not.toContain(null);
  } finally {
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("does not extend existing action validity while a newly visible control is slow", async () => {
  vi.useFakeTimers();
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closeChecked = false;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    ) {
      const actionId = request.params.params.actionId;
      if (typeof actionId !== "string")
        throw new Error("fixture action required");
      if (actionId === "session.tx" || closeChecked) await gate;
      if (actionId === "session.close") closeChecked = true;
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: { actionId, target: request.params.target, allowed: true },
        },
      };
    }
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const target = {
    hostId: "host",
    kind: "session",
    id: "s",
    sessionId: "s",
    sessionEpoch: "2",
  };
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [{ actionId: "session.close", target, params: {} }],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  try {
    await vi.advanceTimersByTimeAsync(400);
    expect(observed.at(-1)).toBe(true);
    workspace.watchActions(
      [{ actionId: "session.tx", target, params: {} }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(observed.at(-1)).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
  } finally {
    release();
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("discards an old target observer's late grant while a new target checks independently", async () => {
  vi.useFakeTimers();
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  let release: (() => void) | undefined;
  let active = 0;
  let peak = 0;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    ) {
      active++;
      peak = Math.max(peak, active);
      if (request.params.target.sessionEpoch === "1")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      active--;
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: {
            actionId: "session.tx",
            target: request.params.target,
            allowed: request.params.target.sessionEpoch === "1",
          },
        },
      };
    }
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const old = vi.fn();
  const target = {
    hostId: "host",
    kind: "session",
    id: "s",
    sessionId: "s",
    sessionEpoch: "1",
  };
  const stop = workspace.watchActions(
    [{ actionId: "session.tx", target, params: {} }],
    old,
  );
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      {
        actionId: "session.tx",
        target: { ...target, sessionEpoch: "2" },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(2000);
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(old).toHaveBeenCalledTimes(1);
  expect(observed.at(-1)).toBe(false);
  expect(observed).not.toContain(true);
  expect(peak).toBe(2);
  workspace.dispose();
  vi.useRealTimers();
});

it("uses the first explicit Native save and returns its terminal receipt without a later workspace read", async () => {
  const connection = await createHostConnection(port());
  const base = workspaceFixture();
  const queued = workspaceOperation(base, "queued");
  const receipt = workspaceOperation(base);
  const applyDocumentIntent = vi.fn().mockResolvedValue(queued);
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (query) => {
      if (query.actionId === "operation.get")
        return { kind: "operation", value: { operation: receipt } };
      throw new Error(`Unexpected follow-up ${query.actionId}`);
    });
  const invoke = vi.spyOn(connection.client, "invoke");
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi.fn(),
    chooseFile: vi.fn(),
    applyDocumentIntent,
  });
  const candidate = structuredClone(base.document.value);
  const pending = workspace.saveWorkspace(base, candidate);
  let completed = false;
  void pending.then(
    () => {
      completed = true;
    },
    () => {},
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  await expect(pending).resolves.toEqual(receipt.result.value);
  expect(applyDocumentIntent).toHaveBeenCalledExactlyOnceWith(
    connection.generation,
    {
      kind: "workspaceSave",
      workspaceId: "chosen",
      expectedRevision: base.document.revision,
      params: { value: candidate },
    },
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(query.mock.calls.map(([query]) => query.actionId)).toEqual([
    "operation.get",
  ]);
  workspace.dispose();
});

it.each(["failed", "cancelled", "interrupted", "unknown"] as const)(
  "never confirms a %s workspace operation",
  async (state) => {
    const connection = await createHostConnection(port());
    const base = workspaceFixture();
    const operation = { ...workspaceOperation(base), state };
    const workspace = createHostWorkspace(connection, {
      connectDevice: vi.fn(),
      chooseFile: vi.fn(),
      applyDocumentIntent: vi.fn().mockResolvedValue(operation),
    });
    await expect(
      workspace.saveWorkspace(base, base.document.value),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      executionHostId: operation.executionHostId,
      operationId: operation.operationId,
    });
    expect(workspace.getSnapshot().state.workspace).toBeUndefined();
    workspace.dispose();
  },
);

it("aborts workspace waiting without resending or treating a late receipt as saved", async () => {
  const connection = await createHostConnection(port());
  const base = workspaceFixture();
  const applyDocumentIntent = vi
    .fn()
    .mockResolvedValue(workspaceOperation(base, "queued"));
  const invoke = vi.spyOn(connection.client, "invoke");
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi.fn(),
    chooseFile: vi.fn(),
    applyDocumentIntent,
  });
  const abort = new AbortController();
  const pending = workspace.saveWorkspace(
    base,
    base.document.value,
    abort.signal,
  );
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  abort.abort();
  await failed;
  expect(workspace.getSnapshot().state.workspace).toBeUndefined();
  expect(applyDocumentIntent).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  workspace.dispose();
});

it("keeps fresh action observations usable when the already visible window regains focus", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input) => ({
      kind: "action_check",
      value: { actionId: "session.close", target: input.target, allowed: true },
    }));
  const workspace = createHostWorkspace(connection);
  const observed: (boolean | null)[] = [];
  try {
    workspace.watchActions(
      [
        {
          actionId: "session.close",
          target: {
            hostId: "host",
            kind: "session",
            id: "s",
            sessionId: "s",
            sessionEpoch: "2",
          },
          params: {},
        },
      ],
      (values) => observed.push(values[0]?.result?.allowed ?? null),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    const beforeFocus = observed.length;
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event("focus"));
    expect(observed.slice(beforeFocus)).not.toContain(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    expect(
      query.mock.calls.every(([input]) => input.actionId === "action.check"),
    ).toBe(true);
  } finally {
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("makes independent visible actions ready without a serial permission-check waterfall", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  vi.spyOn(connection.client, "query").mockImplementation(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      kind: "action_check",
      value: {
        actionId: "workspace.save",
        target: input.target,
        allowed: true,
      },
    };
  });
  const workspace = createHostWorkspace(connection);
  let observations: readonly (boolean | null)[] = [];
  try {
    workspace.watchActions(
      ["first", "second", "third"].map((id) => ({
        actionId: "workspace.save",
        target: { hostId: "host", kind: "workspace", id },
        params: {},
      })),
      (values) => {
        observations = values.map((value) => value.result?.allowed ?? null);
      },
    );
    await vi.advanceTimersByTimeAsync(450);
    expect(observations).toEqual([true, true, true]);
  } finally {
    workspace.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
  }
});

it("keeps close permission fresh while the same toolbar's send check is still pending", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closeChecks = 0;
  vi.spyOn(connection.client, "query").mockImplementation(async (input) => {
    const actionId = input.params.actionId;
    if (typeof actionId !== "string") throw new Error("Action required");
    if (actionId === "session.tx") await waiting;
    else closeChecks++;
    return {
      kind: "action_check",
      value: { actionId, target: input.target, allowed: true },
    };
  });
  const workspace = createHostWorkspace(connection);
  let closeAllowed: boolean | null = null;
  try {
    workspace.watchActions(
      ["session.close", "session.tx"].map((actionId) => ({
        actionId,
        target: {
          hostId: "host",
          kind: "session",
          id: "s",
          sessionId: "s",
          sessionEpoch: "2",
        },
        params: {},
      })),
      (values) => {
        closeAllowed = values[0]?.result?.allowed ?? null;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(closeAllowed).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(closeAllowed).toBe(true);
    expect(closeChecks).toBeGreaterThanOrEqual(3);
  } finally {
    release();
    await vi.advanceTimersByTimeAsync(0);
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("bounds independent checks including retired targets until their real reads finish", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inFlight = 0;
  let peak = 0;
  vi.spyOn(connection.client, "query").mockImplementation(async (input) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await waiting;
    inFlight--;
    return {
      kind: "action_check",
      value: {
        actionId: "workspace.save",
        target: input.target,
        allowed: true,
      },
    };
  });
  const workspace = createHostWorkspace(connection);
  const inputs = Array.from({ length: 128 }, (_, index) => ({
    actionId: "workspace.save",
    target: { hostId: "host", kind: "workspace", id: `target-${index}` },
    params: {},
  }));
  try {
    const stop = workspace.watchActions(inputs, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(4);
    stop();
    workspace.watchActions(
      [{ ...inputs[0]!, target: { ...inputs[0]!.target, id: "new-target" } }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(4);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(4);
  } finally {
    release();
    workspace.dispose();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("expires observations while hidden and refreshes on focus without executing an action", async () => {
  vi.useFakeTimers();
  let hidden = false;
  const visibility = vi
    .spyOn(document, "hidden", "get")
    .mockImplementation(() => hidden);
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  let allowed = true;
  native.request.mockImplementation(async (request, generation) => {
    if (
      request.method === "action.query" &&
      request.params.actionId === "action.check"
    )
      return {
        ok: true,
        result: {
          kind: "action_check",
          value: {
            actionId: "session.tx",
            target: request.params.target,
            allowed,
          },
        },
      };
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      {
        actionId: "session.tx",
        target: {
          hostId: "host",
          kind: "session",
          id: "s",
          sessionId: "s",
          sessionEpoch: "2",
        },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.at(-1)).toBe(true);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(observed.at(-1)).toBe(true);
  const requests = native.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(observed.at(-1)).toBeNull();
  expect(native.request.mock.calls.length).toBe(requests);
  hidden = false;
  allowed = false;
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.at(-1)).toBe(false);
  expect(
    native.request.mock.calls.every(
      ([request]) => request.method === "action.query",
    ),
  ).toBe(true);
  workspace.dispose();
  visibility.mockRestore();
  vi.useRealTimers();
});

it("invalidates target observations after a failed explicit Native connection too", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => ({
    kind: "action_check",
    value: { actionId: "session.tx", target: query.target, allowed: true },
  }));
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi
      .fn()
      .mockRejectedValue(new Error("failed after native admission")),
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  });
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      {
        actionId: "session.tx",
        target: {
          hostId: "host",
          kind: "session",
          id: "s",
          sessionId: "s",
          sessionEpoch: "2",
        },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual([null, true]);
  await expect(workspace.trustedConnect("d")).rejects.toThrow(
    "failed after native admission",
  );
  expect(observed.slice(2)).toContain(null);
  workspace.dispose();
  vi.useRealTimers();
});

it.each([
  "action",
  "host",
  "target",
  "epoch",
  "result",
  "revision",
  "operationId",
] as const)(
  "rejects a workspace receipt with mismatched %s",
  async (mismatch) => {
    const connection = await createHostConnection(port());
    const base = workspaceFixture();
    const initial = workspaceOperation(base, "queued");
    let terminal = workspaceOperation(base);
    if (mismatch === "action")
      terminal = { ...terminal, actionId: "favorites.save" };
    if (mismatch === "host")
      terminal = { ...terminal, executionHostId: "elsewhere" };
    if (mismatch === "target")
      terminal = {
        ...terminal,
        target: { ...terminal.target, id: "elsewhere" },
      };
    if (mismatch === "epoch")
      terminal = {
        ...terminal,
        target: { ...terminal.target, sessionId: "s", sessionEpoch: "9" },
      };
    if (mismatch === "revision")
      terminal = { ...terminal, result: { kind: "workspace", value: base } };
    if (mismatch === "operationId")
      terminal = { ...terminal, operationId: "different-operation" };
    const response =
      mismatch === "result" ? { ...terminal, result: undefined } : terminal;
    vi.spyOn(connection.client, "query").mockResolvedValue({
      kind: "operation",
      value: { operation: response },
    });
    const workspace = createHostWorkspace(connection, {
      connectDevice: vi.fn(),
      chooseFile: vi.fn(),
      applyDocumentIntent: vi.fn().mockResolvedValue(initial),
    });
    await expect(
      workspace.saveWorkspace(base, base.document.value),
    ).rejects.toThrow();
    expect(workspace.getSnapshot().state.workspace).toBeUndefined();
    workspace.dispose();
  },
);

it("keeps a newly selected workspace while returning the earlier save receipt", async () => {
  const connection = await createHostConnection(port());
  const base = workspaceFixture();
  const terminal = workspaceOperation(base);
  const other = {
    ...base,
    scope: { ...base.scope, target: { ...base.scope.target, id: "other" } },
  };
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const polling = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(connection, "refreshScopes").mockResolvedValue([]);
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    if (query.actionId === "workspace.read")
      return {
        kind: "workspace",
        value: query.target.id === "chosen" ? base : other,
      };
    if (query.actionId === "operation.get") {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "operation", value: { operation: terminal } };
    }
    throw new Error(query.actionId);
  });
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi.fn(),
    chooseFile: vi.fn(),
    applyDocumentIntent: vi
      .fn()
      .mockResolvedValue(workspaceOperation(base, "queued")),
  });
  await workspace.loadWorkspace("chosen");
  const submitted = structuredClone(base.document.value);
  const saved = workspace.saveWorkspace(base, submitted);
  await polling;
  await workspace.loadWorkspace("other");
  release?.();
  await expect(saved).resolves.toEqual(terminal.result.value);
  expect(workspace.getSnapshot().state.workspace?.scope.target.id).toBe(
    "other",
  );
  workspace.dispose();
});

it("uses Host query envelopes for recent, JSON export and import preview without invoking", async () => {
  const native = port();
  const fallback = native.request.getMockImplementation()!;
  const candidate = workspaceFixture().document.value;
  native.request.mockImplementation(async (request, generation) => {
    if (request.method === "action.query") {
      if (request.params.actionId === "recent.list")
        return {
          ok: true,
          result: { kind: "recent", value: { revision: "1", entries: [] } },
        };
      if (request.params.actionId === "workspace.export")
        return {
          ok: true,
          result: { kind: "document_json", value: { json: '{"saved":true}' } },
        };
      if (request.params.actionId === "workspace.importPreview")
        return {
          ok: true,
          result: { kind: "workspace_import_preview", value: candidate },
        };
    }
    return fallback(request, generation);
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  await expect(workspace.recentConnections()).resolves.toEqual({
    revision: "1",
    entries: [],
  });
  await expect(workspace.exportWorkspace("chosen")).resolves.toEqual({
    json: '{"saved":true}',
  });
  await expect(
    workspace.previewWorkspaceImport("chosen", "candidate-json"),
  ).resolves.toEqual(candidate);
  const requests = native.request.mock.calls.map(([request]) => request);
  expect(requests.every((request) => request.method === "action.query")).toBe(
    true,
  );
  expect(requests.at(-1)).toMatchObject({
    method: "action.query",
    params: {
      actionId: "workspace.importPreview",
      target: { hostId: "host", kind: "workspace", id: "chosen" },
      params: { json: "candidate-json" },
    },
  });
  workspace.dispose();
});

it.each(["two watchers", "one watcher"] as const)(
  "renews fast observations independently and discards stale slow replies across %s",
  async (grouping) => {
    vi.useFakeTimers();
    let hidden = true;
    const visibility = vi
      .spyOn(document, "hidden", "get")
      .mockImplementation(() => hidden);
    const native = port();
    const fallback = native.request.getMockImplementation()!;
    let release: (() => void) | undefined;
    let delay = true;
    let allowed = true;
    let inFlight = 0;
    let peak = 0;
    let checks = 0;
    native.request.mockImplementation(async (request, generation) => {
      if (
        request.method === "action.query" &&
        request.params.actionId === "action.check"
      ) {
        checks++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        const receiptAllowed = allowed;
        if (request.params.target.id === "slow" && delay) {
          delay = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        inFlight--;
        return {
          ok: true,
          result: {
            kind: "action_check",
            value: {
              actionId: "workspace.save",
              target: request.params.target,
              allowed: receiptAllowed,
            },
          },
        };
      }
      return fallback(request, generation);
    });
    const workspace = createHostWorkspace(await createHostConnection(native));
    const input = (id: string) => ({
      actionId: "workspace.save",
      target: { hostId: "host", kind: "workspace", id },
      params: {},
    });
    const observed: (boolean | null)[] = [];
    const slowObserved: (boolean | null)[] = [];
    try {
      workspace.watchActions(
        grouping === "two watchers"
          ? [input("fast")]
          : [input("fast"), input("slow")],
        (values) => {
          observed.push(values[0]?.result?.allowed ?? null);
          if (grouping === "one watcher")
            slowObserved.push(values[1]?.result?.allowed ?? null);
        },
      );
      if (grouping === "two watchers")
        workspace.watchActions([input("slow")], (values) =>
          slowObserved.push(values[0]?.result?.allowed ?? null),
        );
      hidden = false;
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(checks).toBe(2);
      if (grouping === "two watchers") expect(observed.at(-1)).toBe(true);
      allowed = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(observed.at(-1)).toBe(false);
      const deadlineIndex = observed.length;
      expect(checks).toBeGreaterThan(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(observed.at(-1)).toBe(false);
      expect(slowObserved).not.toContain(true);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(observed.at(-1)).toBe(false);
      expect(observed.slice(deadlineIndex)).not.toContain(true);
      expect(slowObserved).not.toContain(true);
      expect(peak).toBe(2);
    } finally {
      workspace.dispose();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  },
);

it("reads the selected file metadata through its exact object reference and rejects stale attachment results", async () => {
  const connection = await createHostConnection(port());
  const ref = { hostId: "host", kind: "file", id: "target", revision: "3" };
  const value = {
    fileRef: ref,
    purpose: "capture_target" as const,
    length: "15",
    fingerprint: "a".repeat(64),
  };
  const query = vi
    .spyOn(connection.client, "query")
    .mockResolvedValue({ kind: "file_metadata", value });
  const workspace = createHostWorkspace(connection);
  expect(await workspace.fileMetadata(ref)).toEqual(value);
  expect(query.mock.calls[0]?.[0]).toMatchObject({
    actionId: "file.metadata",
    target: { hostId: "host", kind: "file", id: "target" },
    params: { fileRef: ref },
  });
  query.mockResolvedValueOnce({
    kind: "file_metadata",
    value: { ...value, fileRef: { ...ref, revision: "4" } },
  });
  await expect(workspace.fileMetadata(ref)).rejects.toThrow(
    "Invalid Host RPC reply",
  );
  let resolve!: (
    reply: import("@serial-workbench/contracts").QueryResult,
  ) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = workspace.fileMetadata(ref);
  workspace.dispose();
  resolve({ kind: "file_metadata", value });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("queries session observations with exact target epochs and rejects foreign or mismatched snapshots", async () => {
  const connection = await createHostConnection(port());
  const target = {
    hostId: "host",
    kind: "session",
    id: "session",
    sessionId: "session",
    sessionEpoch: "1",
  };
  const sample: import("@serial-workbench/contracts").SessionInputs = {
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "2026-11-08T00:00:00Z",
    sampledMonoNs: "1",
    cts: true,
    dsr: false,
    ri: true,
    cd: false,
  };
  const metrics: import("@serial-workbench/contracts").SessionMetrics = {
    sessionId: "session",
    sessionEpoch: "1",
    instanceEpoch: "7",
    observedAt: "2026-11-08T00:00:00Z",
    observedMonoNs: "1",
    connectionDurationMs: "1",
    rxBytes: "5",
    txAcceptedBytes: "2",
    txUnknownBytes: "1",
    rxReadErrors: "0",
    txWriteErrors: "0",
    rxBytesPerSecond: "5",
    txAcceptedBytesPerSecond: "2",
    rateWindowMs: "1000",
    rateResolutionMs: "10",
    lineErrorsAvailable: false,
    frameCountsAvailable: false,
  };
  const query = vi
    .spyOn(connection.client, "query")
    .mockResolvedValueOnce({ kind: "session_inputs", value: sample })
    .mockResolvedValueOnce({ kind: "session_metrics", value: metrics });
  const workspace = createHostWorkspace(connection);
  expect(await workspace.sessionInputs(target)).toEqual(sample);
  expect(await workspace.sessionMetrics(target)).toEqual(metrics);
  expect(
    query.mock.calls.map(([input]) => ({
      actionId: input.actionId,
      target: input.target,
      params: input.params,
    })),
  ).toEqual([
    { actionId: "session.inputs", target, params: {} },
    { actionId: "session.metrics", target, params: {} },
  ]);
  query.mockResolvedValueOnce({
    kind: "session_inputs",
    value: { ...sample, sessionEpoch: "2" },
  });
  await expect(workspace.sessionInputs(target)).rejects.toThrow(
    "Invalid Host RPC reply",
  );
  query.mockResolvedValueOnce({
    kind: "session_metrics",
    value: { ...metrics, instanceEpoch: "8" },
  });
  await expect(workspace.sessionMetrics(target)).rejects.toThrow(
    "Invalid Host RPC reply",
  );
  await expect(
    workspace.sessionMetrics({ ...target, hostId: "foreign" }),
  ).rejects.toThrow("Invalid Host RPC reply");
  expect(query).toHaveBeenCalledTimes(4);
  query.mockRejectedValueOnce(
    new HostRequestError({
      code: "PERMISSION_DENIED",
      message: "revoked",
      retryable: false,
    }),
  );
  await expect(workspace.sessionInputs(target)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  workspace.dispose();
});

it("renews healthy capture observations across periods without synthetic unknown or another Raw tail", async () => {
  vi.useFakeTimers();
  const native = port();
  const reference = {
    hostId: "host",
    kind: "capture",
    id: "healthy-tail",
    revision: "3",
  };
  const reply = parseReply({
    ok: true,
    result: { kind: "capture_tail", value: fixture("CaptureTailResult") },
  });
  if (
    !reply.ok ||
    !("kind" in reply.result) ||
    reply.result.kind !== "capture_tail"
  )
    throw new Error("tail fixture");
  native.rawRequest.mockResolvedValue({
    ok: true,
    result: {
      kind: "capture_tail",
      value: { ...reply.result.value, captureRef: reference },
    },
  });
  const connection = await createHostConnection(native);
  const checks = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (query) => ({
      kind: "action_check",
      value: { actionId: "capture.tail", target: query.target, allowed: true },
    }));
  const workspace = createHostWorkspace(connection);
  const observed: (boolean | null)[] = [];
  const watch: typeof workspace.watchActions = (inputs, listener) =>
    workspace.watchActions(inputs, (values) => {
      observed.push(values[0]?.result?.allowed ?? null);
      listener(values);
    });
  const view = render(
    <CaptureTailPanel
      reference={reference}
      scopeKey="healthy"
      ready
      watchActions={watch}
      read={workspace.readCaptureTail}
      labels={workbenchLabels}
    />,
  );
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(native.rawRequest).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", {
        name: workbenchLabels.captureTail + " · " + workbenchLabels.expand,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: workbenchLabels.captureTail }),
    ).toBeInTheDocument();
    for (let period = 0; period < 5; period++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    expect(observed[0]).toBeNull();
    expect(observed.slice(1).every((value) => value === true)).toBe(true);
    expect(checks.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(native.rawRequest).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("dialog", { name: workbenchLabels.captureTail }),
    ).toBeInTheDocument();
    view.unmount();
    const count = checks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(checks).toHaveBeenCalledTimes(count);
  } finally {
    view.unmount();
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("expires a hung early renewal at the original deadline and rejects its late allow sequentially", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  let checks = 0,
    active = 0,
    peak = 0,
    allowed = true;
  let release!: () => void;
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    checks++;
    active++;
    peak = Math.max(peak, active);
    const granted = allowed;
    if (checks === 2) await new Promise<void>((resolve) => (release = resolve));
    active--;
    return {
      kind: "action_check",
      value: {
        actionId: "workspace.save",
        target: query.target,
        allowed: granted,
      },
    };
  });
  const workspace = createHostWorkspace(connection);
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      {
        actionId: "workspace.save",
        target: { hostId: "host", kind: "workspace", id: "same" },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toBe(2);
    allowed = false;
    await vi.advanceTimersByTimeAsync(499);
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.at(-1)).toBeNull();
    const expired = observed.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(checks).toBe(2);
    expect(observed.at(-1)).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(false);
    expect(observed.slice(expired)).not.toContain(true);
    expect(peak).toBe(1);
  } finally {
    workspace.dispose();
    vi.useRealTimers();
  }
});

it("clears an observation when an early renewal fails instead of keeping its allow", async () => {
  vi.useFakeTimers();
  const connection = await createHostConnection(port());
  let checks = 0;
  vi.spyOn(connection.client, "query").mockImplementation(async (query) => {
    if (++checks > 1) throw new Error("permission check unavailable");
    return {
      kind: "action_check",
      value: {
        actionId: "workspace.save",
        target: query.target,
        allowed: true,
      },
    };
  });
  const workspace = createHostWorkspace(connection);
  const observed: (boolean | null)[] = [];
  workspace.watchActions(
    [
      {
        actionId: "workspace.save",
        target: { hostId: "host", kind: "workspace", id: "same" },
        params: {},
      },
    ],
    (values) => observed.push(values[0]?.result?.allowed ?? null),
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(checks).toBe(2);
    expect(observed.at(-1)).toBeNull();
  } finally {
    workspace.dispose();
    vi.useRealTimers();
  }
});
