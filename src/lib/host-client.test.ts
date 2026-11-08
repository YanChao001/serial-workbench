import { parseWireFrame } from "@serial-workbench/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  AttachResult,
  Query,
  WireFrame,
} from "@serial-workbench/contracts";
import { createNativeTransport, createHostConnection } from "./host-client";
import type { HostNativePort } from "./host-client";

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
describe("native Host transport", () => {
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
    expect(port.unsubscribe).toHaveBeenCalledWith("real-id");
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
  expect(port.rawUnsubscribe).toHaveBeenCalledWith("raw-id");
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
  expect(port.rawUnsubscribe).toHaveBeenCalledWith("real-raw");
  expect(port.ack).toHaveBeenCalledWith("8", "real-raw", "data", "1");
});
