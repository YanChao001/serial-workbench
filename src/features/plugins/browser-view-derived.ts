import {
  ContractValidationError,
  parseReply,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "@/lib/host-client";
import { parseU64 } from "@/lib/u64";
import type { BrowserViewRequest } from "./browser-view-assets";
import { rawQuery } from "./browser-view-raw";

const pageSamples = 32;
const pageBytes = 64 * 1024;

function invalid() {
  return new ContractValidationError("Plugin derived stream changed");
}

export async function readBrowserViewDerived(
  connection: HostConnection,
  { operationId, target }: BrowserViewRequest,
  port: MessagePort,
  authorize: () => Promise<void>,
  fail: (error: unknown) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let position = "0";
  let awaiting: string | undefined;
  let busy = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  async function sampling() {
    const reply = parseReply(
      await connection.transport.request(
        {
          method: "operation.get",
          params: connection.buildQuery(
            "operation.get",
            { kind: "operation", hostId: target.hostId, id: operationId },
            { operationId },
          ),
        },
        signal,
      ),
    );
    if (!reply.ok) throw new HostRequestError(reply.error);
    if (!("operation" in reply.result)) throw invalid();
    const operation = reply.result.operation;
    if (
      operation.operationId !== operationId ||
      operation.target.kind !== target.kind ||
      operation.target.hostId !== target.hostId ||
      operation.target.id !== target.id ||
      operation.target.sessionId !== target.sessionId ||
      operation.target.sessionEpoch !== target.sessionEpoch
    )
      throw invalid();
    return operation.state === "running";
  }

  async function pull() {
    if (busy || awaiting !== undefined || signal.aborted || document.hidden)
      return;
    busy = true;
    clearTimeout(idle);
    try {
      await authorize();
      signal.throwIfAborted();
      let after = position;
      const waitingForFirstSample = after === "0" && (await sampling());
      for (let attempt = 0; attempt < 3; attempt++) {
        const afterPosition = BigInt(after);
        let result: Awaited<ReturnType<typeof rawQuery>>;
        try {
          result = await rawQuery(
            connection,
            "stream.derivedRead",
            target,
            {
              operationId,
              after,
              maxSamples: String(pageSamples),
              maxBytes: String(pageBytes),
            },
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof HostRequestError)) throw error;
          if (error.code === "NOT_FOUND" && waitingForFirstSample) {
            idle = setTimeout(advance, 100);
            return;
          }
          if (error.code !== "CURSOR_EXPIRED") throw error;
          const oldest = parseU64(error.details.details?.oldestPosition);
          if (oldest === undefined) throw error;
          if (oldest <= afterPosition + 1n) throw invalid();
          after = (oldest - 1n).toString();
          continue;
        }
        if (result.kind !== "stream_derived_read") throw invalid();
        const page = result.value;
        if (
          page.operationId !== operationId ||
          page.instanceEpoch !== connection.attachment.instanceEpoch ||
          page.samples.length > pageSamples ||
          page.nextPosition !==
            (afterPosition + BigInt(page.samples.length)).toString() ||
          page.samples.some(
            (sample, index) =>
              sample.position !==
                (afterPosition + BigInt(index + 1)).toString() ||
              sample.provenance.sources.some(
                (source) =>
                  source.hostId !== target.hostId ||
                  source.sessionId !== target.sessionId ||
                  source.sessionEpoch !== target.sessionEpoch,
              ),
          ) ||
          (page.samples.length === 0 && page.hasMore)
        )
          throw invalid();
        await authorize();
        signal.throwIfAborted();
        if (document.hidden) return;
        if (page.samples.length === 0) {
          idle = setTimeout(advance, 100);
          return;
        }
        awaiting = page.nextPosition;
        watchdog = setTimeout(() => fail(invalid()), 10000);
        port.postMessage({
          previousPosition: position,
          after,
          reply: { ok: true, result },
        });
        return;
      }
      throw new HostRequestError({
        code: "CURSOR_EXPIRED",
        message: "Derived view retention moved during pagination",
        retryable: false,
      });
    } finally {
      busy = false;
    }
  }

  const advance = () => void pull().catch(fail);
  document.addEventListener("visibilitychange", advance, { signal });
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(idle);
      clearTimeout(watchdog);
    },
    { once: true },
  );
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (signal.aborted || awaiting === undefined || data !== awaiting) return;
    position = awaiting;
    awaiting = undefined;
    clearTimeout(watchdog);
    advance();
  };
  await pull();
}
