import {
  ContractValidationError,
  TX_MAX_BYTES,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { bytesToBase64 } from "@/lib/base64";
import type { HostInvocation } from "@/providers/host-context";

export const broadcastTargetLimit = 16;

export type BroadcastDestination = {
  target: Target;
  label: string;
  revision: string;
  writeWaitMs: string;
};

type Phase =
  "checking" | "admitting" | "waiting" | "done" | "notSent" | "unknown";
type Stop = "queued" | "requested" | "failed";

export type BroadcastRow = {
  destination: BroadcastDestination;
  phase: Phase;
  operation?: Operation;
  error?: unknown;
  stop?: Stop;
  stopError?: unknown;
};

type BroadcastHost = {
  allowed: (input: HostInvocation, signal: AbortSignal) => Promise<boolean>;
  admit: (input: HostInvocation) => Promise<Operation>;
  observe: (accepted: Operation) => Promise<Operation>;
  cancel: (accepted: Operation) => Promise<void>;
};

function hasTarget(operation: Operation, target: Target) {
  const receipt =
    operation.result?.kind === "tx" ? operation.result.value : undefined;
  return (
    (operation.state !== "succeeded" || receipt !== undefined) &&
    (!receipt ||
      (receipt.operationId === operation.operationId &&
        receipt.sessionId === target.sessionId &&
        receipt.sessionEpoch === target.sessionEpoch)) &&
    operation.actionId === "session.tx" &&
    operation.executionMode === "independent" &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

function pending(operation: Operation) {
  return ["queued", "running", "cancel_requested"].includes(operation.state);
}

export function broadcastActive({ phase }: BroadcastRow) {
  return phase === "checking" || phase === "admitting" || phase === "waiting";
}

export function canStopBroadcast(row: BroadcastRow) {
  return (
    row.stop !== "queued" &&
    row.stop !== "requested" &&
    (row.phase === "checking" ||
      row.phase === "admitting" ||
      (row.operation != null &&
        pending(row.operation) &&
        row.operation.state !== "cancel_requested"))
  );
}

export function startBroadcast(
  destinations: readonly BroadcastDestination[],
  bytes: Uint8Array,
  host: BroadcastHost,
) {
  const hostId = destinations[0]?.target.hostId;
  if (
    destinations.length < 2 ||
    destinations.length > broadcastTargetLimit ||
    new Set(destinations.map(({ target }) => target.id)).size !==
      destinations.length ||
    destinations.some(
      ({ target }) =>
        target.hostId !== hostId ||
        target.kind !== "session" ||
        target.sessionId !== target.id ||
        !target.sessionEpoch,
    ) ||
    bytes.length < 1 ||
    bytes.length > TX_MAX_BYTES
  )
    throw new ContractValidationError("Invalid broadcast plan");

  const payload = bytesToBase64(bytes);
  let rows: readonly BroadcastRow[] = destinations.map((destination) => ({
    destination: { ...destination, target: { ...destination.target } },
    phase: "checking",
  }));
  const preflight = rows.map(() => new AbortController());
  const listeners = new Set<() => void>();

  function update(index: number, values: Partial<BroadcastRow>) {
    rows = rows.map((row, at) => (at === index ? { ...row, ...values } : row));
    for (const listener of listeners) listener();
  }

  async function observe(index: number, operation: Operation) {
    update(index, { phase: "waiting", error: undefined });
    try {
      const settled = await host.observe(operation);
      if (
        settled.operationId !== operation.operationId ||
        !hasTarget(settled, operation.target) ||
        pending(settled)
      )
        throw new ContractValidationError("Invalid broadcast settlement");
      update(index, {
        phase: settled.state === "unknown" ? "unknown" : "done",
        operation: settled,
      });
    } catch (error) {
      update(index, { phase: "unknown", error });
    }
  }

  async function cancel(index: number, operation: Operation) {
    update(index, { stop: "requested", stopError: undefined });
    try {
      await host.cancel(operation);
    } catch (stopError) {
      update(index, { stop: "failed", stopError });
    }
  }

  async function send(index: number, destination: BroadcastDestination) {
    const signal = preflight[index]!.signal;
    const call: HostInvocation = {
      actionId: "session.tx",
      target: destination.target,
      expectedRevision: destination.revision,
      executionMode: "independent",
      params: { bytesBase64: payload, writeWaitMs: destination.writeWaitMs },
    };
    try {
      const allowed = await host.allowed(call, signal);
      if (signal.aborted) return;
      if (!allowed) throw { code: "PERMISSION_DENIED" };
    } catch (error) {
      if (!signal.aborted) update(index, { phase: "notSent", error });
      return;
    }

    update(index, { phase: "admitting" });
    try {
      const accepted = await host.admit(call);
      if (!hasTarget(accepted, call.target))
        throw new ContractValidationError("Invalid broadcast admission");
      if (pending(accepted)) {
        update(index, { operation: accepted });
        if (rows[index]?.stop === "queued") void cancel(index, accepted);
        await observe(index, accepted);
      } else {
        update(index, {
          phase: accepted.state === "unknown" ? "unknown" : "done",
          operation: accepted,
          stop: undefined,
        });
      }
    } catch (error) {
      update(index, { phase: "unknown", error, stop: undefined });
    }
  }

  rows.forEach(({ destination }, index) => void send(index, destination));

  return {
    snapshot: () => rows,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop(index: number) {
      const row = rows[index];
      if (!row || !canStopBroadcast(row)) return;
      if (row.phase === "checking") {
        preflight[index]!.abort();
        update(index, { phase: "notSent", stop: "requested" });
      } else if (row.phase === "admitting" && !row.operation) {
        update(index, { stop: "queued" });
      } else if (row.operation) {
        void cancel(index, row.operation);
      }
    },
    recheck(index: number) {
      const row = rows[index];
      if (row?.phase === "unknown" && row.operation)
        void observe(index, row.operation);
    },
  };
}
