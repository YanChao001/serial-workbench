import { expect, it, vi } from "vitest";
import type { Call, RpcRequest, Target } from "@serial-workbench/contracts";
import { operation } from "@/features/workbench/test-fixtures";
import {
  hasPendingBrowserFile,
  recoverBrowserFile,
  sendBrowserFile,
} from "./browser-file-transfer";

const target: Target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "3",
};
const draft = {
  offset: "1",
  length: "2",
  chunkBytes: "4096",
  bytesPerSecond: "1024",
  interChunkMs: "0",
  writeWaitMs: "1000",
};
function connection(
  request: (value: RpcRequest) => unknown,
  clientId = "browser",
) {
  const attachment = {
    hostId: target.hostId,
    instanceEpoch: "7",
    actorId: "actor",
    clientId,
  };
  return {
    attachment,
    transport: {
      request: async (requestValue: RpcRequest) => request(requestValue),
    },
    buildCall(
      actionId: string,
      target: Target,
      params: Call["params"] = {},
      options: Partial<Call> = {},
    ): Call {
      return {
        protocolVersion: "1.0",
        hostId: attachment.hostId,
        actorId: attachment.actorId,
        instanceEpoch: attachment.instanceEpoch,
        requestId: "12345678-1234-4abc-8000-0123456789ab",
        requestContext: "context",
        actionId,
        params,
        target,
        revealTarget: { pageId: "workbench" },
        ...options,
      };
    },
  };
}
const success = (result: unknown) => ({ ok: true, result });
function receipt(call: Call) {
  return success({
    operation: {
      ...operation("browser-file-operation"),
      requestId: call.requestId,
      actorId: call.actorId,
      target: call.target,
      actionId: "transfer.file",
      executionMode: "independent",
      state: "queued",
    },
  });
}
function fileReply(total: number, received: number, sealed = false) {
  return success({
    uploadId: "upload",
    totalBytes: String(total),
    receivedBytes: String(received),
    ...(sealed ? { sealedFingerprint: "a".repeat(64) } : {}),
  });
}

it("uploads bounded blocks and submits the exact selected range using the normal action envelope", async () => {
  const size = 65539;
  const bytes = new Uint8Array(size);
  bytes.set([0, 255, 36, 123]);
  bytes.set([17, 22, 33], 65536);
  const request = vi.fn((value: RpcRequest) => {
    if (value.method !== "browser.fileHandoff") throw Error(value.method);
    const params = value.params;
    if (params.kind === "begin") return fileReply(size, 0);
    if (params.kind === "append")
      return fileReply(
        size,
        Number(params.offset) + atob(params.bytesBase64).length,
      );
    if (params.kind === "seal") return fileReply(size, size, true);
    if (params.kind === "submit") return receipt(params.call);
    throw Error(params.kind);
  });
  const report = vi.fn();
  const browser = connection(request, "browser-first");
  const result = await sendBrowserFile(
    browser,
    target,
    new File([bytes], "source.bin"),
    draft,
    report,
    new AbortController().signal,
    "19",
  );
  expect(result?.requestId).toBe("12345678-1234-4abc-8000-0123456789ab");
  const params = request.mock.calls.map(([request]) =>
    request.method === "browser.fileHandoff" ? request.params : undefined,
  );
  expect(params).toMatchObject([
    { kind: "begin", length: String(size), target },
    {
      kind: "append",
      offset: "0",
      bytesBase64: expect.stringMatching(/^AP8kew/),
    },
    { kind: "append", offset: "65536", bytesBase64: "ERYh" },
    { kind: "seal", uploadId: "upload" },
    {
      kind: "submit",
      uploadId: "upload",
      call: {
        target,
        actionId: "transfer.file",
        executionMode: "independent",
        expectedRevision: "19",
        params: {
          ...draft,
          sourceRef: {
            hostId: "host",
            id: "upload",
            revision: "1",
            kind: "file",
          },
        },
      },
    },
  ]);
  expect(report.mock.calls).toEqual([
    [{ kind: "upload", received: 0, total: size }],
    [{ kind: "upload", received: 65536, total: size }],
    [{ kind: "upload", received: size, total: size }],
    [{ kind: "submitting" }],
  ]);
  expect(hasPendingBrowserFile(browser)).toBe(false);
});

it("retires a late Begin response when the upload has been cancelled", async () => {
  const stop = new AbortController();
  const request = vi.fn((value: RpcRequest) => {
    if (value.method !== "browser.fileHandoff") throw Error(value.method);
    if (value.params.kind === "begin") {
      stop.abort();
      return fileReply(3, 0);
    }
    if (value.params.kind === "discard") return success({ closed: true });
    throw Error(value.params.kind);
  });
  const result = await sendBrowserFile(
    connection(request, "browser-cancelled"),
    target,
    new File(["abc"], "source.bin"),
    draft,
    vi.fn(),
    stop.signal,
  );
  expect(result).toBeNull();
  expect(request.mock.calls.map(([value]) => value.params)).toMatchObject([
    { kind: "begin" },
    { kind: "discard", uploadId: "upload" },
  ]);
});

it("checks the original receipt under the same identity after a response is lost", async () => {
  const disconnected = vi.fn((value: RpcRequest) => {
    if (value.method !== "browser.fileHandoff") throw Error(value.method);
    switch (value.params.kind) {
      case "begin":
        return fileReply(3, 0);
      case "append":
        return fileReply(3, 3);
      case "seal":
        return fileReply(3, 3, true);
      case "submit":
        throw Error("response lost");
      case "discard":
        throw Error("connection closed");
    }
  });
  const original = connection(disconnected);
  await expect(
    sendBrowserFile(
      original,
      target,
      new File(["abc"], "source.bin"),
      draft,
      vi.fn(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("response lost");
  expect(hasPendingBrowserFile(original)).toBe(true);
  const foreign = vi.fn();
  await expect(
    recoverBrowserFile(connection(foreign, "other-browser")),
  ).resolves.toBeNull();
  expect(foreign).not.toHaveBeenCalled();

  const reconnected = vi.fn((value: RpcRequest) => {
    if (value.method !== "browser.fileHandoff") throw Error(value.method);
    if (value.params.kind === "discard") return success({ closed: true });
    if (value.params.kind === "submit") return receipt(value.params.call);
    throw Error(value.params.kind);
  });
  await expect(
    recoverBrowserFile(connection(reconnected)),
  ).resolves.toMatchObject({
    requestId: "12345678-1234-4abc-8000-0123456789ab",
  });
  expect(reconnected.mock.calls).toEqual([
    [
      {
        method: "browser.fileHandoff",
        params: { kind: "discard", uploadId: "upload" },
      },
    ],
    disconnected.mock.calls[3],
  ]);
  expect(hasPendingBrowserFile(original)).toBe(false);
});
