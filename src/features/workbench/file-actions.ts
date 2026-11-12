import type { HostContextValue } from "@/providers/host-context";
import type { WriteWaitMode } from "@/lib/generated/bindings";
import { sendWaitMs } from "./send-wait";
import type {
  CaptureStartParams,
  FileTransferParams,
  ReplayOpenParams,
  Target,
} from "@serial-workbench/contracts";
export type FileActionHost = Pick<
  HostContextValue,
  "state" | "pickFile" | "invoke" | "connection"
>;
export function createWorkbenchFileActions(
  current: () => FileActionHost,
  waitMode: (hostId: string, deviceId: string) => WriteWaitMode = () =>
    "automatic",
) {
  function sessionTarget(sessionId: string) {
    const host = current();
    const session = host.state.sessions.find(
      (value) => value.sessionId === sessionId,
    );
    if (!session || session.state !== "open")
      throw new Error("SESSION_NOT_OPEN");
    const hostId =
      host.state.devices.find((value) => value.deviceId === session.deviceId)
        ?.hostId ?? host.connection?.attachment.hostId;
    if (!hostId) throw new Error("HOST_UNAVAILABLE");
    const target: Target = {
      hostId,
      kind: "session",
      id: session.sessionId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    };
    return { host, session, target };
  }
  async function select(
    sessionId: string,
    role: "source" | "captureTarget",
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const before = sessionTarget(sessionId);
    const selected = await (role === "captureTarget"
      ? before.host.pickFile(role, signal, before.session.sessionId)
      : before.host.pickFile(role, signal));
    signal?.throwIfAborted();
    if (!selected) return null;
    const latest = sessionTarget(sessionId);
    if (
      before.target.hostId !== latest.target.hostId ||
      before.session.sessionEpoch !== latest.session.sessionEpoch ||
      before.host.connection?.generation !== latest.host.connection?.generation
    )
      throw new Error("EPOCH_MISMATCH");
    if (selected.reference.hostId !== latest.target.hostId)
      throw new Error("HOST_MISMATCH");
    return { ...latest, selected };
  }
  return {
    async replay(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const host = current();
      const selected = await host.pickFile("captureSource", signal);
      signal?.throwIfAborted();
      if (!selected) return;
      if (host.connection?.generation !== current().connection?.generation)
        throw new Error("EPOCH_MISMATCH");
      const params: ReplayOpenParams = {
        captureRef: selected.reference,
        mode: "original_timing",
      };
      await current().invoke(
        {
          actionId: "replay.open",
          target: {
            hostId: selected.reference.hostId,
            kind: selected.reference.kind,
            id: selected.reference.id,
          },
          params,
          executionMode: "independent",
        },
        signal,
      );
    },
    async send(sessionId: string, signal?: AbortSignal) {
      const selection = await select(sessionId, "source", signal);
      if (!selection) return;
      const { host, session, target, selected } = selection;
      const params: FileTransferParams = {
        sourceRef: selected.reference,
        offset: "0",
        length: selected.length,
        chunkBytes: "4096",
        bytesPerSecond: "0",
        interChunkMs: "0",
        writeWaitMs: sendWaitMs(
          session.configuration,
          Number(
            BigInt(selected.length) < 4096n ? BigInt(selected.length) : 4096n,
          ),
          waitMode(target.hostId, session.deviceId),
        ),
      };
      await host.invoke(
        {
          actionId: "transfer.file",
          target,
          params,
          executionMode: "independent",
        },
        signal,
      );
    },
    async capture(sessionId: string, signal?: AbortSignal) {
      const selection = await select(sessionId, "captureTarget", signal);
      if (!selection) return;
      const { host, target, selected } = selection;
      const params: CaptureStartParams = {
        targetRef: selected.reference,
        sessionRefs: [target],
        mode: "raw",
        overflowPolicy: "stop",
        writeMode: "create_new",
      };
      return host.invoke(
        {
          actionId: "capture.start",
          target: {
            hostId: selected.reference.hostId,
            kind: selected.reference.kind,
            id: selected.reference.id,
          },
          params,
          executionMode: "independent",
        },
        signal,
      );
    },
  };
}
