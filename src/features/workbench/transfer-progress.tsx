import { useEffect, useRef, useState } from "react";
import type { ObjectRef, Operation } from "@serial-workbench/contracts";
import { Progress } from "@/components/ui/progress";
import { parseU64 } from "@/lib/u64";
import { formatByteSize, formatElapsedTime } from "./metric-format";

import type { TransferProgressLabels } from "./operation-text";
import type { HostContextValue } from "@/providers/host-context";

export type TransferReadProgressReader = NonNullable<
  HostContextValue["readTransferProgress"]
>;

type Reading = { accepted: bigint; observedMs: number };
const minimumSampleMs = 250;
const expiryMs = 5000;

export function isTransferActive(state: Operation["state"]) {
  return (
    state === "queued" || state === "running" || state === "cancel_requested"
  );
}

function useObservedRate(accepted: bigint | undefined, running: boolean) {
  const previous = useRef<Reading | undefined>(undefined);
  const [rate, setRate] = useState<bigint>();

  useEffect(() => {
    if (!running || accepted === undefined) {
      previous.current = undefined;
      setRate(undefined);
      return;
    }
    const observedMs = Math.floor(performance.now());
    const baseline = previous.current;
    if (!baseline || accepted < baseline.accepted) {
      previous.current = { accepted, observedMs };
      setRate(undefined);
      return;
    }
    const elapsed = observedMs - baseline.observedMs;
    if (accepted === baseline.accepted || elapsed < minimumSampleMs) return;
    previous.current = { accepted, observedMs };
    const delta = accepted - baseline.accepted;
    setRate((delta * 1000n) / BigInt(elapsed) || undefined);
  }, [accepted, running]);

  useEffect(() => {
    if (rate === undefined || !running) return;
    const timer = window.setTimeout(() => setRate(undefined), expiryMs);
    return () => window.clearTimeout(timer);
  }, [rate, running, accepted]);

  return running ? rate : undefined;
}

function useSourceRead(
  receiptsRef: ObjectRef | undefined,
  active: boolean,
  reader: TransferReadProgressReader | undefined,
) {
  const [snapshot, setSnapshot] = useState<{
    reader: TransferReadProgressReader;
    hostId: string;
    id: string;
    read?: string;
  }>();
  const { hostId, id, revision, kind } = receiptsRef ?? {};
  useEffect(() => {
    if (!reader || !hostId || !id || kind !== "transfer_receipts") return;
    const readProgress = reader;
    const controller = new AbortController();
    const reference = {
      hostId,
      id,
      kind,
      ...(revision === undefined ? {} : { revision }),
    };
    let timer: number | undefined;
    async function sample() {
      try {
        const value = await readProgress(
          { receiptsRef: reference },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSnapshot({
          reader: readProgress,
          hostId: reference.hostId,
          id: reference.id,
          read: value.read,
        });
      } catch {
        if (!controller.signal.aborted) setSnapshot(undefined);
      }
      if (active && !controller.signal.aborted)
        timer = window.setTimeout(() => void sample(), 500);
    }
    void sample();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reader, hostId, id, revision, kind, active]);

  return snapshot &&
    snapshot.reader === reader &&
    snapshot.hostId === hostId &&
    snapshot.id === id
    ? parseU64(snapshot.read ?? "")
    : undefined;
}

export function TransferProgress(props: {
  operation: Operation;
  labels: TransferProgressLabels;
  readProgress?: TransferReadProgressReader;
}) {
  const { operation } = props;
  return (
    <TransferProgressView
      key={JSON.stringify([
        operation.executionHostId,
        operation.operationId,
        operation.target.sessionEpoch,
      ])}
      {...props}
    />
  );
}

function TransferProgressView({
  operation,
  labels,
  readProgress,
}: {
  operation: Operation;
  labels: TransferProgressLabels;
  readProgress?: TransferReadProgressReader;
}) {
  const result =
    operation.result?.kind === "file_transfer"
      ? operation.result.value
      : undefined;
  const progress =
    operation.progress?.unit === "bytes" ? operation.progress : undefined;
  const requested = parseU64(result?.requested ?? progress?.total ?? "");
  const accepted = parseU64(result?.accepted ?? progress?.completed ?? "");
  const unknown = parseU64(result?.unknown ?? "");
  const valid =
    accepted !== undefined &&
    requested !== undefined &&
    accepted + (unknown ?? 0n) <= requested;
  const running = operation.state === "running";
  const sourceRead = useSourceRead(
    operation.actionId === "transfer.file" ? result?.receiptsRef : undefined,
    isTransferActive(operation.state),
    readProgress,
  );
  const rate = useObservedRate(valid ? accepted : undefined, running);
  const eta =
    rate && valid && requested > accepted
      ? ((requested - accepted + rate - 1n) / rate) * 1000n
      : undefined;
  const value = !valid
    ? null
    : requested === 0n
      ? operation.state === "succeeded"
        ? 1000
        : 0
      : Number((accepted * 1000n) / requested);
  const bytes = (amount?: bigint) => formatByteSize(amount?.toString());

  return (
    <div className="grid gap-2">
      <Progress
        max={1000}
        value={value}
        aria-label={labels.bar}
        aria-valuetext={
          valid ? bytes(accepted) + " / " + bytes(requested) : undefined
        }
        className="h-1.5 bg-muted [&>[data-slot=progress-indicator]]:bg-primary"
      />
      <dl className="workbench-transfer-result">
        <div>
          <dt>{labels.requestedBytes}</dt>
          <dd aria-label={labels.requestedBytes}>{bytes(requested)}</dd>
        </div>
        <div>
          <dt>{labels.acceptedBytes}</dt>
          <dd aria-label={labels.acceptedBytes}>{bytes(accepted)}</dd>
        </div>
        {operation.actionId === "transfer.file" && (
          <div>
            <dt>{labels.readBytes}</dt>
            <dd aria-label={labels.readBytes}>
              {sourceRead !== undefined &&
              requested !== undefined &&
              sourceRead <= requested
                ? bytes(sourceRead)
                : "—"}
            </dd>
          </div>
        )}
        {result && (
          <div>
            <dt>{labels.unknownBytes}</dt>
            <dd aria-label={labels.unknownBytes}>{bytes(unknown)}</dd>
          </div>
        )}
        {running && (
          <>
            <div>
              <dt>{labels.rate}</dt>
              <dd aria-label={labels.rate}>
                {rate === undefined ? "—" : bytes(rate) + "/s"}
              </dd>
            </div>
            <div>
              <dt>{labels.eta}</dt>
              <dd aria-label={labels.eta}>
                {eta === undefined ? "—" : formatElapsedTime(eta.toString())}
              </dd>
            </div>
          </>
        )}
      </dl>
      {result && (
        <p>
          {result.peerAcknowledged
            ? labels.peerConfirmed
            : labels.peerUnconfirmed}
        </p>
      )}
    </div>
  );
}
