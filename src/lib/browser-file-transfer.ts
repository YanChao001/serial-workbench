import {
  ContractValidationError,
  parseReply,
  type BrowserFileHandoffParams,
  type Call,
  type FileTransferParams,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import { bytesToBase64 } from "./base64";
import type { HostConnection } from "./host-client";

export const BROWSER_FILE_LIMIT = 1024 ** 3;
const chunkSize = 64 * 1024;
type Draft = Omit<FileTransferParams, "sourceRef">;
type Submission = Extract<BrowserFileHandoffParams, { kind: "submit" }>;
export type BrowserFileProgress =
  { kind: "upload"; received: number; total: number } | { kind: "submitting" };

type BrowserFileConnection = Pick<HostConnection, "buildCall"> & {
  attachment: Pick<
    HostConnection["attachment"],
    "hostId" | "instanceEpoch" | "actorId" | "clientId"
  >;
  transport: Pick<HostConnection["transport"], "request">;
};
type Pending = { clientId: string; submission: Submission };
let pending: Pending | undefined;

export function hasPendingBrowserFile(connection: BrowserFileConnection) {
  const attachment = connection.attachment;
  const call = pending?.submission.call;
  return (
    pending?.clientId === attachment.clientId &&
    call?.hostId === attachment.hostId &&
    call.instanceEpoch === attachment.instanceEpoch &&
    call.actorId === attachment.actorId
  );
}

async function request(
  connection: BrowserFileConnection,
  params: BrowserFileHandoffParams,
) {
  return parseReply(
    await connection.transport.request({
      method: "browser.fileHandoff",
      params,
    }),
  );
}

async function progress(
  connection: BrowserFileConnection,
  params: BrowserFileHandoffParams,
  total: number,
  received: number,
) {
  const reply = await request(connection, params);
  if (!reply.ok) throw new HostRequestError(reply.error);
  const result = reply.result;
  if (
    !("uploadId" in result) ||
    result.totalBytes !== String(total) ||
    result.receivedBytes !== String(received) ||
    ("uploadId" in params && result.uploadId !== params.uploadId)
  ) {
    throw new ContractValidationError("Invalid browser file progress");
  }
  return result;
}

async function discard(connection: BrowserFileConnection, uploadId: string) {
  const reply = await request(connection, { kind: "discard", uploadId });
  if (!reply.ok) throw new HostRequestError(reply.error);
  if (!("closed" in reply.result) || !reply.result.closed)
    throw new ContractValidationError("Invalid browser file discard receipt");
}

async function submit(
  connection: BrowserFileConnection,
  owner: Pending,
  recovering = false,
) {
  const reply = await request(connection, owner.submission);
  if (!reply.ok) {
    if (pending === owner && (!recovering || reply.error.code === "NOT_FOUND"))
      pending = undefined;
    throw new HostRequestError(reply.error);
  }
  if (
    !("operation" in reply.result) ||
    reply.result.operation.requestId !== owner.submission.call.requestId
  ) {
    throw new ContractValidationError("Invalid browser file operation receipt");
  }
  if (pending === owner) pending = undefined;
  return reply.result.operation;
}

export async function recoverBrowserFile(connection: BrowserFileConnection) {
  const owner = pending;
  if (!owner || !hasPendingBrowserFile(connection)) return null;
  // 先移除连接上可能尚未交接的源，复用请求号只会取回已接纳的操作。
  await discard(connection, owner.submission.uploadId);
  try {
    return await submit(connection, owner, true);
  } catch (error) {
    if (error instanceof HostRequestError && error.code === "NOT_FOUND")
      return null;
    throw error;
  }
}

export async function sendBrowserFile(
  connection: BrowserFileConnection,
  target: Target,
  file: File,
  draft: Draft,
  report: (progress: BrowserFileProgress) => void,
  signal: AbortSignal,
  expectedRevision?: string,
): Promise<Operation | null> {
  if (hasPendingBrowserFile(connection))
    throw new HostRequestError({
      code: "REQUEST_CONFLICT",
      message: "Check the previous browser file submission first",
      retryable: false,
    });
  if (file.size < 1 || file.size > BROWSER_FILE_LIMIT)
    throw new HostRequestError({
      code: "LIMIT_EXCEEDED",
      message: "Browser file size is outside the transfer limit",
      retryable: false,
    });
  let uploadId: string | undefined;
  let cleanup: Promise<void> | undefined;
  function retire() {
    if (uploadId && !cleanup) {
      cleanup = discard(connection, uploadId);
      void cleanup.catch(() => {});
    }
  }
  let accepted = false;
  let submitted = false;
  signal.throwIfAborted();
  signal.addEventListener("abort", retire, { once: true });
  try {
    report({ kind: "upload", received: 0, total: file.size });
    // 即使等待者关闭，也要拿到迟到的上传标识来释放 Host 暂存。
    const opened = await progress(
      connection,
      { kind: "begin", target, length: String(file.size) },
      file.size,
      0,
    );
    uploadId = opened.uploadId;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      signal.throwIfAborted();
      const end = Math.min(offset + chunkSize, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      signal.throwIfAborted();
      await progress(
        connection,
        {
          kind: "append",
          uploadId,
          offset: String(offset),
          bytesBase64: bytesToBase64(bytes),
        },
        file.size,
        end,
      );
      if (!signal.aborted)
        report({ kind: "upload", received: end, total: file.size });
    }
    signal.throwIfAborted();
    const sealed = await progress(
      connection,
      { kind: "seal", uploadId },
      file.size,
      file.size,
    );
    if (!sealed.sealedFingerprint)
      throw new ContractValidationError(
        "Missing sealed browser file fingerprint",
      );
    signal.throwIfAborted();
    const call: Call = connection.buildCall(
      "transfer.file",
      target,
      {
        ...draft,
        sourceRef: {
          hostId: target.hostId,
          kind: "file",
          id: uploadId,
          revision: "1",
        },
      },
      { executionMode: "independent", expectedRevision },
    );
    const owner: Pending = {
      clientId: connection.attachment.clientId,
      submission: { kind: "submit", uploadId, call },
    };
    pending = owner;
    submitted = true;
    report({ kind: "submitting" });
    const operation = await submit(connection, owner);
    accepted = true;
    return operation;
  } catch (error) {
    if (signal.aborted && !submitted) {
      retire();
      await cleanup;
      return null;
    }
    if (
      signal.aborted &&
      error instanceof HostRequestError &&
      error.code === "NOT_FOUND"
    ) {
      await cleanup;
      return null;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", retire);
    if (!accepted) {
      retire();
      await cleanup?.catch(() => {});
    }
  }
}
