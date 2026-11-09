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
import fixtures from "../../packages/contracts/src/generated/fixtures.json";
import { createHostConnection, createHostWorkspace } from "./host-client";
import type { HostNativePort } from "./host-client";

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
  const workspace = createHostWorkspace(connection);
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
    workspace,
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
