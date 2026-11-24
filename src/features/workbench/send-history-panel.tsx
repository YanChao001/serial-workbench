import { formatHex } from "@serial-workbench/host-client";
import type { Operation, Target } from "@serial-workbench/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/providers/i18n";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import type { OperationInputReader } from "./operation-input";
import {
  filterHistoryRows,
  maxHistoryBatch,
  readHistoryPayload,
  resendHistoryBatch,
  type HistoryPayload,
  type SendHistoryRow,
} from "./send-history-model";
import { useToolActionAvailability } from "./use-tool-action-availability";
import type { WorkbenchLabels } from "./labels";

const pageSize = 40;

type Destination = {
  target: Target;
  port: string;
  send: (bytes: Uint8Array, signal: AbortSignal) => Promise<Operation>;
  wait: HostContextValue["waitForOperation"];
};

function PayloadBytes({ bytes }: { bytes: Uint8Array }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        {t("sendHistory.bytes", { count: bytes.length })} ·{" "}
        <code>
          {formatHex(bytes.subarray(0, 12))}
          {bytes.length > 12 ? " …" : ""}
        </code>
      </summary>
      {expanded && (
        <pre
          className="max-h-32 overflow-auto whitespace-pre-wrap break-all"
          tabIndex={0}
        >
          {formatHex(bytes)}
        </pre>
      )}
    </details>
  );
}

export function SendHistoryPanel({
  rows,
  pinned,
  onPin,
  pinError,
  pinSaving,
  pinRetry,
  onRestorePin,
  readingPin,
  hostId,
  destination,
  read,
  watchActions,
  labels,
}: {
  rows: readonly SendHistoryRow[];
  pinned: ReadonlySet<string>;
  onPin?: (id: string) => void;
  pinError?: string;
  pinSaving?: boolean;
  pinRetry?: () => void;
  onRestorePin?: (id: string) => void;
  readingPin?: string;
  hostId: string;
  destination?: Destination;
  read: OperationInputReader;
  watchActions: HostContextValue["watchActions"];
  labels: WorkbenchLabels;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(pageSize);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<HistoryPayload[]>();
  const [phase, setPhase] = useState<"idle" | "reading" | "sending">("idle");
  const [status, setStatus] = useState<"unavailable" | "sent" | "stopped">();
  const [confirmed, setConfirmed] = useState(0);
  const [lastAccepted, setLastAccepted] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  const inputs = useMemo<HostActionCheckInput[]>(
    () =>
      selected.map((operationId) => ({
        actionId: "operation.input",
        target: { hostId, kind: "host", id: hostId },
        params: { operationId },
      })),
    [hostId, selected],
  );
  const allowed = useToolActionAvailability(inputs, watchActions);
  const readable = inputs.length > 0 && inputs.every(allowed);
  const busy = phase !== "idle";
  const retainedIds = new Set(
    rows.map(({ operation }) => operation.operationId),
  );
  const allRetained = selected.every((id) => retainedIds.has(id));
  useLayoutEffect(() => {
    if ((!readable || !allRetained) && preview) {
      setPreview(undefined);
      pending.current?.abort();
    }
  }, [preview, readable, allRetained]);
  const matching = filterHistoryRows(rows, search);
  const unavailablePins = [...pinned].filter((id) => !retainedIds.has(id));

  function toggle(id: string) {
    setPreview(undefined);
    setStatus(undefined);
    setSelected((before) =>
      before.includes(id)
        ? before.filter((value) => value !== id)
        : before.length < maxHistoryBatch
          ? [...before, id]
          : before,
    );
  }

  async function run(phase: "reading" | "sending", batch?: HistoryPayload[]) {
    if (pending.current || !readable || !allRetained) return;
    const controller = new AbortController();
    const { signal } = controller;
    pending.current = controller;
    setPhase(phase);
    setStatus(undefined);
    setConfirmed(0);
    setLastAccepted(undefined);
    try {
      if (phase === "reading") {
        const payloads: HistoryPayload[] = [];
        for (const id of selected)
          payloads.push(await readHistoryPayload(read, id, signal));
        if (pending.current === controller) {
          setPreview(payloads);
        }
      } else if (destination && batch) {
        await resendHistoryBatch({
          batch,
          target: destination.target,
          read,
          send: destination.send,
          wait: destination.wait,
          onAccepted: (id) => {
            if (pending.current === controller) setLastAccepted(id);
          },
          onConfirmed: () => {
            if (pending.current === controller)
              setConfirmed((value) => value + 1);
          },
          signal,
        });
        if (pending.current === controller) setStatus("sent");
      }
    } catch {
      if (pending.current === controller) {
        setPreview(undefined);
        setStatus(phase === "reading" ? "unavailable" : "stopped");
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setPhase("idle");
      }
    }
  }

  return (
    <section className="grid gap-3">
      <label className="grid gap-1">
        {t("sendHistory.search")}
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setCount(pageSize);
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t("sendHistory.selected", {
          count: selected.length,
          max: maxHistoryBatch,
        })}
      </p>
      {matching.length === 0 && <p>{t("sendHistory.empty")}</p>}
      {matching.length > 0 && (
        <div className="max-h-72 overflow-auto">
          <ul className="divide-y">
            {matching.slice(0, count).map(({ operation, port }) => {
              const id = operation.operationId;
              const checked = selected.includes(id);
              return (
                <li key={id} className="flex items-center gap-3 py-2">
                  <label className="flex min-w-0 flex-1 items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      disabled={
                        busy || (!checked && selected.length >= maxHistoryBatch)
                      }
                      onChange={() => toggle(id)}
                    />
                    <span className="grid min-w-0 gap-1">
                      <span className="break-all">
                        {port ?? t("sendHistory.portUnavailable")} ·{" "}
                        <time dateTime={operation.acceptedAt}>
                          {operation.acceptedAt}
                        </time>
                      </span>
                      <span className="break-all text-xs text-muted-foreground">
                        {operation.target.sessionId} [
                        {operation.target.sessionEpoch}] ·{" "}
                        {labels.operationText.states[operation.state]} · {id}
                      </span>
                    </span>
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={pinned.has(id)}
                    disabled={!onPin || pinSaving || busy}
                    onClick={() => onPin?.(id)}
                  >
                    {t(
                      pinned.has(id) ? "sendHistory.unpin" : "sendHistory.pin",
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
          {matching.length > count && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCount(count + pageSize)}
            >
              {t("sendHistory.more")}
            </Button>
          )}
        </div>
      )}
      {unavailablePins.length > 0 && (
        <details>
          <summary>
            {t("sendHistory.pinsOutsideHistory", {
              count: unavailablePins.length,
            })}
          </summary>
          <ul className="divide-y">
            {unavailablePins.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 py-1"
              >
                <span className="mr-auto break-all font-mono text-sm">
                  {id}
                </span>
                {onRestorePin && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!readingPin || busy}
                    onClick={() => onRestorePin(id)}
                  >
                    {t(
                      readingPin === id
                        ? "sendHistory.readingPin"
                        : "sendHistory.restorePin",
                    )}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!onPin || pinSaving || busy}
                  onClick={() => onPin?.(id)}
                >
                  {t("sendHistory.unpin")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {pinError && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <span>
            {t("sendHistory.pinError", {
              error: labels.operationText.failure(pinError),
            })}
          </span>
          {pinRetry && (
            <Button size="sm" variant="outline" onClick={pinRetry}>
              {t("sendHistory.retryPins")}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !readable || !allRetained}
          onClick={() => void run("reading")}
        >
          {t("sendHistory.preview")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || selected.length === 0}
          onClick={() => {
            setSelected([]);
            setPreview(undefined);
            setStatus(undefined);
          }}
        >
          {t("sendHistory.clearSelection")}
        </Button>
      </div>
      {selected.length > 0 && (!readable || !allRetained) && (
        <p className="text-sm text-muted-foreground">
          {t("sendHistory.unavailable")}
        </p>
      )}
      {preview && readable && allRetained && (
        <div className="grid gap-2 rounded-md border p-3">
          <p className="break-all">
            {destination
              ? t("sendHistory.destination", {
                  port: destination.port,
                  session: destination.target.id,
                  epoch: destination.target.sessionEpoch ?? "",
                })
              : t("sendHistory.noDestination")}
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            {preview.map(({ operationId, bytes }) => (
              <li key={operationId} className="break-all">
                <span className="text-xs text-muted-foreground">
                  {operationId}
                </span>
                <PayloadBytes bytes={bytes} />
              </li>
            ))}
          </ol>
          {phase === "sending" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => pending.current?.abort()}
            >
              {t("sendHistory.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || !destination || status === "sent"}
              onClick={() => void run("sending", preview)}
            >
              {t("sendHistory.resend")}
            </Button>
          )}
        </div>
      )}
      <div role="status" className="text-sm">
        {phase === "reading" && t("sendHistory.reading")}
        {phase === "sending" && t("sendHistory.progress", { count: confirmed })}
        {status === "unavailable" && t("sendHistory.unavailable")}
        {status === "sent" && t("sendHistory.sent", { count: confirmed })}
        {status === "stopped" && t("sendHistory.stopped", { count: confirmed })}
        {lastAccepted && (
          <span className="block break-all">
            {t("sendHistory.lastAccepted", { id: lastAccepted })}
          </span>
        )}
      </div>
    </section>
  );
}
