import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { TX_MAX_BYTES, type TxReceipt } from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorText } from "@/lib/native-error";
import { requestOperationCancel } from "@/lib/operation-cancel";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  broadcastActive,
  broadcastTargetLimit,
  canStopBroadcast,
  startBroadcast,
  type BroadcastDestination,
  type BroadcastRow,
} from "./broadcast-send";
import { formatSerialLine } from "./serial-configuration";

export type BroadcastMemory = Map<string, ReturnType<typeof startBroadcast>>;

const emptyRows: readonly BroadcastRow[] = [];
const readEmpty = () => emptyRows;
const subscribeEmpty = () => () => {};
const byteCount = (ranges: TxReceipt["acceptedRanges"]) =>
  ranges
    .reduce(
      (count, range) => count + BigInt(range.end) - BigInt(range.start),
      0n,
    )
    .toString();

export default function BroadcastSendTool({
  host,
  memory,
  scope,
  draftBytes,
}: {
  host: HostContextValue;
  memory: BroadcastMemory;
  scope: string;
  draftBytes?: Uint8Array;
}) {
  const { t } = useI18n();
  const id = useId();
  const [hex, setHex] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState(() => memory.get(scope));
  const rows = useSyncExternalStore(
    run?.subscribe ?? subscribeEmpty,
    run?.snapshot ?? readEmpty,
  );
  const active = rows.some(broadcastActive);
  const connection = host.connection;
  const candidates = host.state.sessions
    .filter(({ state, readOnly }) => state === "open" && !readOnly)
    .map((session) => ({
      key: JSON.stringify([session.sessionId, session.sessionEpoch]),
      session,
      name:
        host.state.devices.find(({ deviceId }) => deviceId === session.deviceId)
          ?.systemName ?? session.deviceId,
    }));
  const picked = candidates.filter(({ key }) => selected.includes(key));
  const selectionChanged = picked.length !== selected.length;
  const bytes = useMemo(() => {
    try {
      const result = parseHex(hex);
      return result.length > 0 && result.length <= TX_MAX_BYTES
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  }, [hex]);
  const canStart = Boolean(
    connection &&
    host.state.status === "ready" &&
    host.state.catalog.some(
      (action) =>
        action.actionId === "session.tx" &&
        action.targetKinds.includes("session"),
    ) &&
    !active &&
    !selectionChanged &&
    picked.length >= 2 &&
    bytes,
  );

  useUnsavedWork({
    id,
    label: t("broadcastSend.title"),
    dirty,
    discard: () => {
      setHex("");
      setSelected([]);
      setDirty(false);
    },
  });

  function start() {
    if (
      !canStart ||
      !connection ||
      !bytes ||
      memory.get(scope)?.snapshot().some(broadcastActive)
    )
      return;
    const destinations: BroadcastDestination[] = picked.map(
      ({ session, name }) => ({
        label: name,
        revision: session.revision,
        writeWaitMs: session.configuration.writeWaitMs,
        target: {
          hostId: connection.attachment.hostId,
          kind: "session",
          id: session.sessionId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
        },
      }),
    );
    const started = startBroadcast(destinations, bytes, {
      allowed: async ({ actionId, target, params }, signal) =>
        (await host.checkAction({ actionId, target, params }, signal)).allowed,
      admit: (call) => host.invoke(call),
      observe: async (operation) => {
        try {
          return await host.waitForOperation(
            operation,
            undefined,
            "succeeded",
            250,
          );
        } catch (reason) {
          const result = await connection.client.query(
            connection.buildQuery("operation.get", connection.hostTarget, {
              operationId: operation.operationId,
            }),
          );
          if (result.kind !== "operation") throw reason;
          return result.value.operation;
        }
      },
      cancel: (operation) => requestOperationCancel(host, operation),
    });
    memory.delete(scope);
    memory.set(scope, started);
    const oldest = memory.keys().next().value;
    if (oldest !== undefined && memory.size > 8) memory.delete(oldest);
    setRun(started);
    setDirty(false);
  }

  function rowStatus(row: BroadcastRow) {
    const operation = row.operation;
    const state = operation?.state;
    if (row.phase === "done" && operation?.result?.kind === "tx") {
      const outcome = operation.result.value.outcome;
      return state === "cancelled" && outcome === "rejected"
        ? t("workbench.operation.cancelled")
        : t(`broadcastSend.tx.${outcome}`);
    }
    if (state && (row.phase === "waiting" || row.phase === "done"))
      return t(
        state === "cancel_requested"
          ? "workbench.operation.cancelRequested"
          : `workbench.operation.${state}`,
      );
    return t(`broadcastSend.${row.phase}`);
  }

  return (
    <section className="grid min-w-0 gap-3">
      <p className="text-sm text-muted-foreground">{t("broadcastSend.help")}</p>
      <fieldset
        disabled={active}
        className="grid min-w-0 gap-3 [container-type:inline-size]"
      >
        <div className="grid min-w-0 gap-3 @min-[32rem]:grid-cols-2">
          <div className="grid min-w-0 content-start gap-2">
            <h3 className="text-sm font-medium">
              {t("broadcastSend.targets")}
            </h3>
            <ul className="grid max-h-60 gap-1 overflow-auto rounded-md border p-2">
              {candidates.map(({ key, session, name }) => {
                const checked = selected.includes(key);
                return (
                  <li key={key}>
                    <label className="flex items-start gap-2 rounded-sm p-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={checked}
                        disabled={
                          !checked && selected.length >= broadcastTargetLimit
                        }
                        onChange={() => {
                          setDirty(true);
                          setSelected(
                            picked
                              .map(({ key }) => key)
                              .filter((value) => value !== key)
                              .concat(checked ? [] : [key]),
                          );
                        }}
                      />
                      <span className="grid min-w-0 gap-0.5 wrap-anywhere">
                        <span>{name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatSerialLine(session.configuration)} ·{" "}
                          {session.sessionEpoch}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {selectionChanged && (
              <Button
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() => setSelected(picked.map(({ key }) => key))}
              >
                {t("broadcastSend.resetTargets")}
              </Button>
            )}
            {candidates.length < 2 && (
              <p className="text-sm">{t("broadcastSend.openTwo")}</p>
            )}
          </div>
          <div className="grid min-w-0 content-start gap-2">
            <label htmlFor={id + "-hex"} className="text-sm font-medium">
              {t("broadcastSend.bytes")}
            </label>
            <Textarea
              id={id + "-hex"}
              className="min-h-24 min-w-0 font-mono text-xs"
              spellCheck={false}
              value={hex}
              maxLength={TX_MAX_BYTES * 3}
              aria-invalid={Boolean(hex.trim() && !bytes) || undefined}
              onChange={(event) => {
                setHex(event.target.value);
                setDirty(true);
              }}
            />
            {draftBytes &&
              draftBytes.length > 0 &&
              draftBytes.length <= TX_MAX_BYTES && (
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() => {
                    setHex(formatHex(draftBytes));
                    setDirty(true);
                  }}
                >
                  {t("repeatSend.useDraft")}
                </Button>
              )}
            {bytes ? (
              <p className="font-mono text-xs wrap-anywhere">
                {formatHex(bytes.subarray(0, 64))}
                {bytes.length > 64 ? " …" : ""}
              </p>
            ) : (
              hex.trim() && (
                <p className="text-sm text-destructive">
                  {t("repeatSend.invalidHex")}
                </p>
              )
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!canStart} onClick={start}>
            {t("broadcastSend.confirm")}
          </Button>
          {bytes && (
            <p className="text-sm tabular-nums">
              {t("broadcastSend.preview", {
                bytes: bytes.length,
                ports: picked.length,
              })}
            </p>
          )}
        </div>
      </fieldset>
      {rows.length > 0 && (
        <section
          aria-label={t("broadcastSend.results")}
          className="grid min-w-0 gap-2 border-t pt-3"
        >
          <h3 className="font-medium">{t("broadcastSend.results")}</h3>
          <ul className="grid min-w-0 gap-2">
            {rows.map((row, index) => {
              const receipt =
                row.operation?.result?.kind === "tx"
                  ? row.operation.result.value
                  : undefined;
              return (
                <li
                  key={row.destination.target.id}
                  data-surface="reading"
                  className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm wrap-anywhere"
                >
                  <div className="grid min-w-0 flex-1 basis-44 gap-1">
                    <p className="font-medium">{row.destination.label}</p>
                    <div role="status" className="grid gap-1">
                      <p>{rowStatus(row)}</p>
                      {row.stop === "queued" ||
                      (row.stop === "requested" && broadcastActive(row)) ? (
                        <p>{t("broadcastSend.stopPending")}</p>
                      ) : null}
                      {receipt && (
                        <p className="tabular-nums">
                          {t("broadcastSend.receipt", {
                            accepted: byteCount(receipt.acceptedRanges),
                            unknown: byteCount(receipt.unknownRanges),
                          })}
                        </p>
                      )}
                    </div>
                    {row.operation && (
                      <code className="text-xs text-muted-foreground">
                        {row.operation.operationId}
                      </code>
                    )}
                    {(row.error ?? row.operation?.error) ? (
                      <p className="text-destructive">
                        {nativeErrorText(row.error ?? row.operation?.error, t)}
                      </p>
                    ) : null}
                    {row.stopError ? (
                      <p className="text-destructive">
                        {nativeErrorText(row.stopError, t)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {canStopBroadcast(row) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run?.stop(index)}
                      >
                        {t("broadcastSend.stop")}
                      </Button>
                    )}
                    {row.phase === "unknown" && row.operation && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run?.recheck(index)}
                      >
                        {t("broadcastSend.recheck")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
