import { expect, it, vi } from "vitest";
import {
  createWorkbenchFileActions,
  type FileActionHost,
} from "./file-actions";
import { operation, session } from "./test-fixtures";
function port(): FileActionHost {
  return {
    state: {
      status: "ready",
      error: null,
      catalog: [],
      devicesStale: false,
      devices: [
        {
          deviceId: "device",
          hostId: "host",
          systemName: "Virtual",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          capabilities: session().capabilities,
        },
      ],
      sessions: [session()],
      operations: [],
      operationSummaries: [],
      operationSummariesReady: true,
      streams: new Map(),
    },
    pickFile: vi.fn().mockResolvedValue({
      reference: {
        hostId: "host",
        kind: "file",
        id: "source",
        revision: "3",
      },
      name: "payload.bin",
      length: "9007199254740999",
      mime: "application/octet-stream",
    }),
    invoke: vi.fn().mockResolvedValue(operation()),
  };
}
it("sends the explicitly selected fixed file revision with exact length and session epoch", async () => {
  const host = port(),
    actions = createWorkbenchFileActions(() => host),
    signal = new AbortController().signal;
  await actions.send("session", signal);
  expect(host.pickFile).toHaveBeenCalledWith("source", signal);
  expect(host.invoke).toHaveBeenCalledWith(
    {
      actionId: "transfer.file",
      target: {
        hostId: "host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      },
      executionMode: "independent",
      params: {
        sourceRef: {
          hostId: "host",
          kind: "file",
          id: "source",
          revision: "3",
        },
        offset: "0",
        length: "9007199254740999",
        chunkBytes: "4096",
        bytesPerSecond: "0",
        interChunkMs: "0",
        writeWaitMs: "1356",
      },
    },
    signal,
  );
});
it("captures to the chosen target with a real session reference and never starts after chooser cancellation", async () => {
  const host = port(),
    actions = createWorkbenchFileActions(() => host);
  await actions.capture("session");
  expect(host.pickFile).toHaveBeenCalledWith(
    "captureTarget",
    undefined,
    "session",
  );
  expect(host.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      actionId: "capture.start",
      target: { hostId: "host", kind: "file", id: "source" },
      executionMode: "independent",
      params: {
        targetRef: {
          hostId: "host",
          kind: "file",
          id: "source",
          revision: "3",
        },
        sessionRefs: [
          {
            hostId: "host",
            kind: "session",
            id: "session",
            sessionId: "session",
            sessionEpoch: "1",
          },
        ],
        mode: "raw",
        overflowPolicy: "stop",
        writeMode: "create_new",
      },
    }),
    undefined,
  );
  vi.mocked(host.invoke).mockClear();
  vi.mocked(host.pickFile).mockResolvedValue(null);
  await actions.send("session");
  expect(host.invoke).not.toHaveBeenCalled();
});
it("does not send after an abort or a new session epoch while the picker was open", async () => {
  const host = port(),
    actions = createWorkbenchFileActions(() => host),
    controller = new AbortController();
  const selected = await host.pickFile("source");
  vi.mocked(host.pickFile).mockImplementation(async () => {
    controller.abort();
    return selected;
  });
  await expect(
    actions.send("session", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  vi.mocked(host.pickFile).mockImplementation(async () => {
    host.state = {
      ...host.state,
      sessions: [{ ...session(), sessionEpoch: "2" }],
    };
    return selected;
  });
  await expect(actions.send("session")).rejects.toThrow("EPOCH_MISMATCH");
  expect(host.invoke).not.toHaveBeenCalled();
});
it("opens replay only from the captureSource directory picker", async () => {
  const host = port();
  const actions = createWorkbenchFileActions(() => host);
  await actions.replay();
  expect(host.pickFile).toHaveBeenCalledWith("captureSource", undefined);
  expect(host.invoke).toHaveBeenCalledWith(
    {
      actionId: "replay.open",
      target: { hostId: "host", kind: "file", id: "source" },
      params: {
        captureRef: {
          hostId: "host",
          kind: "file",
          id: "source",
          revision: "3",
        },
        mode: "original_timing",
      },
      executionMode: "independent",
    },
    undefined,
  );
});
