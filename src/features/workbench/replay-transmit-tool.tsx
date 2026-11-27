import { useEffect, useId, useMemo, useState } from "react";
import type {
  OperationSummary,
  OperationState,
  ReplayTransmitPreview,
  ReplayTransmitSelection,
  SourceRange,
  Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { requestOperationCancel } from "@/lib/operation-cancel";
import type { SelectedFileResource } from "@/lib/tauri";
import { rpcJsonObject } from "@/lib/rpc-json";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { formatSerialLine } from "./serial-configuration";
import { operationText } from "./operation-text";
import { useToolAction } from "./transfer-capture-actions";

const sourceFields = [
  "hostId",
  "sessionId",
  "sessionEpoch",
  "eventStart",
  "eventEnd",
] as const;
const emptySource = {
  hostId: "",
  sessionId: "",
  sessionEpoch: "",
  eventStart: "",
  eventEnd: "",
};
const UINT64_MAX = 18_446_744_073_709_551_615n;

function positiveCounter(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= UINT64_MAX;
}

function sourceRange(fields: typeof emptySource): SourceRange | undefined {
  if (
    !fields.hostId ||
    !fields.sessionId ||
    !positiveCounter(fields.sessionEpoch) ||
    !positiveCounter(fields.eventStart) ||
    !positiveCounter(fields.eventEnd) ||
    BigInt(fields.eventStart) >= BigInt(fields.eventEnd)
  )
    return;
  return { ...fields, direction: "tx" };
}

function active(state: OperationState | undefined): boolean {
  return (
    state === "queued" || state === "running" || state === "cancel_requested"
  );
}

export default function ReplayTransmitTool({
  host,
  revealedOperationId,
}: {
  host: HostContextValue;
  revealedOperationId?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [resource, setResource] = useState<SelectedFileResource | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [rate, setRate] = useState("1024");
  const [sourceFieldsDraft, setSourceFieldsDraft] = useState(emptySource);
  const [preview, setPreview] = useState<{
    key: string;
    value: ReplayTransmitPreview;
    selection: ReplayTransmitSelection;
  }>();
  const [acceptedId, setAcceptedId] = useState<string>();
  const [availability, setAvailability] = useState<{
    scope: object;
    canRead: boolean;
    allowed: boolean;
  }>();
  const formatError = (error: unknown) =>
    nativeErrorCode(error) === "REPLAY_PEER_LIMIT"
      ? t("workbench.replayTransmit.limit")
      : nativeErrorText(error, t);
  const prepare = useToolAction(formatError);
  const transmit = useToolAction(formatError);
  const stop = useToolAction(formatError);
  const { devices, sessions, replaySessionEpochs } = host.state;
  const selected = sessions.find((item) => item.sessionId === selectedId);
  const candidates = sessions.filter(
    (item) =>
      item.state === "open" &&
      item.txGate === "ready" &&
      !item.readOnly &&
      item.capabilities.semantics === "stream" &&
      replaySessionEpochs?.get(item.sessionId) !== item.sessionEpoch,
  );
  const hostId = host.connection?.attachment.hostId;
  const target: Target | undefined =
    hostId && selected && candidates.includes(selected)
      ? {
          hostId,
          kind: "session",
          id: selected.sessionId,
          sessionId: selected.sessionId,
          sessionEpoch: selected.sessionEpoch,
        }
      : undefined;
  const scopedSource = sourceRange(sourceFieldsDraft);
  const scoped = sourceFields.some((field) => sourceFieldsDraft[field] !== "");
  const rateValid = positiveCounter(rate) && BigInt(rate) <= 16_777_216n;
  const selection: ReplayTransmitSelection | undefined =
    resource && rateValid && (!scoped || scopedSource)
      ? {
          captureRef: resource.reference,
          direction: "tx",
          bytesPerSecond: rate,
          ...(scopedSource ? { sourceRange: scopedSource } : {}),
        }
      : undefined;
  const key =
    target && selection
      ? JSON.stringify([target, selected?.revision, selection])
      : undefined;
  const prepared = preview?.key === key ? preview : undefined;
  const planned = prepared?.value;
  const plannedParams = useMemo(
    () =>
      prepared
        ? rpcJsonObject({
            selection: prepared.selection,
            previewDigest: prepared.value.previewDigest,
          })
        : undefined,
    [prepared],
  );
  const { watchActions } = host;
  useEffect(() => {
    if (!prepared || !plannedParams) return;
    // A fresh preview can subscribe while the observer still holds an earlier denial.
    let wasReadable = false;
    return watchActions(
      [
        {
          actionId: "replay.transmit.preview",
          target: prepared.value.target,
          params: rpcJsonObject(prepared.selection),
        },
        {
          actionId: "replay.transmit",
          target: prepared.value.target,
          params: plannedParams,
        },
      ],
      ([read, write]) => {
        const canRead = read?.result?.allowed === true && !read.error;
        setAvailability({
          scope: plannedParams,
          canRead,
          allowed: canRead && write?.result?.allowed === true && !write.error,
        });
        if (wasReadable && (read?.result?.allowed === false || read?.error))
          setPreview((current) => (current === prepared ? undefined : current));
        wasReadable ||= canRead;
      },
    );
  }, [prepared, plannedParams, watchActions]);

  const { operations, operationSummaries } = host.state;
  const actorId = host.connection?.attachment.actorId;
  const latest = [...operations, ...operationSummaries].reduce<
    OperationSummary | undefined
  >((current, item) => {
    if (item.actorId !== actorId || item.actionId !== "replay.transmit")
      return current;
    return !current || item.acceptedAt > current.acceptedAt ? item : current;
  }, undefined);
  const operationId = acceptedId ?? revealedOperationId ?? latest?.operationId;
  const detail = operations.find((item) => item.operationId === operationId);
  const summary = operationSummaries.find(
    (item) => item.operationId === operationId,
  );
  const operation =
    detail && (!summary || BigInt(detail.revision) >= BigInt(summary.revision))
      ? detail
      : undefined;
  const operationState = operation?.state ?? summary?.state;
  const stopTarget = summary ?? detail;
  const busy = prepare.busy || transmit.busy || active(operationState);
  const visible =
    availability?.scope === plannedParams && availability?.canRead === true;
  const bytes = useMemo(
    () =>
      planned
        ? Uint8Array.from(atob(planned.bytesBase64), (value) =>
            value.charCodeAt(0),
          )
        : undefined,
    [planned],
  );
  const body = useMemo(() => (bytes ? formatHex(bytes) : ""), [bytes]);

  return (
    <div className="grid min-w-0 gap-4 @container/replay-transmit py-2">
      <div className="grid items-end gap-3 @min-[34rem]/replay-transmit:grid-cols-2">
        <div className="grid min-w-0 gap-2">
          <span className="text-sm font-medium" id={id + "-source"}>
            {t("workbench.replayTransmit.source")}
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-describedby={id + "-source"}
              onClick={() =>
                void prepare.run(async (signal) => {
                  const next = await host.pickFile("capturePeerSource", signal);
                  signal.throwIfAborted();
                  if (next) {
                    setResource(next);
                    setSourceFieldsDraft(emptySource);
                    setPreview(undefined);
                  }
                })
              }
            >
              {t("workbench.replayTransmit.pick")}
            </Button>
            {resource && (
              <span className="min-w-0 wrap-anywhere text-sm">
                {resource.name}
              </span>
            )}
          </div>
        </div>
        <div className="grid min-w-0 gap-2">
          <span className="text-sm font-medium" id={id + "-target"}>
            {t("workbench.replayTransmit.target")}
          </span>
          <Select
            value={target ? selectedId : ""}
            onValueChange={(value) => {
              setSelectedId(value);
              setPreview(undefined);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-labelledby={id + "-target"}>
              <SelectValue
                placeholder={t("workbench.replayTransmit.chooseTarget")}
              />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((candidate) => (
                <SelectItem
                  key={candidate.sessionId}
                  value={candidate.sessionId}
                >
                  {devices.find(
                    (device) => device.deviceId === candidate.deviceId,
                  )?.systemName ?? candidate.deviceId}
                  {" · "}
                  {formatSerialLine(candidate.configuration)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor={id + "-rate"}>
            {t("workbench.replayTransmit.rate")}
          </label>
          <Input
            id={id + "-rate"}
            inputMode="numeric"
            value={rate}
            disabled={busy}
            aria-invalid={!rateValid}
            onChange={(event) => {
              setRate(event.target.value);
              setPreview(undefined);
            }}
          />
        </div>
      </div>
      <details className="grid gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("workbench.replayTransmit.range")}
        </summary>
        <div className="mt-3 grid gap-2 @min-[34rem]/replay-transmit:grid-cols-2">
          {sourceFields.map((field) => (
            <div className="grid gap-1" key={field}>
              <label htmlFor={id + "-" + field} className="text-sm">
                {t(`workbench.replayTransmit.${field}`)}
              </label>
              <Input
                id={id + "-" + field}
                value={sourceFieldsDraft[field]}
                disabled={busy}
                onChange={(event) => {
                  setSourceFieldsDraft((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }));
                  setPreview(undefined);
                }}
              />
            </div>
          ))}
        </div>
        {scoped && !scopedSource && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {t("workbench.replayTransmit.rangeInvalid")}
          </p>
        )}
      </details>
      {visible && planned && bytes && (
        <section
          aria-label={t("workbench.replayTransmit.finalBytes")}
          className="grid min-w-0 gap-2 rounded-md border p-3"
        >
          <p className="text-sm font-medium">
            {t("workbench.replayTransmit.bytesSummary", {
              bytes: bytes.length,
              rate: planned.bytesPerSecond,
            })}
          </p>
          <code
            tabIndex={0}
            className="max-h-36 overflow-auto wrap-anywhere rounded bg-muted p-2 font-mono text-sm"
          >
            {body}
          </code>
          <ul className="grid max-h-36 gap-1 overflow-auto text-sm text-muted-foreground">
            {planned.spans.map((span) => (
              <li key={span.outputOffset}>
                {t("workbench.replayTransmit.span", {
                  record: span.recordOrdinal,
                  from: span.source.byteStart ?? "",
                  to: span.source.byteEnd ?? "",
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!key || !target || !selection || busy}
          onClick={() => {
            if (!key || !target || !selection || !host.previewReplayTransmit)
              return;
            const run = host.previewReplayTransmit;
            setPreview(undefined);
            void prepare.run(async (signal) => {
              const value = await run(target, selection, signal);
              signal.throwIfAborted();
              if (value.targetRevision === selected?.revision)
                setPreview({ key, value, selection });
            });
          }}
        >
          {t("workbench.replayTransmit.preview")}
        </Button>
        <Button
          size="sm"
          disabled={
            !planned ||
            !plannedParams ||
            busy ||
            availability?.scope !== plannedParams ||
            availability?.allowed !== true
          }
          onClick={() => {
            if (!planned || !plannedParams) return;
            void transmit.run(async (signal) => {
              const pending = await host.invoke(
                {
                  actionId: "replay.transmit",
                  target: planned.target,
                  params: plannedParams,
                  expectedRevision: planned.targetRevision,
                  executionMode: "independent",
                },
                signal,
              );
              signal.throwIfAborted();
              setAcceptedId(pending.operationId);
              setPreview(undefined);
              await host.waitForOperation(pending, signal);
            });
          }}
        >
          {t("workbench.replayTransmit.send")}
        </Button>
        {stopTarget && active(operationState) && (
          <Button
            size="sm"
            variant="outline"
            disabled={stop.busy || operationState === "cancel_requested"}
            onClick={() =>
              void stop.run((signal) =>
                requestOperationCancel(host, stopTarget, signal),
              )
            }
          >
            {t("workbench.replayTransmit.stop")}
          </Button>
        )}
      </div>
      {operationState && (
        <p role="status" className="text-sm text-muted-foreground">
          {operationText(t, () => "").states[operationState]}
          {operation?.result?.kind === "file_transfer"
            ? " · " +
              t("workbench.replayTransmit.settled", {
                accepted: operation.result.value.accepted,
                requested: operation.result.value.requested,
                unknown: operation.result.value.unknown,
              })
            : null}
        </p>
      )}
      {(stop.error ?? transmit.error ?? prepare.error) && (
        <p role="alert" className="text-sm text-destructive">
          {stop.error ?? transmit.error ?? prepare.error}
        </p>
      )}
    </div>
  );
}
