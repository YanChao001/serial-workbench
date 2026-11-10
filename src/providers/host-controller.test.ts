import { expect, it, vi } from "vitest";
import { parseReply } from "@serial-workbench/contracts";
import type {
  DeviceDescriptor,
  FileTransferReceiptsResult,
  ObjectRef,
  SessionSnapshot,
} from "@serial-workbench/contracts";
import { createHostConnection, type HostNativePort } from "@/lib/host-client";
import { createHostWorkspace } from "./host-controller";
import fixtures from "../../packages/contracts/src/generated/fixtures.json";

function fixture(schema: string): unknown {
  const found = fixtures.valid.find((value) => value.schema === schema);
  if (!found) throw new Error(`Missing fixture ${schema}`);
  return found.value;
}

function session(): SessionSnapshot {
  const reply = parseReply({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  if (!reply.ok || !("kind" in reply.result) || reply.result.kind !== "session")
    throw new Error("fixture");
  return reply.result.value;
}

function port(devices: () => DeviceDescriptor[]): HostNativePort {
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
      generation: "8",
    }),
    request: vi.fn<HostNativePort["request"]>(async (request) => {
      if (request.method !== "action.query")
        throw new Error("Unexpected request");
      switch (request.params.actionId) {
        case "state.scopes":
          return {
            ok: true,
            result: { kind: "scopes", value: { scopes: [] } },
          };
        case "catalog.list":
          return {
            ok: true,
            result: {
              kind: "catalog",
              value: { catalogVersion: "1", items: [] },
            },
          };
        case "device.list":
        case "device.refresh":
          return {
            ok: true,
            result: {
              kind: "devices",
              value: { devices: devices(), stale: false },
            },
          };
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
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function requestedActions(native: HostNativePort) {
  return vi
    .mocked(native.request)
    .mock.calls.map(([request]) =>
      request.method === "action.query"
        ? request.params.actionId
        : request.method,
    );
}

it("enumerates devices only for an explicit refresh option without opening or authorizing one", async () => {
  let devices: DeviceDescriptor[] = [];
  const native = port(() => devices);
  const connectDevice = vi.fn();
  const workspace = createHostWorkspace(await createHostConnection(native), {
    connectDevice,
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  });
  try {
    await workspace.refresh();
    expect(requestedActions(native)).toContain("device.list");
    expect(requestedActions(native)).not.toContain("device.refresh");
    expect(workspace.getSnapshot().state.devices).toEqual([]);
    devices = [
      {
        hostId: "host",
        deviceId: "fresh-device",
        systemName: "COM14",
        fingerprint: { transport: "virtual", evidence: "unreliable" },
        capabilities: session().capabilities,
      },
    ];
    await workspace.refresh({ enumerateDevices: true });
    expect(workspace.getSnapshot().state.devices).toEqual(devices);
    expect(
      requestedActions(native).filter((id) => id === "device.refresh"),
    ).toHaveLength(1);
    expect(
      requestedActions(native).filter((id) => id === "device.list"),
    ).toHaveLength(1);
    expect(requestedActions(native)).not.toContain("auth.authorize");
    expect(requestedActions(native)).not.toContain("action.invoke");
    expect(connectDevice).not.toHaveBeenCalled();
  } finally {
    workspace.dispose();
  }
});

it("queues one enumeration behind a cached refresh and merges repeated in-flight enumeration requests", async () => {
  const native = port(() => []);
  const connection = await createHostConnection(native);
  const read = connection.client.query;
  const cached = deferred();
  const enumerated = deferred();
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input, signal) => {
      if (input.actionId === "device.list") await cached.promise;
      if (input.actionId === "device.refresh") await enumerated.promise;
      return read(input, signal);
    });
  const workspace = createHostWorkspace(connection);
  try {
    const background = workspace.refresh();
    await vi.waitFor(() =>
      expect(
        query.mock.calls.some(([input]) => input.actionId === "device.list"),
      ).toBe(true),
    );
    const first = workspace.refresh({ enumerateDevices: true });
    const second = workspace.refresh({ enumerateDevices: true });
    expect(
      query.mock.calls.filter(([input]) => input.actionId === "device.refresh"),
    ).toHaveLength(0);
    cached.release();
    await vi.waitFor(() =>
      expect(
        query.mock.calls.filter(
          ([input]) => input.actionId === "device.refresh",
        ),
      ).toHaveLength(1),
    );
    const third = workspace.refresh({ enumerateDevices: true });
    const anotherBackground = workspace.refresh();
    enumerated.release();
    await Promise.all([background, first, second, third, anotherBackground]);
    expect(
      requestedActions(native).filter((id) => id === "device.list"),
    ).toHaveLength(1);
    expect(
      requestedActions(native).filter((id) => id === "device.refresh"),
    ).toHaveLength(1);
    expect(requestedActions(native)).not.toContain("auth.authorize");
    expect(requestedActions(native)).not.toContain("action.invoke");
    expect(workspace.getSnapshot().state.status).toBe("ready");
  } finally {
    cached.release();
    enumerated.release();
    workspace.dispose();
  }
});

it("preserves a failed cached refresh while a queued explicit enumeration can succeed", async () => {
  const native = port(() => []);
  const connection = await createHostConnection(native);
  const read = connection.client.query;
  const cached = deferred();
  const failure = new Error("EXPLICIT_CACHED_READ_FAILED");
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input, signal) => {
      if (input.actionId === "device.list") {
        await cached.promise;
        throw failure;
      }
      return read(input, signal);
    });
  const workspace = createHostWorkspace(connection);
  try {
    const background = workspace.refresh();
    const rejected = expect(background).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(
        query.mock.calls.some(([input]) => input.actionId === "device.list"),
      ).toBe(true),
    );
    const forced = workspace.refresh({ enumerateDevices: true });
    cached.release();
    await rejected;
    await forced;
    expect(
      requestedActions(native).filter((id) => id === "device.refresh"),
    ).toHaveLength(1);
    expect(workspace.getSnapshot().state.status).toBe("ready");
  } finally {
    cached.release();
    workspace.dispose();
  }
});

it("keeps a connected session and device facts when explicit enumeration fails", async () => {
  const device: DeviceDescriptor = {
    deviceId: session().deviceId,
    hostId: "host",
    systemName: "COM14",
    fingerprint: { transport: "virtual", evidence: "unreliable" },
    capabilities: session().capabilities,
  };
  const native = port(() => [device]);
  const connection = await createHostConnection(native);
  const connectDevice = vi.fn().mockResolvedValue(session());
  const workspace = createHostWorkspace(connection, {
    connectDevice,
    chooseFile: vi.fn(),
    applyDocumentIntent: vi.fn(),
  });
  try {
    await workspace.refresh();
    await workspace.trustedConnect(device.deviceId);
    await workspace.refresh();
    const before = workspace.getSnapshot().state;
    const failure = new Error("EXPLICIT_ENUMERATION_FAILED");
    const read = connection.client.query;
    vi.spyOn(connection.client, "query").mockImplementation(
      async (input, signal) => {
        if (input.actionId === "device.refresh") throw failure;
        return read(input, signal);
      },
    );
    await expect(workspace.refresh({ enumerateDevices: true })).rejects.toBe(
      failure,
    );
    const after = workspace.getSnapshot().state;
    expect(after.status).toBe("ready");
    expect(after.error).toBe(failure);
    expect(after.sessions).toBe(before.sessions);
    expect(after.devices).toBe(before.devices);
    expect(connectDevice).toHaveBeenCalledOnce();
  } finally {
    workspace.dispose();
  }
});

it("does not start a queued device enumeration after workspace disposal", async () => {
  const native = port(() => []);
  const connection = await createHostConnection(native);
  const read = connection.client.query;
  const cached = deferred();
  const query = vi
    .spyOn(connection.client, "query")
    .mockImplementation(async (input, signal) => {
      if (input.actionId === "device.list") await cached.promise;
      return read(input, signal);
    });
  const workspace = createHostWorkspace(connection);
  const background = workspace.refresh();
  await vi.waitFor(() =>
    expect(
      query.mock.calls.some(([input]) => input.actionId === "device.list"),
    ).toBe(true),
  );
  const forced = workspace.refresh({ enumerateDevices: true });
  const results = Promise.allSettled([background, forced]);
  workspace.dispose();
  const stopped = workspace.getSnapshot();
  cached.release();
  expect((await results).every((result) => result.status === "rejected")).toBe(
    true,
  );
  expect(
    query.mock.calls.filter(([input]) => input.actionId === "device.refresh"),
  ).toHaveLength(0);
  expect(workspace.getSnapshot()).toBe(stopped);
});

it("names capture targets from the selected actual session and its matching device", async () => {
  const first = { ...session(), sessionId: "first", deviceId: "first-device" };
  const selected = {
    ...session(),
    sessionId: "selected",
    deviceId: "selected-device",
    configuration: { ...session().configuration, baudRate: "230400" },
  };
  const devices = [first, selected].map<DeviceDescriptor>((value) => ({
    deviceId: value.deviceId,
    hostId: "host",
    systemName: value.deviceId === "selected-device" ? "COM7" : "COM2",
    fingerprint: { transport: "virtual", evidence: "unreliable" },
    capabilities: value.capabilities,
  }));
  const connection = await createHostConnection(port(() => devices));
  const chooseFile = vi.fn().mockResolvedValue(null);
  const connectDevice = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(selected);
  const workspace = createHostWorkspace(connection, {
    connectDevice,
    chooseFile,
    applyDocumentIntent: vi.fn(),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await workspace.refresh();
    expect(workspace.getSnapshot().state.status).toBe("ready");
    expect(workspace.getSnapshot().state.devices).toEqual(devices);
    const read = connection.client.query;
    const query = vi
      .spyOn(connection.client, "query")
      .mockImplementation(async (input, signal) => {
        if (input.actionId === "catalog.list") await gate;
        return read(input, signal);
      });
    await workspace.trustedConnect(first.deviceId);
    await workspace.trustedConnect(selected.deviceId);
    expect(workspace.getSnapshot().state.sessions).toEqual([first, selected]);
    expect(workspace.getSnapshot().state.status).toBe("ready");
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "catalog.list" }),
      expect.any(AbortSignal),
    );
    await workspace.pickFile("captureTarget", undefined, selected.sessionId);
    expect(chooseFile).toHaveBeenLastCalledWith("captureTarget", "8", {
      deviceName: "COM7",
      baudRate: "230400",
    });
    await workspace.pickFile("source", undefined, selected.sessionId);
    expect(chooseFile).toHaveBeenLastCalledWith("source", "8");
    expect(connectDevice).toHaveBeenCalledTimes(2);
  } finally {
    release();
    workspace.dispose();
  }
});

it("uses a generic capture suggestion when the actual session or matching device is unavailable", async () => {
  const opened = session();
  const connection = await createHostConnection(port(() => []));
  const chooseFile = vi.fn().mockResolvedValue(null);
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi.fn().mockResolvedValue(opened),
    chooseFile,
    applyDocumentIntent: vi.fn(),
  });
  try {
    await workspace.trustedConnect(opened.deviceId);
    await workspace.pickFile("captureTarget", undefined, opened.sessionId);
    expect(chooseFile).toHaveBeenLastCalledWith("captureTarget", "8");
    await workspace.pickFile("captureTarget", undefined, "unknown");
    expect(chooseFile).toHaveBeenLastCalledWith("captureTarget", "8");
    await workspace.pickFile("captureTarget");
    expect(chooseFile).toHaveBeenLastCalledWith("captureTarget", "8");
  } finally {
    workspace.dispose();
  }
});

it("reads capture tails through Raw with current attachment and rejects foreign result identity", async () => {
  const native = port(() => []);
  const tail = fixture(
    "CaptureTailResult",
  ) as import("@serial-workbench/contracts").CaptureTailResult;
  const reference = {
    ...tail.captureRef,
    hostId: "host",
    kind: "capture",
    id: "saved",
    revision: "3",
  };
  const raw = vi.fn().mockResolvedValue({
    ok: true,
    result: {
      kind: "capture_tail",
      value: { ...tail, captureRef: reference },
    },
  });
  native.rawRequest = raw;
  const connection = await createHostConnection(native);
  const workspace = createHostWorkspace(connection);
  const reader = workspace.readCaptureTail;
  expect(typeof reader).toBe("function");
  await expect(reader(reference)).resolves.toMatchObject({
    captureRef: reference,
  });
  expect(raw).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "action.query",
      params: expect.objectContaining({
        hostId: "host",
        instanceEpoch: "7",
        actionId: "capture.tail",
        params: {
          captureRef: reference,
          maxRecords: "100",
          maxBytes: "262144",
        },
      }),
    }),
  );
  raw.mockResolvedValue({
    ok: true,
    result: {
      kind: "capture_tail",
      value: { ...tail, captureRef: { ...reference, revision: "4" } },
    },
  });
  await expect(reader(reference)).rejects.toThrow();
  for (const foreign of [
    { ...reference, hostId: "other" },
    { ...reference, id: "other" },
    { ...reference, kind: "file" },
  ]) {
    raw.mockResolvedValue({
      ok: true,
      result: { kind: "capture_tail", value: { ...tail, captureRef: foreign } },
    });
    await expect(reader(reference)).rejects.toThrow();
  }
  raw.mockResolvedValue({
    ok: true,
    result: { kind: "session", value: fixture("SessionSnapshot") },
  });
  await expect(reader(reference)).rejects.toThrow();
  const live = {
    hostId: reference.hostId,
    kind: reference.kind,
    id: reference.id,
  };
  raw.mockResolvedValue({
    ok: true,
    result: { kind: "capture_tail", value: { ...tail, captureRef: reference } },
  });
  await expect(reader(live)).resolves.toMatchObject({ captureRef: reference });
  expect(live).not.toHaveProperty("revision");
  expect(
    vi
      .mocked(native.request)
      .mock.calls.some(
        ([request]) =>
          request.method === "action.query" &&
          request.params.actionId === "capture.tail",
      ),
  ).toBe(false);
  workspace.dispose();
});

const receiptsRef: ObjectRef = {
  hostId: "host",
  kind: "transfer_receipts",
  id: "transfer-a",
  revision: "1",
};
const receiptsPage = (reference: ObjectRef): FileTransferReceiptsResult => ({
  receiptsRef: reference,
  count: "0",
  receipts: [],
  nextOrdinal: "0",
  hasMore: false,
  sealed: true,
});
const receiptParams = (reference: ObjectRef) => ({
  receiptsRef: reference,
  startOrdinal: "0",
  maxReceipts: "32",
  maxBytes: "65536",
});

it.each([
  ["Host", { ...receiptsRef, hostId: "other-host" }],
  ["kind", { ...receiptsRef, kind: "file" }],
  ["id", { ...receiptsRef, id: "transfer-b" }],
  ["pinned revision", { ...receiptsRef, revision: "2" }],
])(
  "rejects transfer receipts with a different returned %s",
  async (_name, returned) => {
    const native = port(() => []);
    native.rawRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        kind: "file_transfer_receipts",
        value: receiptsPage(returned),
      },
    });
    const workspace = createHostWorkspace(await createHostConnection(native));
    try {
      await expect(
        workspace.readFileReceipts(receiptParams(receiptsRef)),
      ).rejects.toThrow();
      expect(native.rawRequest).toHaveBeenCalledTimes(1);
    } finally {
      workspace.dispose();
    }
  },
);

it.each([
  ["foreign Host", { ...receiptsRef, hostId: "other-host" }],
  ["unrelated resource kind", { ...receiptsRef, kind: "file" }],
])(
  "rejects a transfer receipt request for a %s before Raw",
  async (_name, reference) => {
    const native = port(() => []);
    native.rawRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        kind: "file_transfer_receipts",
        value: receiptsPage(reference),
      },
    });
    const workspace = createHostWorkspace(await createHostConnection(native));
    try {
      await expect(
        workspace.readFileReceipts(receiptParams(reference)),
      ).rejects.toThrow();
      expect(native.rawRequest).not.toHaveBeenCalled();
    } finally {
      workspace.dispose();
    }
  },
);

it("accepts matching transfer receipts and the current revision for an unversioned request", async () => {
  const native = port(() => []);
  native.rawRequest = vi.fn().mockResolvedValue({
    ok: true,
    result: {
      kind: "file_transfer_receipts",
      value: receiptsPage(receiptsRef),
    },
  });
  const workspace = createHostWorkspace(await createHostConnection(native));
  const live = {
    hostId: receiptsRef.hostId,
    kind: receiptsRef.kind,
    id: receiptsRef.id,
  };
  try {
    await expect(
      workspace.readFileReceipts(receiptParams(receiptsRef)),
    ).resolves.toEqual(receiptsPage(receiptsRef));
    await expect(
      workspace.readFileReceipts(receiptParams(live)),
    ).resolves.toEqual(receiptsPage(receiptsRef));
    expect(live).not.toHaveProperty("revision");
    expect(native.rawRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "action.query",
        params: expect.objectContaining({
          hostId: "host",
          instanceEpoch: "7",
          actionId: "transfer.receiptsRead",
          target: {
            hostId: "host",
            kind: "transfer_receipts",
            id: "transfer-a",
          },
          params: receiptParams(live),
        }),
      }),
    );
  } finally {
    workspace.dispose();
  }
});
