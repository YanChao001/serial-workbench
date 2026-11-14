import { parseWireFrame } from "@serial-workbench/contracts";
import { describe, expect, it, vi } from "vitest";
import { parseReply } from "@serial-workbench/contracts";
import * as contracts from "@serial-workbench/contracts";
import type {
  AttachResult,
  Query,
  WireFrame,
} from "@serial-workbench/contracts";
import {
  createNativeTransport,
  createHostConnection,
  HostProjectionError,
} from "./host-client";
import type { HostNativePort } from "./host-client";
import { HostRequestError } from "@serial-workbench/host-client";

const attachment: AttachResult = {
  hostId: "host",
  instanceEpoch: "7",
  protocolVersion: "0.1",
  catalogVersion: "1",
  actorId: "actor",
  clientId: "client",
  requestContext: "signed-context",
  requestContextAcceptUntil: "2026-11-08T00:00:00Z",
  limits: {
    maxRequestBytes: "1000",
    maxPageItems: "100",
    maxBatchBytes: "1000",
    maxReaderQueueBytes: "1000",
    resultRetentionMs: "1000",
    maxLeaseTtlMs: "1000",
  },
};
const query: Query = {
  protocolVersion: "0.1",
  hostId: "host",
  instanceEpoch: "7",
  actorId: "actor",
  requestId: "00000000-0000-0000-0000-000000000001",
  actionId: "state.subscribe",
  target: { hostId: "host", kind: "host", id: "host" },
  params: {},
  revealTarget: { pageId: "workbench" },
};
const frame: WireFrame = {
  channel: "state",
  requestId: "00000000-0000-0000-0000-000000000001",
  body: {
    type: "subscriptionEnded",
    subscriptionId: "real-id",
    error: { code: "PERMISSION_DENIED", message: "revoked", retryable: false },
  },
};
function setup() {
  let deliver: (frame: WireFrame) => void = () => {};
  let finish: (id: string) => void = () => {};
  const port: HostNativePort = {
    attachment: vi.fn().mockResolvedValue({ attachment, generation: "8" }),
    request: vi.fn(),
    rawRequest: vi.fn(),
    subscribe: vi.fn((_query, callback) => {
      deliver = callback;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    rawUnsubscribe: vi.fn().mockResolvedValue(undefined),
    rawSubscribe: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
  };
  return {
    port,
    deliver: (value = frame) => deliver(value),
    finish: (id = "real-id") => finish(id),
  };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("Host scope directory epoch classification", () => {
  it.each(["catalog", "wrong-kind", "probe-failed"])(
    "classifies a directory epoch only after an unchanged original attachment returns catalog: %s",
    async (probeResult) => {
      const { port } = setup();
      const desktop = {
        attachment: { ...attachment, limits: { ...attachment.limits } },
        generation: "8",
      };
      vi.mocked(port.attachment).mockResolvedValue(desktop);
      const directoryError = {
        code: "EPOCH_MISMATCH",
        message: "original directory epoch",
        retryable: false,
      };
      vi.mocked(port.request).mockImplementation(async (request) => {
        if (request.method !== "action.query")
          throw new Error("read-only probe");
        if (request.params.actionId === "state.scopes")
          return parseReply({ ok: false, error: directoryError });
        expect(request.params).toMatchObject({
          actionId: "catalog.list",
          hostId: "host",
          instanceEpoch: "7",
          target: { hostId: "host", kind: "host", id: "host" },
          params: { pageSize: "1" },
        });
        if (probeResult === "probe-failed")
          return parseReply({
            ok: false,
            error: { ...directoryError, message: "probe instance failed" },
          });
        return parseReply({
          ok: true,
          result:
            probeResult === "catalog"
              ? { kind: "catalog", value: { catalogVersion: "1", items: [] } }
              : { kind: "devices", value: { devices: [], stale: false } },
        });
      });
      const connection = await createHostConnection(port);
      try {
        const failure: unknown = await connection
          .refreshScopes()
          .catch((error: unknown) => error);
        if (probeResult === "catalog") {
          expect(failure).toBeInstanceOf(HostProjectionError);
          expect(failure).toMatchObject({
            code: "EPOCH_MISMATCH",
            cause: {
              code: "EPOCH_MISMATCH",
              message: "original directory epoch",
            },
          });
          if (!(failure instanceof HostProjectionError))
            throw new Error("projection failure expected");
          expect(failure.cause).toBeInstanceOf(HostRequestError);
        } else {
          expect(failure).toBeInstanceOf(HostRequestError);
          expect(failure).not.toBeInstanceOf(HostProjectionError);
          expect(failure).toMatchObject({
            code: "EPOCH_MISMATCH",
            message: "original directory epoch",
          });
        }
        expect(port.request).toHaveBeenCalledTimes(2);
        expect(port.attachment).toHaveBeenCalledOnce();
        expect(port.subscribe).not.toHaveBeenCalled();
        expect(port.rawRequest).not.toHaveBeenCalled();
        expect(port.rawSubscribe).not.toHaveBeenCalled();
      } finally {
        connection.dispose();
      }
    },
  );

  it.each(["generation", "instanceEpoch"])(
    "preserves the directory failure when the original %s changes during its probe",
    async (changed) => {
      const { port } = setup();
      const desktop = {
        attachment: { ...attachment, limits: { ...attachment.limits } },
        generation: "8",
      };
      vi.mocked(port.attachment).mockResolvedValue(desktop);
      let finish: ((reply: ReturnType<typeof parseReply>) => void) | undefined;
      vi.mocked(port.request).mockImplementation(async (request) => {
        if (request.method !== "action.query")
          throw new Error("read-only probe");
        if (request.params.actionId === "state.scopes")
          return parseReply({
            ok: false,
            error: {
              code: "EPOCH_MISMATCH",
              message: "original directory epoch",
              retryable: false,
            },
          });
        expect(request.params.actionId).toBe("catalog.list");
        return new Promise<ReturnType<typeof parseReply>>((resolve) => {
          finish = resolve;
        });
      });
      const connection = await createHostConnection(port);
      try {
        const waiting = connection
          .refreshScopes()
          .catch((error: unknown) => error);
        await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
        if (changed === "generation") desktop.generation = "9";
        else desktop.attachment.instanceEpoch = "8";
        finish?.(
          parseReply({
            ok: true,
            result: {
              kind: "catalog",
              value: { catalogVersion: "1", items: [] },
            },
          }),
        );
        const failure: unknown = await waiting;
        expect(failure).toBeInstanceOf(HostRequestError);
        expect(failure).not.toBeInstanceOf(HostProjectionError);
        expect(failure).toMatchObject({
          code: "EPOCH_MISMATCH",
          message: "original directory epoch",
        });
        expect(port.request).toHaveBeenCalledTimes(2);
        expect(port.attachment).toHaveBeenCalledOnce();
        expect(port.subscribe).not.toHaveBeenCalled();
        expect(port.rawRequest).not.toHaveBeenCalled();
      } finally {
        connection.dispose();
      }
    },
  );
});
describe("native Host transport", () => {
  it("validates state frames once at the SDK boundary and rejects an invalid state channel", async () => {
    const { port, deliver, finish } = setup();
    const cursor = {
      hostId: attachment.hostId,
      instanceEpoch: attachment.instanceEpoch,
      scopeId: "host.devices",
      position: "0",
    };
    vi.mocked(port.request).mockResolvedValue({
      ok: true,
      result: {
        kind: "snapshot",
        value: {
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          revision: "1",
          cursor,
          state: {},
        },
      },
    });
    const connection = await createHostConnection(port);
    connection.transport.setScopes([
      { scopeId: cursor.scopeId, target: query.target },
    ]);
    const observed = vi.fn();
    const pending = connection.client.subscribe(cursor.scopeId, observed);
    await vi.waitFor(() => expect(port.subscribe).toHaveBeenCalledOnce());
    finish();
    const unsubscribe = await pending;
    const subscriptionQuery = vi.mocked(port.subscribe).mock.calls[0]![0];
    const delta: WireFrame = {
      channel: "state",
      requestId: subscriptionQuery.requestId,
      body: {
        type: "delta",
        subscriptionId: "real-id",
        delta: {
          cursor: { ...cursor, position: "1" },
          previousCursor: cursor,
          revision: "2",
          eventType: "devices",
          payload: {},
        },
      },
    };
    const validate = vi.spyOn(contracts, "parseWireFrame");
    try {
      deliver(delta);
      expect(observed).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "delta" }),
      );
      expect(validate).toHaveBeenCalledOnce();
      validate.mockClear();
      deliver({ ...delta, channel: "raw" });
      expect(observed).toHaveBeenLastCalledWith({
        type: "error",
        error: expect.objectContaining({ code: "INVALID_STATE_FRAME" }),
      });
      expect(validate).toHaveBeenCalledOnce();
    } finally {
      validate.mockRestore();
      unsubscribe();
      connection.dispose();
    }
  });

  it("waits for the real subscription ID then consumes before acknowledging its generation", async () => {
    expect(parseWireFrame(frame)).toEqual(frame);
    const { port, deliver, finish } = setup();
    const transport = createNativeTransport(
      { attachment, generation: "8" },
      port,
    );
    const received: unknown[] = [];
    const pending = transport.openChannel(query, (value) =>
      received.push(value),
    );
    deliver();
    expect(received).toEqual([]);
    expect(port.ack).not.toHaveBeenCalled();
    finish();
    const channel = await pending;
    expect(channel.subscriptionId).toBe("real-id");
    expect(received).toEqual([frame]);
    expect(port.subscribe).toHaveBeenCalledWith(
      query,
      expect.any(Function),
      "8",
    );
    expect(port.ack).toHaveBeenCalledWith("8", "real-id", "data", "1");
    channel.unsubscribe();
    channel.unsubscribe();
    expect(port.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("closes a subscription created after abort and acknowledges discarded late delivery", async () => {
    expect(parseWireFrame(frame)).toEqual(frame);
    const { port, deliver, finish } = setup();
    const transport = createNativeTransport(
      { attachment, generation: "8" },
      port,
    );
    const controller = new AbortController();
    const received = vi.fn();
    const pending = transport.openChannel(query, received, controller.signal);
    controller.abort();
    deliver();
    finish();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(received).not.toHaveBeenCalled();
    expect(port.unsubscribe).toHaveBeenCalledWith("real-id", "8");
    expect(port.ack).toHaveBeenCalledWith("8", "real-id", "data", "1");
  });
  it("never resends an invocation on transport failure", async () => {
    const { port } = setup();
    vi.mocked(port.request).mockRejectedValue(new Error("disconnected"));
    const transport = createNativeTransport(
      { attachment, generation: "8" },
      port,
    );
    const request = {
      method: "action.invoke" as const,
      params: { ...query, requestContext: attachment.requestContext },
    };
    await expect(transport.request(request)).rejects.toThrow("disconnected");
    expect(port.request).toHaveBeenCalledTimes(1);
    expect(port.request).toHaveBeenCalledWith(request, "8");
    expect(port.attachment).not.toHaveBeenCalled();
  });
  it("resolves only Host-authorized scope targets and makes fresh requests with issued context", async () => {
    const { port } = setup();
    const target = { hostId: "host", kind: "workspace", id: "actual" };
    vi.mocked(port.request).mockResolvedValue({
      ok: true,
      result: {
        kind: "scopes",
        value: { scopes: [{ scopeId: "opaque-scope", target }] },
      },
    });
    const connection = await createHostConnection(port);
    expect(port.request).not.toHaveBeenCalled();
    await connection.refreshScopes();
    expect(connection.transport.resolveScope("opaque-scope")).toEqual(target);
    expect(() =>
      connection.transport.resolveScope("workspace:guessed"),
    ).toThrow();
    const a = connection.buildCall("workspace.save", target, {});
    const b = connection.buildCall("workspace.save", target, {});
    expect(a.requestContext).toBe("signed-context");
    expect(a.requestId).not.toBe(b.requestId);
  });
});

it("raw data and termination use independent acknowledgements and cleanup", async () => {
  const { port } = setup();
  let data:
    | ((value: import("@serial-workbench/contracts").RawBatch) => void)
    | undefined;
  let lifecycle: ((value: WireFrame) => void) | undefined;
  vi.mocked(port.rawSubscribe).mockImplementation(
    async (_query, onBatch, onLifecycle) => {
      data = onBatch;
      lifecycle = onLifecycle;
      return "raw-id";
    },
  );
  const transport = createNativeTransport(
    { attachment, generation: "8" },
    port,
  );
  const received: unknown[] = [];
  const channel = await transport.openRawChannel(
    query,
    (value) => received.push(value),
    (value) => received.push(value),
  );
  const cursor = {
    hostId: "host",
    instanceEpoch: "7",
    scopeId: "opaque-raw",
    position: "0",
  };
  const batch = {
    subscriptionId: "raw-id",
    cursor,
    previousCursor: cursor,
    items: [],
  };
  data?.(batch);
  const ended: WireFrame = {
    channel: "raw",
    requestId: query.requestId,
    body: {
      type: "subscriptionEnded",
      subscriptionId: "raw-id",
      error: {
        code: "PERMISSION_DENIED",
        message: "revoked",
        retryable: false,
      },
    },
  };
  lifecycle?.(ended);
  expect(received).toEqual([batch, ended]);
  expect(port.ack).toHaveBeenCalledWith("8", "raw-id", "data", "1");
  expect(port.ack).toHaveBeenCalledWith("8", "raw-id", "lifecycle", "1");
  channel.unsubscribe();
  expect(port.rawUnsubscribe).toHaveBeenCalledWith("raw-id", "8");
  expect(port.unsubscribe).not.toHaveBeenCalled();
});

it("coalesces consumption acknowledgements while one acknowledgement is pending", async () => {
  const { port, deliver, finish } = setup();
  let resolveAck: () => void = () => {};
  vi.mocked(port.ack).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveAck = resolve;
      }),
  );
  const transport = createNativeTransport(
    { attachment, generation: "8" },
    port,
  );
  const pending = transport.openChannel(query, () => {});
  finish();
  await pending;
  deliver();
  deliver();
  deliver();
  expect(port.ack).toHaveBeenCalledTimes(1);
  resolveAck();
  await tick();
  expect(port.ack).toHaveBeenCalledTimes(2);
  expect(port.ack).toHaveBeenLastCalledWith("8", "real-id", "data", "3");
  transport.dispose();
});

it("acknowledges every discarded ordinal when abort follows an early buffered frame", async () => {
  const { port, deliver, finish } = setup();
  const transport = createNativeTransport(
    { attachment, generation: "8" },
    port,
  );
  const controller = new AbortController();
  const listener = vi.fn();
  const pending = transport.openChannel(query, listener, controller.signal);
  deliver();
  controller.abort();
  deliver();
  finish();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await tick();
  expect(listener).not.toHaveBeenCalled();
  expect(port.ack).toHaveBeenLastCalledWith("8", "real-id", "data", "2");
});

it("rejects a raw batch whose subscription differs from the native returned ID", async () => {
  const { port } = setup();
  let data:
    | ((value: import("@serial-workbench/contracts").RawBatch) => void)
    | undefined;
  vi.mocked(port.rawSubscribe).mockImplementation(async (_query, onBatch) => {
    data = onBatch;
    return "real-raw";
  });
  const transport = createNativeTransport(
    { attachment, generation: "8" },
    port,
  );
  const received = vi.fn();
  const error = vi.fn();
  await transport.openRawChannel(query, received, () => {}, undefined, error);
  const cursor = {
    hostId: "host",
    instanceEpoch: "7",
    scopeId: "opaque",
    position: "0",
  };
  data?.({
    subscriptionId: "different",
    cursor,
    previousCursor: cursor,
    items: [],
  });
  expect(received).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
  expect(port.rawUnsubscribe).toHaveBeenCalledWith("real-raw", "8");
  expect(port.ack).toHaveBeenCalledWith("8", "real-raw", "data", "1");
});
