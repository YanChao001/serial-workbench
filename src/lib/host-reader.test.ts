import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { parseReply, parseWireFrame } from "@serial-workbench/contracts";
import type {
  Query,
  RawBatch,
  SessionSnapshot,
  WireFrame,
} from "@serial-workbench/contracts";
import type { ProjectionEvent } from "@serial-workbench/host-client";
import { HostRequestError } from "@serial-workbench/host-client";
import fixtures from "../../packages/contracts/src/generated/fixtures.json";
import { createHostConnection, createHostWorkspace } from "./host-client";
import type { HostNativePort } from "./host-client";
import { reportClientError } from "./report-error";
vi.mock("./report-error", () => ({ reportClientError: vi.fn() }));

function fixture(schema: string): unknown {
  const value = fixtures.valid.find((item) => item.schema === schema);
  if (!value) throw new Error(`Fixture missing: ${schema}`);
  return value.value;
}
async function setupReader() {
  const sessionReply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (
    !sessionReply.ok ||
    !("kind" in sessionReply.result) ||
    sessionReply.result.kind !== "session"
  )
    throw new Error("session fixture");
  let session = sessionReply.result.value;
  const attachment = {
    hostId: "host",
    instanceEpoch: "7",
    protocolVersion: "0.1" as const,
    catalogVersion: "1",
    actorId: "actor",
    clientId: "client",
    requestContext: "signed-context",
    requestContextAcceptUntil: "2026-11-08T00:00:00Z",
    limits: {
      maxRequestBytes: "1000000",
      maxPageItems: "100",
      maxBatchBytes: "1000000",
      maxReaderQueueBytes: "1000000",
      resultRetentionMs: "1000",
      maxLeaseTtlMs: "1000",
    },
  };
  const target = () => ({
    hostId: attachment.hostId,
    kind: "session",
    id: session.sessionId,
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
  });
  const cursor = () => ({
    hostId: attachment.hostId,
    instanceEpoch: attachment.instanceEpoch,
    scopeId: "opaque-raw",
    position: "0",
  });
  const deliveries: Array<{
    query: Query;
    batch: (value: RawBatch) => void;
    lifecycle: (value: WireFrame) => void;
    id: string;
  }> = [];
  const native: HostNativePort = {
    attachment: vi.fn().mockResolvedValue({ attachment, generation: "3" }),
    request: vi.fn<HostNativePort["request"]>(async (request) => {
      if (request.method !== "action.query")
        throw new Error("Unexpected invoke");
      const query = request.params;
      if (query.actionId === "state.scopes")
        return {
          ok: true,
          result: {
            kind: "scopes",
            value: { scopes: [{ scopeId: "opaque-state", target: target() }] },
          },
        };
      if (query.actionId === "device.list")
        return {
          ok: true,
          result: { kind: "devices", value: { devices: [], stale: false } },
        };
      if (query.actionId === "catalog.list")
        return {
          ok: true,
          result: {
            kind: "catalog",
            value: { catalogVersion: "1", items: [] },
          },
        };
      if (query.actionId === "workspace.read") {
        const parsed = parseReply({
          ok: true,
          result: {
            kind: "workspace",
            value: fixture("WorkspaceDocumentResult"),
          },
        });
        if (
          !parsed.ok ||
          !("kind" in parsed.result) ||
          parsed.result.kind !== "workspace"
        )
          throw new Error("fixture");
        return {
          ok: true,
          result: {
            kind: "workspace",
            value: {
              ...parsed.result.value,
              scope: { ...parsed.result.value.scope, target: query.target },
            },
          },
        };
      }
      throw new Error(query.actionId);
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    rawUnsubscribe: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    rawRequest: vi.fn<HostNativePort["rawRequest"]>(async (request) => {
      if (request.method !== "action.query") throw new Error("query required");
      const query = request.params;
      if (query.actionId === "stream.cursor")
        return parseReply({
          ok: true,
          result: {
            kind: "stream_cursor",
            value: { target: target(), cursor: cursor() },
          },
        });
      if (query.actionId === "stream.credit")
        return parseReply({
          ok: true,
          result: {
            kind: "stream_credit",
            value: {
              ackCursor: query.params.ackCursor,
              grantedBytesTotal: query.params.grantedBytesTotal,
              sentBytesTotal: "640",
              acknowledgedBytesTotal: "640",
            },
          },
        });
      throw new Error(query.actionId);
    }),
    rawSubscribe: vi.fn(async (query, batch, lifecycle) => {
      const id = `raw-${deliveries.length}`;
      deliveries.push({ query, batch, lifecycle, id });
      return id;
    }),
  };
  const connection = await createHostConnection(native);
  let project: (event: ProjectionEvent) => void = () => {};
  const emitSession = () =>
    project({
      type: "snapshot",
      snapshot: {
        hostId: attachment.hostId,
        instanceEpoch: attachment.instanceEpoch,
        revision: session.revision,
        cursor: { ...cursor(), scopeId: "opaque-state" },
        state: JSON.parse(JSON.stringify(session)),
      },
    });
  vi.spyOn(connection.client, "subscribe").mockImplementation(
    async (_id, listener) => {
      project = listener;
      emitSession();
      return () => {};
    },
  );
  const connectDevice = vi.fn(async () => session);
  const workspace = createHostWorkspace(connection, {
    connectDevice,
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  });
  await workspace.refresh();
  function batch(index: number, previous: string, next: string, count = 1) {
    const delivery = deliveries[index];
    if (!delivery) throw new Error("reader not opened");
    const parsed = parseWireFrame({
      requestId: delivery.query.requestId,
      channel: "raw",
      body: { type: "rawBatch", batch: fixture("RawBatch") },
    });
    if (parsed.body.type !== "rawBatch") throw new Error("raw fixture");
    const item = parsed.body.batch.items[0];
    if (!item || item.kind !== "source") throw new Error("source fixture");
    const value: RawBatch = {
      subscriptionId: delivery.id,
      previousCursor: { ...cursor(), position: previous },
      cursor: { ...cursor(), position: next },
      items: Array.from({ length: count }, (_, offset) => ({
        kind: "source",
        event: {
          ...item.event,
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          eventSeq: (BigInt(previous) + BigInt(offset) + 1n).toString(),
        },
      })),
    };
    delivery.batch(value);
  }
  return {
    connection,
    workspace,
    connectDevice,
    native,
    deliveries,
    batch,
    session,
    updateSession(value: SessionSnapshot) {
      session = value;
      emitSession();
    },
  };
}
describe("Host raw reader owner", () => {
  it.each([
    ["stream.cursor", "EPOCH_MISMATCH"],
    ["stream.cursor", "BACKEND_DISCONNECTED"],
    ["stream.credit", "EPOCH_MISMATCH"],
    ["stream.subscribe", "EPOCH_MISMATCH"],
  ])(
    "confirms normal close after remote %s returns %s before the terminal projection",
    async (action, code) => {
      vi.mocked(reportClientError).mockClear();
      const h = await setupReader();
      const controlSignals: AbortSignal[] = [];
      const requestControl = h.connection.transport.request;
      vi.spyOn(h.connection.transport, "request").mockImplementation(
        (request, signal) => {
          if (
            request.method === "action.query" &&
            request.params.actionId === "session.get" &&
            signal
          )
            controlSignals.push(signal);
          return requestControl(request, signal);
        },
      );
      const originalControl = vi
        .mocked(h.native.request)
        .getMockImplementation()!;
      let finish: (value: ReturnType<typeof parseReply>) => void = () => {};
      const confirmation = vi.fn(
        () =>
          new Promise<ReturnType<typeof parseReply>>((resolve) => {
            finish = resolve;
          }),
      );
      vi.mocked(h.native.request).mockImplementation((request) =>
        request.method === "action.query" &&
        request.params.actionId === "session.get"
          ? confirmation()
          : originalControl(request),
      );
      const originalRaw = vi
        .mocked(h.native.rawRequest)
        .getMockImplementation()!;
      vi.mocked(h.native.rawRequest).mockImplementation(async (request) =>
        request.method === "action.query" && request.params.actionId === action
          ? parseReply({
              ok: false,
              error: {
                code,
                message: "remote source closed",
                retryable: false,
              },
            })
          : originalRaw(request),
      );
      if (action === "stream.subscribe")
        vi.mocked(h.native.rawSubscribe).mockRejectedValue(
          new HostRequestError({
            code,
            message: "remote source closed",
            retryable: false,
          }),
        );
      const stop = h.workspace.watchSession(h.session.sessionId, () => {});
      if (action === "stream.credit") {
        await waitFor(() => expect(h.deliveries).toHaveLength(1));
        h.batch(0, "0", "1");
      }
      await waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
      const old = h.deliveries[0];
      if (old)
        old.lifecycle({
          requestId: old.query.requestId,
          channel: "raw",
          body: {
            type: "subscriptionEnded",
            subscriptionId: old.id,
            error: {
              code: "EPOCH_MISMATCH",
              message: "later terminal",
              retryable: false,
            },
          },
        });
      finish(
        parseReply({
          ok: true,
          result: { kind: "session", value: { ...h.session, state: "closed" } },
        }),
      );
      await waitFor(() => {
        expect(controlSignals[0]?.aborted).toBe(true);
        if (old) expect(h.native.rawUnsubscribe).toHaveBeenCalledWith(old.id);
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toBeNull();
        expect(reportClientError).not.toHaveBeenCalled();
      });
      h.updateSession({ ...h.session, state: "closed", revision: "2" });
      expect(confirmation).toHaveBeenCalledOnce();
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
      ).toHaveLength(action === "stream.credit" ? 1 : 0);
      stop();
      h.workspace.dispose();
    },
  );

  it("quietly retires a closed session without clearing received bytes or reopening Raw", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    h.batch(0, "0", "1");
    h.updateSession({ ...h.session, state: "closed", revision: "2" });
    expect(h.native.rawUnsubscribe).toHaveBeenCalledWith("raw-0");
    const old = h.deliveries[0]!;
    old.lifecycle({
      requestId: old.query.requestId,
      channel: "raw",
      body: {
        type: "subscriptionEnded",
        subscriptionId: old.id,
        error: {
          code: "EPOCH_MISMATCH",
          message: "closed source",
          retryable: false,
        },
      },
    });
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
    ).toMatchObject({ error: null, items: [expect.any(Object)] });
    const secondStop = h.workspace.watchSession(h.session.sessionId, () => {});
    await h.workspace.trustedConnect(h.session.deviceId);
    expect(h.deliveries).toHaveLength(1);
    expect(reportClientError).not.toHaveBeenCalled();
    stop();
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toHaveLength(1);
    secondStop();
    expect(
      h.workspace.getSnapshot().state.streams.has(h.session.sessionId),
    ).toBe(false);
    h.workspace.dispose();
  });

  it("confirms an early Raw terminal against the original session once and retains bytes when closed", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    const fallback = vi.mocked(h.native.request).getMockImplementation()!;
    const confirm = vi.fn(async () =>
      parseReply({
        ok: true,
        result: { kind: "session", value: { ...h.session, state: "closed" } },
      }),
    );
    vi.mocked(h.native.request).mockImplementation((request) =>
      request.method === "action.query" &&
      request.params.actionId === "session.get"
        ? confirm()
        : fallback(request),
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    h.batch(0, "0", "1");
    const old = h.deliveries[0]!;
    const terminal: WireFrame = {
      requestId: old.query.requestId,
      channel: "raw",
      body: {
        type: "subscriptionEnded",
        subscriptionId: old.id,
        error: {
          code: "EPOCH_MISMATCH",
          message: "closed source",
          retryable: false,
        },
      },
    };
    old.lifecycle(terminal);
    old.lifecycle(terminal);
    await waitFor(() =>
      expect(h.native.rawUnsubscribe).toHaveBeenCalledWith("raw-0"),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
    ).toMatchObject({ error: null, items: [expect.any(Object)] });
    expect(reportClientError).not.toHaveBeenCalled();
    stop();
    h.workspace.dispose();
  });

  it("never starts Raw for a session already closed before its first watcher", async () => {
    const h = await setupReader();
    h.updateSession({ ...h.session, state: "closed", revision: "2" });
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await Promise.resolve();
    expect(h.native.rawRequest).not.toHaveBeenCalled();
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
    ).toMatchObject({ error: null, items: [] });
    stop();
    h.workspace.dispose();
  });

  it.each([
    "open",
    "disconnected",
    "wrong-session",
    "wrong-epoch",
    "query-failed",
  ])(
    "preserves the original terminal error when closed cannot be confirmed: %s",
    async (result) => {
      vi.mocked(reportClientError).mockClear();
      const h = await setupReader();
      const fallback = vi.mocked(h.native.request).getMockImplementation()!;
      const confirm = vi.fn(async () => {
        if (result === "query-failed") throw new Error("Control unavailable");
        return parseReply({
          ok: true,
          result: {
            kind: "session",
            value: {
              ...h.session,
              state:
                result === "open" || result === "disconnected"
                  ? result
                  : "closed",
              sessionId:
                result === "wrong-session"
                  ? "another-session"
                  : h.session.sessionId,
              sessionEpoch:
                result === "wrong-epoch" ? "42" : h.session.sessionEpoch,
            },
          },
        });
      });
      vi.mocked(h.native.request).mockImplementation((request) =>
        request.method === "action.query" &&
        request.params.actionId === "session.get"
          ? confirm()
          : fallback(request),
      );
      const stop = h.workspace.watchSession(h.session.sessionId, () => {});
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      const old = h.deliveries[0]!;
      old.lifecycle({
        requestId: old.query.requestId,
        channel: "raw",
        body: {
          type: "subscriptionEnded",
          subscriptionId: old.id,
          error: {
            code: "EPOCH_MISMATCH",
            message: "original terminal",
            retryable: false,
          },
        },
      });
      await waitFor(() => expect(reportClientError).toHaveBeenCalledOnce());
      expect(confirm).toHaveBeenCalledOnce();
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({
        error: { code: "EPOCH_MISMATCH", message: "original terminal" },
        items: [expect.any(Object)],
      });
      stop();
      h.workspace.dispose();
    },
  );

  it.each(["closed-projection", "new-epoch", "unwatch"])(
    "isolates a late terminal confirmation after %s",
    async (change) => {
      vi.mocked(reportClientError).mockClear();
      const h = await setupReader();
      const fallback = vi.mocked(h.native.request).getMockImplementation()!;
      let resolve: (value: ReturnType<typeof parseReply>) => void = () => {};
      const confirm = vi.fn(
        () =>
          new Promise<ReturnType<typeof parseReply>>((done) => {
            resolve = done;
          }),
      );
      vi.mocked(h.native.request).mockImplementation((request) =>
        request.method === "action.query" &&
        request.params.actionId === "session.get"
          ? confirm()
          : fallback(request),
      );
      const stop = h.workspace.watchSession(h.session.sessionId, () => {});
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      const old = h.deliveries[0]!;
      old.lifecycle({
        requestId: old.query.requestId,
        channel: "raw",
        body: {
          type: "subscriptionEnded",
          subscriptionId: old.id,
          error: {
            code: "EPOCH_MISMATCH",
            message: "original terminal",
            retryable: false,
          },
        },
      });
      expect(confirm).toHaveBeenCalledOnce();
      if (change === "unwatch") stop();
      else
        h.updateSession({
          ...h.session,
          revision: "2",
          state: change === "closed-projection" ? "closed" : "open",
          sessionEpoch: change === "new-epoch" ? "42" : h.session.sessionEpoch,
        });
      resolve(
        parseReply({
          ok: true,
          result: {
            kind: "session",
            value: { ...h.session, state: "disconnected" },
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(reportClientError).not.toHaveBeenCalled();
      if (change === "closed-projection")
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
        ).toMatchObject({ error: null, items: [expect.any(Object)] });
      if (change === "new-epoch") {
        await waitFor(() => expect(h.deliveries).toHaveLength(2));
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
        ).toMatchObject({ error: null, items: [] });
      }
      if (change === "unwatch")
        expect(
          h.workspace.getSnapshot().state.streams.has(h.session.sessionId),
        ).toBe(false);
      stop();
      h.workspace.dispose();
    },
  );

  it("reports local Raw batch epoch corruption without querying closed state", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    const delivery = h.deliveries[0]!;
    const consume = delivery.batch;
    delivery.batch = (batch) =>
      consume({
        ...batch,
        items: batch.items.map((item) =>
          item.kind === "source"
            ? { ...item, event: { ...item.event, sessionEpoch: "42" } }
            : item,
        ),
      });
    h.batch(0, "0", "1");
    expect(reportClientError).toHaveBeenCalledOnce();
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
    ).toMatchObject({ code: "EPOCH_MISMATCH" });
    expect(
      vi
        .mocked(h.native.request)
        .mock.calls.some(
          ([request]) =>
            request.method === "action.query" &&
            request.params.actionId === "session.get",
        ),
    ).toBe(false);
    stop();
    h.workspace.dispose();
  });

  it("does not retire a live raw reader when unrelated controls or same-epoch metadata change", async () => {
    const h = await setupReader();
    const fallback = vi.mocked(h.native.request).getMockImplementation()!;
    vi.mocked(h.native.request).mockImplementation(async (request) => {
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
      return fallback(request);
    });
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      const target = {
        hostId: "host",
        kind: "session",
        id: h.session.sessionId,
        sessionId: h.session.sessionId,
        sessionEpoch: h.session.sessionEpoch,
      };
      for (let index = 0; index < 20; index++) {
        const stopAction = h.workspace.watchActions(
          [{ actionId: "session.close", target, params: {} }],
          () => {},
        );
        h.updateSession({
          ...h.session,
          revision: String(BigInt(h.session.revision) + BigInt(index) + 1n),
        });
        await Promise.resolve();
        stopAction();
      }
      expect(h.deliveries).toHaveLength(1);
      expect(h.native.rawUnsubscribe).not.toHaveBeenCalled();
      h.batch(0, "1", "2");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({
        error: null,
        items: [expect.any(Object), expect.any(Object)],
      });
      expect(h.connectDevice).not.toHaveBeenCalled();
    } finally {
      stop();
      h.workspace.dispose();
    }
  });

  it("keeps a real ended raw source stopped through same-epoch metadata and successful Native reauthorization", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      const old = h.deliveries[0]!;
      old.lifecycle({
        requestId: old.query.requestId,
        channel: "raw",
        body: {
          type: "subscriptionEnded",
          subscriptionId: old.id,
          error: {
            code: "SOURCE_ENDED",
            message:
              "source actually ended token=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
            retryable: false,
          },
        },
      });
      h.updateSession({
        ...h.session,
        revision: String(BigInt(h.session.revision) + 1n),
      });
      h.batch(0, "1", "2");
      expect(h.deliveries).toHaveLength(1);
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({
        error: { code: "SOURCE_ENDED" },
        items: [expect.any(Object)],
      });
      expect(h.connectDevice).not.toHaveBeenCalled();
      expect(reportClientError).toHaveBeenCalledOnce();
      expect(vi.mocked(reportClientError).mock.calls[0]?.[0]).toEqual({
        message: "SOURCE_ENDED",
      });
      expect(
        JSON.parse(vi.mocked(reportClientError).mock.calls[0]?.[1] ?? "null"),
      ).toEqual({
        scope: "Host raw reader",
        generation: "3",
        instanceEpoch: "7",
        sessionEpoch: h.session.sessionEpoch,
      });
      await h.workspace.trustedConnect(h.session.deviceId);
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toMatchObject({ code: "SOURCE_ENDED" });
      expect(h.deliveries).toHaveLength(1);
      expect(h.connectDevice).toHaveBeenCalledOnce();
      const nextEpoch = String(BigInt(h.session.sessionEpoch) + 1n);
      h.updateSession({
        ...h.session,
        sessionEpoch: nextEpoch,
        revision: String(BigInt(h.session.revision) + 2n),
      });
      await waitFor(() => expect(h.deliveries).toHaveLength(2));
      expect(h.deliveries[1]?.query.target.sessionEpoch).toBe(nextEpoch);
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toBeNull();
    } finally {
      stop();
      h.workspace.dispose();
    }
  });

  it("waits for pending native authorization before starting an initial Raw query", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    let complete: (value: SessionSnapshot) => void = () => {
      throw new Error("Connect did not begin");
    };
    h.connectDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const opening = h.workspace.trustedConnect(
      h.session.deviceId,
      undefined,
      h.session.configuration,
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      expect(h.native.rawRequest).not.toHaveBeenCalled();
      complete(h.session);
      await opening;
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toBeNull();
      expect(reportClientError).not.toHaveBeenCalled();
      expect(h.connectDevice).toHaveBeenCalledOnce();
    } finally {
      complete(h.session);
      await opening.catch(() => {});
      stop();
      h.workspace.dispose();
    }
  });

  it("defers an early initial denial until the actual pending native authorization settles", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    let deny: (value: ReturnType<typeof parseReply>) => void = () => {
      throw new Error("Raw read did not begin");
    };
    vi.mocked(h.native.rawRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deny = resolve;
        }),
    );
    const changed = vi.fn();
    const stop = h.workspace.watchSession(h.session.sessionId, changed);
    let complete: (value: SessionSnapshot) => void = () => {
      throw new Error("Connect did not begin");
    };
    h.connectDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const opening = h.workspace.trustedConnect(
      h.session.deviceId,
      undefined,
      h.session.configuration,
    );
    try {
      deny(
        parseReply({
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: "Grant is still being established",
            retryable: false,
          },
        }),
      );
      await waitFor(() => expect(changed).toHaveBeenCalled());
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toBeNull();
      expect(reportClientError).not.toHaveBeenCalled();
      expect(h.native.rawRequest).toHaveBeenCalledOnce();
      complete(h.session);
      await opening;
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
    } finally {
      complete(h.session);
      await opening.catch(() => {});
      stop();
      h.workspace.dispose();
    }
  });

  it("does not start Raw work after disposal while native authorization is pending", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    let complete: (value: SessionSnapshot) => void = () => {
      throw new Error("Connect did not begin");
    };
    h.connectDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const opening = h.workspace.trustedConnect(
      h.session.deviceId,
      undefined,
      h.session.configuration,
    );
    const stopped = opening.catch((error: unknown) => error);
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    stop();
    h.workspace.dispose();
    complete(h.session);
    expect(await stopped).toMatchObject({ name: "AbortError" });
    expect(h.native.rawRequest).not.toHaveBeenCalled();
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it("still reports a real denial after the pending native authorization failed", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    let reject: (reason: unknown) => void = () => {
      throw new Error("Connect did not begin");
    };
    h.connectDevice.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    vi.mocked(h.native.rawRequest).mockResolvedValueOnce(
      parseReply({
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "No actual grant",
          retryable: false,
        },
      }),
    );
    const opening = h.workspace.trustedConnect(
      h.session.deviceId,
      undefined,
      h.session.configuration,
    );
    const observed = opening.catch((error: unknown) => error);
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      expect(h.native.rawRequest).not.toHaveBeenCalled();
      const error = new HostRequestError({
        code: "PERMISSION_DENIED",
        message: "Native authorization failed",
        retryable: false,
      });
      reject(error);
      expect(await observed).toBe(error);
      await waitFor(() =>
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toMatchObject({ code: "PERMISSION_DENIED" }),
      );
      expect(reportClientError).toHaveBeenCalledOnce();
      expect(h.deliveries).toHaveLength(0);
    } finally {
      stop();
      h.workspace.dispose();
    }
  });

  it("does not defer a denied reader for another device's pending native authorization", async () => {
    vi.mocked(reportClientError).mockClear();
    const h = await setupReader();
    let complete: (value: SessionSnapshot) => void = () => {
      throw new Error("Connect did not begin");
    };
    h.connectDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const opening = h.workspace.trustedConnect(
      "other-device",
      undefined,
      h.session.configuration,
    );
    const observed = opening.catch((error: unknown) => error);
    vi.mocked(h.native.rawRequest).mockResolvedValueOnce(
      parseReply({
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "No grant for this reader",
          retryable: false,
        },
      }),
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await waitFor(() =>
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toMatchObject({ code: "PERMISSION_DENIED" }),
      );
      expect(reportClientError).toHaveBeenCalledOnce();
      expect(h.deliveries).toHaveLength(0);
    } finally {
      stop();
      h.workspace.dispose();
      complete({ ...h.session, deviceId: "other-device" });
      await observed;
    }
  });

  it("restarts an initially denied reader only after explicit native authorization succeeds", async () => {
    const h = await setupReader();
    vi.mocked(h.native.rawRequest).mockResolvedValueOnce(
      parseReply({
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "No read grant",
          retryable: false,
        },
      }),
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await waitFor(() =>
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toMatchObject({ code: "PERMISSION_DENIED" }),
      );
      h.updateSession({ ...h.session, revision: "2" });
      expect(h.deliveries).toHaveLength(0);
      expect(h.connectDevice).not.toHaveBeenCalled();
      await h.workspace.trustedConnect(
        h.session.deviceId,
        undefined,
        h.session.configuration,
      );
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      expect(h.connectDevice).toHaveBeenCalledWith("3", h.session.deviceId, {
        configuration: h.session.configuration,
      });
      h.batch(0, "0", "1");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({ error: null, items: [expect.any(Object)] });
    } finally {
      stop();
      h.workspace.dispose();
    }
  });

  it("recovers an old initial read denial arriving after explicit native authorization completed", async () => {
    const h = await setupReader();
    let deny!: () => void;
    vi.mocked(h.native.rawRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deny = () =>
            resolve(
              parseReply({
                ok: false,
                error: {
                  code: "PERMISSION_DENIED",
                  message: "old grant snapshot",
                  retryable: false,
                },
              }),
            );
        }),
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await expect(
        h.workspace.trustedConnect(h.session.deviceId),
      ).resolves.toEqual(h.session);
      expect(h.connectDevice).toHaveBeenCalledOnce();
      expect(h.deliveries).toHaveLength(0);
      deny();
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({ error: null, items: [expect.any(Object)] });
      expect(h.connectDevice).toHaveBeenCalledOnce();
    } finally {
      deny();
      stop();
      h.workspace.dispose();
    }
  });

  it("does not accumulate successful authorization marks or keep retrying a real revoked read", async () => {
    const h = await setupReader();
    let deny!: () => void;
    const denied = parseReply({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "revoked",
        retryable: false,
      },
    });
    vi.mocked(h.native.rawRequest)
      .mockResolvedValue(denied)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deny = () => resolve(denied);
          }),
      );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await h.workspace.trustedConnect(h.session.deviceId);
      await h.workspace.trustedConnect(h.session.deviceId);
      deny();
      await waitFor(() =>
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toMatchObject({ code: "PERMISSION_DENIED" }),
      );
      expect(h.native.rawRequest).toHaveBeenCalledTimes(2);
      expect(h.deliveries).toHaveLength(0);
      expect(h.connectDevice).toHaveBeenCalledTimes(2);
    } finally {
      deny();
      stop();
      h.workspace.dispose();
    }
  });

  it("ignores the old initial denial if a newly authorized session changed epoch", async () => {
    const h = await setupReader();
    let deny!: () => void;
    vi.mocked(h.native.rawRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deny = () =>
            resolve(
              parseReply({
                ok: false,
                error: {
                  code: "PERMISSION_DENIED",
                  message: "old epoch",
                  retryable: false,
                },
              }),
            );
        }),
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await h.workspace.trustedConnect(h.session.deviceId);
      const epoch = String(BigInt(h.session.sessionEpoch) + 1n);
      h.updateSession({
        ...h.session,
        sessionEpoch: epoch,
        revision: String(BigInt(h.session.revision) + 1n),
      });
      deny();
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      expect(h.deliveries[0]?.query.target.sessionEpoch).toBe(epoch);
      expect(h.native.rawRequest).toHaveBeenCalledTimes(2);
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toBeNull();
      expect(h.connectDevice).toHaveBeenCalledOnce();
    } finally {
      deny();
      stop();
      h.workspace.dispose();
    }
  });

  it("retains received bytes and its cursor when explicitly recovering a denied same-epoch reader", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    try {
      await waitFor(() => expect(h.deliveries).toHaveLength(1));
      h.batch(0, "0", "1");
      await waitFor(() => expect(h.native.rawRequest).toHaveBeenCalledTimes(3));
      const original = vi.mocked(h.native.rawRequest).getMockImplementation()!;
      vi.mocked(h.native.rawRequest).mockResolvedValue(
        parseReply({
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: "Revoked",
            retryable: false,
          },
        }),
      );
      const old = h.deliveries[0]!;
      old.lifecycle({
        requestId: old.query.requestId,
        channel: "raw",
        body: {
          type: "subscriptionEnded",
          subscriptionId: old.id,
          error: {
            code: "PERMISSION_DENIED",
            message: "Revoked",
            retryable: false,
          },
        },
      });
      await waitFor(() =>
        expect(
          h.workspace.getSnapshot().state.streams.get(h.session.sessionId)
            ?.error,
        ).toMatchObject({ code: "PERMISSION_DENIED" }),
      );
      vi.mocked(h.native.rawRequest).mockImplementation(original);
      await h.workspace.trustedConnect(
        h.session.deviceId,
        undefined,
        h.session.configuration,
      );
      await waitFor(() => expect(h.deliveries).toHaveLength(2));
      expect(h.deliveries[1]?.query.params.after).toMatchObject({
        position: "1",
      });
      h.batch(0, "1", "2");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
      ).toHaveLength(1);
      h.batch(1, "1", "2");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
      ).toMatchObject({
        error: null,
        items: [expect.any(Object), expect.any(Object)],
      });
    } finally {
      stop();
      h.workspace.dispose();
    }
  });
  it("retains a bounded display tail and replenishes Host credit using Host byte accounting", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => {
      const error = h.workspace
        .getSnapshot()
        .state.streams.get(h.session.sessionId)?.error;
      if (error) throw error;
      expect(h.deliveries).toHaveLength(1);
    });
    h.batch(0, "0", "1100", 1100);
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toHaveLength(1024);
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.trimmed,
    ).toBe(true);
    await waitFor(() =>
      expect(h.native.rawRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            actionId: "stream.credit",
            params: expect.objectContaining({ grantedBytesTotal: "1000640" }),
          }),
        }),
      ),
    );
    expect(h.native.ack).toHaveBeenCalledWith("3", "raw-0", "data", "1");
    stop();
    h.workspace.dispose();
  });
  it("switches epoch once for shared views and discards deliveries from the old reader", async () => {
    const h = await setupReader();
    const first = h.workspace.watchSession(h.session.sessionId, () => {});
    const second = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => {
      const error = h.workspace
        .getSnapshot()
        .state.streams.get(h.session.sessionId)?.error;
      if (error) throw error;
      expect(h.deliveries).toHaveLength(1);
    });
    h.batch(0, "0", "1");
    h.updateSession({
      ...h.session,
      sessionEpoch: (BigInt(h.session.sessionEpoch) + 1n).toString(),
      revision: (BigInt(h.session.revision) + 1n).toString(),
    });
    await waitFor(() => expect(h.deliveries).toHaveLength(2));
    expect(h.native.rawUnsubscribe).toHaveBeenCalledWith("raw-0");
    h.batch(0, "1", "2");
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toHaveLength(0);
    h.batch(1, "0", "1");
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toHaveLength(1);
    first();
    expect(h.native.rawUnsubscribe).not.toHaveBeenCalledWith("raw-1");
    second();
    expect(h.native.rawUnsubscribe).toHaveBeenCalledWith("raw-1");
    h.workspace.dispose();
  });
  it("rechecks repeated authorization changes from the last raw cursor without reviving old queues", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    h.batch(0, "0", "1");
    for (let index = 0; index < 5; index++) {
      const old = h.deliveries[index]!;
      old.lifecycle({
        requestId: old.query.requestId,
        channel: "raw",
        body: {
          type: "subscriptionEnded",
          subscriptionId: old.id,
          error: {
            code: "PERMISSION_DENIED",
            message: "Authorization changed",
            retryable: false,
          },
        },
      });
      await waitFor(() => expect(h.deliveries).toHaveLength(index + 2));
      expect(h.deliveries[index + 1]!.query.params.after).toMatchObject({
        position: "1",
      });
      h.batch(index, "1", "2");
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
      ).toHaveLength(1);
    }
    h.batch(5, "1", "2");
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId),
    ).toMatchObject({ error: null, items: expect.any(Array) });
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toHaveLength(2);
    stop();
    h.workspace.dispose();
  });

  it("stops raw delivery when a new permission check is denied", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    vi.mocked(h.native.rawRequest).mockResolvedValue(
      parseReply({
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "Revoked",
          retryable: false,
        },
      }),
    );
    const old = h.deliveries[0]!;
    old.lifecycle({
      requestId: old.query.requestId,
      channel: "raw",
      body: {
        type: "subscriptionEnded",
        subscriptionId: old.id,
        error: {
          code: "PERMISSION_DENIED",
          message: "Authorization changed",
          retryable: false,
        },
      },
    });
    await waitFor(() => expect(h.native.rawRequest).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toMatchObject({ code: "PERMISSION_DENIED" }),
    );
    h.batch(0, "0", "1");
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toEqual([]);
    expect(h.deliveries).toHaveLength(1);
    stop();
    h.workspace.dispose();
  });

  it("rechecks an interrupted recovery cursor query before opening a new raw reader", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => expect(h.deliveries).toHaveLength(1));
    vi.mocked(h.native.rawRequest).mockResolvedValueOnce(
      parseReply({
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "Authorization changed",
          retryable: false,
        },
      }),
    );
    const old = h.deliveries[0]!;
    old.lifecycle({
      requestId: old.query.requestId,
      channel: "raw",
      body: {
        type: "subscriptionEnded",
        subscriptionId: old.id,
        error: {
          code: "PERMISSION_DENIED",
          message: "Authorization changed",
          retryable: false,
        },
      },
    });
    await waitFor(() => expect(h.deliveries).toHaveLength(2));
    expect(h.native.rawRequest).toHaveBeenCalledTimes(3);
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
    ).toBeNull();
    stop();
    h.workspace.dispose();
  });

  it("bounds authorization changes arriving during raw channel setup and releases every reader", async () => {
    const h = await setupReader();
    vi.mocked(h.native.rawSubscribe).mockImplementation(
      async (query, batch, lifecycle) => {
        const id = `raw-${h.deliveries.length}`;
        h.deliveries.push({ query, batch, lifecycle, id });
        lifecycle({
          requestId: query.requestId,
          channel: "raw",
          body: {
            type: "subscriptionEnded",
            subscriptionId: id,
            error: {
              code: "PERMISSION_DENIED",
              message: "Authorization changed",
              retryable: false,
            },
          },
        });
        return id;
      },
    );
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() =>
      expect(
        h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
      ).toMatchObject({ code: "PERMISSION_DENIED" }),
    );
    expect(h.deliveries).toHaveLength(4);
    await waitFor(() =>
      expect(h.native.rawUnsubscribe).toHaveBeenCalledTimes(4),
    );
    stop();
    h.workspace.dispose();
  });

  it("shows the Host lifecycle error without inventing an empty raw batch", async () => {
    const h = await setupReader();
    const stop = h.workspace.watchSession(h.session.sessionId, () => {});
    await waitFor(() => {
      const error = h.workspace
        .getSnapshot()
        .state.streams.get(h.session.sessionId)?.error;
      if (error) throw error;
      expect(h.deliveries).toHaveLength(1);
    });
    const delivery = h.deliveries[0];
    if (!delivery) throw new Error("reader");
    delivery.lifecycle({
      requestId: delivery.query.requestId,
      channel: "raw",
      body: {
        type: "subscriptionEnded",
        subscriptionId: delivery.id,
        error: {
          code: "CURSOR_EXPIRED",
          message: "slow reader",
          retryable: false,
        },
      },
    });
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.error,
    ).toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(
      h.workspace.getSnapshot().state.streams.get(h.session.sessionId)?.items,
    ).toEqual([]);
    expect(h.native.ack).toHaveBeenCalledWith("3", "raw-0", "lifecycle", "1");
    stop();
    h.workspace.dispose();
  });
});
