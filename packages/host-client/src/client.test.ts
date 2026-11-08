import { describe, expect, it, vi } from "vitest";
import type { AttachResult, Call, Query } from "@serial-workbench/contracts";
import { createHostClient, HostRequestError } from "./client";

const query: Query = {
  protocolVersion: "0.1",
  hostId: "host",
  instanceEpoch: "7",
  actorId: "actor",
  requestId: "request",
  actionId: "state.snapshot",
  target: { hostId: "host", kind: "host", id: "host" },
  params: { scopeId: "host.devices" },
  revealTarget: { pageId: "workspace" },
};
const call: Call = {
  ...query,
  actionId: "session.close",
  requestContext: "signed-context",
};

describe("Host client RPC", () => {
  it("returns validated query results", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: "closed", value: { closed: true } },
    });
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => query.target,
      request,
      openChannel: vi.fn(),
    });
    await expect(client.query(query)).resolves.toEqual({
      kind: "closed",
      value: { closed: true },
    });
    expect(request).toHaveBeenCalledWith(
      { method: "action.query", params: query },
      undefined,
    );
  });
  it("reports stable errors without retrying a failed invoke", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "denied",
        retryable: false,
      },
    });
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => query.target,
      request,
      openChannel: vi.fn(),
    });
    await expect(client.invoke(call)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed replies", async () => {
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => query.target,
      request: vi.fn().mockResolvedValue({ ok: true, result: null }),
      openChannel: vi.fn(),
    });
    await expect(client.query(query)).rejects.toThrow();
  });
});

describe("cancellation", () => {
  it("stops waiting for a late reply without resending the operation", async () => {
    let finish: (value: unknown) => void = () => {};
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => query.target,
      request,
      openChannel: vi.fn(),
    });
    const pending = client.invoke(call, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

const attachment: AttachResult = {
  hostId: "host",
  instanceEpoch: "7",
  protocolVersion: "0.1",
  catalogVersion: "1",
  actorId: "actor",
  clientId: "client",
  limits: {
    maxRequestBytes: "1000",
    maxPageItems: "100",
    maxBatchBytes: "1000",
    maxReaderQueueBytes: "1000",
    resultRetentionMs: "1000",
    maxLeaseTtlMs: "1000",
  },
  requestContext: "signed-context",
  requestContextAcceptUntil: "2026-11-08T00:00:00Z",
};
const cursor = (position: string) => ({
  hostId: "host",
  instanceEpoch: "7",
  scopeId: "host.devices",
  position,
});
const snap = (position: string) => ({
  hostId: "host",
  instanceEpoch: "7",
  revision: position,
  cursor: cursor(position),
  state: {},
});
const frame = (
  requestId: string,
  previous: string,
  next: string,
  subscriptionId = "sub",
) => ({
  requestId,
  channel: "state",
  body: {
    type: "delta",
    subscriptionId,
    delta: {
      previousCursor: cursor(previous),
      cursor: cursor(next),
      revision: next,
      eventType: "changed",
      payload: {},
    },
  },
});

it("bridges snapshot and deltas from the snapshot cursor, suppressing duplicates", async () => {
  let deliver: (value: unknown) => void = () => {};
  let subscribed: Query | undefined;
  const events: unknown[] = [];
  const request = vi.fn().mockResolvedValue({
    ok: true,
    result: { kind: "snapshot", value: snap("1") },
  });
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request,
    openChannel: vi
      .fn()
      .mockImplementation(async (q: Query, cb: (value: unknown) => void) => {
        subscribed = q;
        deliver = cb;
        return { subscriptionId: "sub", unsubscribe: () => {} };
      }),
  });
  const close = await client.subscribe("host.devices", (event) =>
    events.push(event),
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        revealTarget: { pageId: "workbench" },
      }),
    }),
    undefined,
  );
  expect(subscribed?.revealTarget).toEqual({ pageId: "workbench" });
  expect(subscribed?.params).toEqual({
    scopeId: "host.devices",
    after: cursor("1"),
  });
  if (!subscribed) throw new Error("subscription missing");
  deliver(frame(subscribed.requestId, "1", "2"));
  deliver(frame(subscribed.requestId, "1", "2"));
  expect(events).toEqual([
    { type: "snapshot", snapshot: snap("1") },
    { type: "delta", delta: frame("x", "1", "2").body.delta },
  ]);
  close();
});

it("recovers a gap using a fresh snapshot and cursor", async () => {
  const events: { type: string }[] = [];
  const callbacks: ((value: unknown) => void)[] = [];
  const queries: Query[] = [];
  const closed = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    })
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("4") },
    });
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request,
    openChannel: async (q, cb) => {
      queries.push(q);
      callbacks.push(cb);
      return { subscriptionId: "sub", unsubscribe: closed };
    },
  });
  const stop = await client.subscribe("host.devices", (event) =>
    events.push(event),
  );
  callbacks[0]!(frame(queries[0]!.requestId, "3", "4"));
  await vi.waitFor(() => expect(queries).toHaveLength(2));
  expect(queries[1]!.params).toEqual({
    scopeId: "host.devices",
    after: cursor("4"),
  });
  expect(events.map((event) => event.type)).toEqual(["snapshot", "snapshot"]);
  expect(closed).toHaveBeenCalledTimes(1);
  stop();
});

it("cleans a channel handle that arrives after abort", async () => {
  let finish: (handle: {
    subscriptionId: string;
    unsubscribe: () => void;
  }) => void = () => {};
  const disposed = vi.fn();
  const signal = new AbortController();
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request: vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    }),
    openChannel: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const events: unknown[] = [];
  const pending = client.subscribe(
    "host.devices",
    (event) => events.push(event),
    signal.signal,
  );
  await vi.waitFor(() => expect(events).toHaveLength(1));
  signal.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finish({ subscriptionId: "sub", unsubscribe: disposed });
  await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
});

it.each(["invalid", "wrong-channel", "wrong-id"])(
  "reports %s frames instead of delivering deltas",
  async (kind) => {
    let deliver: (value: unknown) => void = () => {};
    let requestId = "";
    const events: { type: string }[] = [];
    const closed = vi.fn();
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
      request: vi.fn().mockResolvedValue({
        ok: true,
        result: { kind: "snapshot", value: snap("1") },
      }),
      openChannel: async (q, cb) => {
        requestId = q.requestId;
        deliver = cb;
        return { subscriptionId: "sub", unsubscribe: closed };
      },
    });
    await client.subscribe("host.devices", (event) => events.push(event));
    const value = frame(
      requestId,
      "1",
      "2",
      kind === "wrong-id" ? "other" : "sub",
    );
    deliver(
      kind === "invalid"
        ? null
        : kind === "wrong-channel"
          ? { ...value, channel: "raw" }
          : value,
    );
    expect(events.map((event) => event.type)).toEqual(["snapshot", "error"]);
    expect(closed).toHaveBeenCalledTimes(1);
  },
);

it("reports authorization failure while recovering a gap", async () => {
  let deliver: (value: unknown) => void = () => {};
  let requestId = "";
  const events: { type: string; error?: Error }[] = [];
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    });
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request,
    openChannel: async (q, cb) => {
      requestId = q.requestId;
      deliver = cb;
      return { subscriptionId: "sub", unsubscribe: () => {} };
    },
  });
  await client.subscribe("host.devices", (event) => events.push(event));
  deliver(frame(requestId, "3", "4"));
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events[1]!.error).toMatchObject({ code: "PERMISSION_DENIED" });
});

it("bounds frames arriving before the channel handle", async () => {
  const events: { type: string }[] = [];
  const disposed = vi.fn();
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request: vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    }),
    openChannel: async (q, cb) => {
      for (let i = 0; i < 300; i++) cb(frame(q.requestId, "1", "2"));
      return { subscriptionId: "sub", unsubscribe: disposed };
    },
  });
  await expect(
    client.subscribe("host.devices", (event) => events.push(event)),
  ).rejects.toThrow();
  expect(events.map((event) => event.type)).toEqual(["snapshot", "error"]);
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("rejects frames from a subscription after attachment changes", async () => {
  let deliver: (value: unknown) => void = () => {};
  let requestId = "";
  let current = attachment;
  const events: { type: string; error?: Error }[] = [];
  const client = createHostClient({
    getAttachment: () => current,
    resolveScope: () => ({ hostId: "host", kind: "host", id: "host" }),
    request: vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    }),
    openChannel: async (q, cb) => {
      requestId = q.requestId;
      deliver = cb;
      return { subscriptionId: "sub", unsubscribe: () => {} };
    },
  });
  await client.subscribe("host.devices", (event) => events.push(event));
  current = { ...attachment, instanceEpoch: "8" };
  deliver(frame(requestId, "1", "2"));
  expect(events.map((event) => event.type)).toEqual(["snapshot", "error"]);
  expect(events[1]!.error).toMatchObject({ code: "ATTACHMENT_CHANGED" });
});

it("ignores a late snapshot after StrictMode cleanup while the new subscription survives", async () => {
  let resolveOld: (value: unknown) => void = () => {};
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    });
  const closeChannel = vi.fn();
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => query.target,
    request,
    openChannel: async () => ({
      subscriptionId: "sub",
      unsubscribe: closeChannel,
    }),
  });
  const old = new AbortController();
  const oldEvents: unknown[] = [];
  const currentEvents: unknown[] = [];
  const pending = client.subscribe(
    "host.devices",
    (event) => oldEvents.push(event),
    old.signal,
  );
  old.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const stop = await client.subscribe("host.devices", (event) =>
    currentEvents.push(event),
  );
  resolveOld({ ok: true, result: { kind: "snapshot", value: snap("1") } });
  await Promise.resolve();
  expect(oldEvents).toEqual([]);
  expect(currentEvents).toHaveLength(1);
  expect(closeChannel).not.toHaveBeenCalled();
  stop();
  expect(closeChannel).toHaveBeenCalledTimes(1);
});

it("restarts from a new snapshot if history expires before channel setup", async () => {
  const events: { type: string }[] = [];
  const queries: Query[] = [];
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    })
    .mockResolvedValueOnce({
      ok: true,
      result: { kind: "snapshot", value: snap("4") },
    });
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => query.target,
    request,
    openChannel: async (q) => {
      queries.push(q);
      if (queries.length === 1)
        throw new HostRequestError({
          code: "CURSOR_EXPIRED",
          message: "expired",
          retryable: false,
        });
      return { subscriptionId: "sub", unsubscribe: () => {} };
    },
  });
  const stop = await client.subscribe("host.devices", (event) =>
    events.push(event),
  );
  expect(queries[1]!.params).toEqual({
    scopeId: "host.devices",
    after: cursor("4"),
  });
  expect(events.map((event) => event.type)).toEqual(["snapshot", "snapshot"]);
  stop();
});

it("buffers and validates a delta received before the channel handle", async () => {
  const events: { type: string }[] = [];
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => query.target,
    request: vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: "snapshot", value: snap("1") },
    }),
    openChannel: async (q, cb) => {
      cb(frame(q.requestId, "1", "2"));
      return { subscriptionId: "sub", unsubscribe: () => {} };
    },
  });
  const stop = await client.subscribe("host.devices", (event) =>
    events.push(event),
  );
  expect(events.map((event) => event.type)).toEqual(["snapshot", "delta"]);
  stop();
});

it("bounds consecutive cursor expiration frames and closes each handle", async () => {
  const events: { type: string; error?: Error }[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const request = vi.fn().mockResolvedValue({
    ok: true,
    result: { kind: "snapshot", value: snap("1") },
  });
  let opens = 0;
  const client = createHostClient({
    getAttachment: () => attachment,
    resolveScope: () => query.target,
    request,
    openChannel: async (q, cb) => {
      opens++;
      const unsubscribe = vi.fn();
      disposals.push(unsubscribe);
      if (opens <= 5)
        cb({
          requestId: q.requestId,
          channel: "state",
          body: {
            type: "subscriptionEnded",
            subscriptionId: "sub",
            error: {
              code: "CURSOR_EXPIRED",
              message: "expired",
              retryable: false,
            },
          },
        });
      return { subscriptionId: "sub", unsubscribe };
    },
  });
  const stop = await client.subscribe("host.devices", (event) =>
    events.push(event),
  );
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "error") || opens >= 6).toBe(
      true,
    ),
  );
  expect(opens).toBe(4);
  expect(request).toHaveBeenCalledTimes(4);
  expect(disposals).toHaveLength(4);
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  expect(events.at(-1)?.error).toMatchObject({ code: "CURSOR_EXPIRED" });
  stop();
});

it.each(["PERMISSION_DENIED", "EPOCH_MISMATCH"])(
  "preserves %s from a state error frame and closes once",
  async (code) => {
    let deliver: (value: unknown) => void = () => {};
    let requestId = "";
    const events: { type: string; error?: Error }[] = [];
    const dispose = vi.fn();
    const client = createHostClient({
      getAttachment: () => attachment,
      resolveScope: () => query.target,
      request: vi.fn().mockResolvedValue({
        ok: true,
        result: { kind: "snapshot", value: snap("1") },
      }),
      openChannel: async (q, cb) => {
        requestId = q.requestId;
        deliver = cb;
        return { subscriptionId: "sub", unsubscribe: dispose };
      },
    });
    const stop = await client.subscribe("host.devices", (event) =>
      events.push(event),
    );
    deliver({
      requestId,
      channel: "state",
      body: {
        type: "error",
        error: { code, message: "denied", retryable: false },
      },
    });
    deliver(frame(requestId, "1", "2"));
    stop();
    expect(events.map((event) => event.type)).toEqual(["snapshot", "error"]);
    expect(events[1]?.error).toMatchObject({ code });
    expect(dispose).toHaveBeenCalledTimes(1);
  },
);
