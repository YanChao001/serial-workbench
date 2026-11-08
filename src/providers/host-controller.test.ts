import { expect, it, vi } from "vitest";
import { parseReply } from "@serial-workbench/contracts";
import type {
  DeviceDescriptor,
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
  const workspace = createHostWorkspace(connection, {
    connectDevice: vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(selected),
    chooseFile,
    applyDocumentIntent: vi.fn(),
  });
  try {
    await workspace.trustedConnect(first.deviceId);
    await workspace.trustedConnect(selected.deviceId);
    await workspace.pickFile("captureTarget", undefined, selected.sessionId);
    expect(chooseFile).toHaveBeenLastCalledWith("captureTarget", "8", {
      deviceName: "COM7",
      baudRate: "230400",
    });
    await workspace.pickFile("source", undefined, selected.sessionId);
    expect(chooseFile).toHaveBeenLastCalledWith("source", "8");
  } finally {
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
