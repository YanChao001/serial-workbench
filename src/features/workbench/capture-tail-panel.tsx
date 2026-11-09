import { useEffect, useMemo, useState } from "react";
import type {
  CaptureTailResult,
  ObjectRef,
  TerminalSettings,
} from "@serial-workbench/contracts";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StreamView } from "./stream-view";
import {
  captureRecordItems,
  captureRecordSources,
} from "./capture-record-items";
import type { WorkbenchLabels } from "./labels";
import type { StreamPresentationLabels } from "./stream-presentation";
export type CaptureTailReader = HostContextValue["readCaptureTail"];
export function CaptureTailPanel({
  reference,
  scopeKey,
  ready,
  read,
  watchActions,
  labels,
  terminalSettings,
  presentationLabels,
}: {
  reference: ObjectRef;
  scopeKey: string;
  ready: boolean;
  read?: CaptureTailReader;
  watchActions: HostContextValue["watchActions"];
  labels: WorkbenchLabels;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
}) {
  const { hostId, kind, id, revision } = reference;
  const stableRef = useMemo(
    () => ({
      hostId,
      kind,
      id,
      ...(revision === undefined ? {} : { revision }),
    }),
    [hostId, kind, id, revision],
  );
  const inputs = useMemo<HostActionCheckInput[]>(
    () => [
      {
        actionId: "capture.tail",
        target: { hostId, kind, id },
        params: {
          captureRef: stableRef,
          maxRecords: "100",
          maxBytes: "262144",
        },
      },
    ],
    [stableRef, hostId, kind, id],
  );
  const key = JSON.stringify([scopeKey, stableRef]);
  const [permission, setPermission] = useState<{
    key: string;
    allowed: boolean;
  }>();
  const [loaded, setLoaded] = useState<{
    key: string;
    value?: CaptureTailResult;
    code?: string;
  }>();
  useEffect(() => {
    if (!ready) {
      setPermission(undefined);
      setLoaded(undefined);
      return;
    }
    let active = true;
    const stop = watchActions(inputs, (values) => {
      if (!active) return;
      const allowed = values.some(
        (value) =>
          JSON.stringify(value.input) === JSON.stringify(inputs[0]) &&
          value.result?.allowed === true &&
          value.error === null,
      );
      if (!allowed) setLoaded(undefined);
      setPermission((old) =>
        old?.key === key && old.allowed === allowed ? old : { key, allowed },
      );
    });
    return () => {
      active = false;
      stop();
    };
  }, [ready, watchActions, inputs, key]);
  const allowed = ready && permission?.key === key && permission.allowed;
  useEffect(() => {
    if (!allowed || !read) return;
    const controller = new AbortController();
    setLoaded(undefined);
    void read(stableRef, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setLoaded({ key, value });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const code =
          typeof reason === "object" &&
          reason !== null &&
          "code" in reason &&
          typeof reason.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(reason.code)
            ? reason.code
            : "";
        setLoaded({ key, code });
      });
    return () => controller.abort();
  }, [allowed, read, stableRef, key]);
  const result = allowed && loaded?.key === key ? loaded : undefined;
  const value = result?.value;
  const records =
    value?.records.flatMap((record) =>
      record.kind === "inline" ? [record.record] : [],
    ) ?? [];
  const unknownTx = records.flatMap((record) =>
    record.entry.kind === "tx_settlement" &&
    record.entry.value.receipt.outcome === "unknown"
      ? [record.entry.value.receipt.outcome]
      : [],
  )[0];
  const errors: Record<string, string> = {
    CAPTURE_ACTIVE: labels.captureActive,
    HOST_BUSY: labels.captureBusy,
    SOURCE_CHANGED: labels.captureChanged,
    REVISION_CONFLICT: labels.captureRevision,
    PERMISSION_DENIED: labels.captureDenied,
  };
  return (
    <section
      aria-label={labels.captureTail}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden"
    >
      {!ready || !read ? (
        <p role="status">{labels.unavailable}</p>
      ) : !allowed ? (
        <p role="status">{labels.captureDenied}</p>
      ) : !result ? (
        <p role="status">{labels.captureLoading}</p>
      ) : undefined}
      {result?.code !== undefined && (
        <p role="alert">{errors[result.code] ?? labels.unavailable}</p>
      )}
      {value && (
        <>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            <span className="text-muted-foreground">{labels.readOnly}</span>
            {!value.containerComplete && (
              <span role="status" aria-label={labels.capturePartial}>
                {labels.containerComplete}: {labels.captureNo}
              </span>
            )}
            {unknownTx && (
              <span role="status" aria-label={labels.txUnknownBytes}>
                TX · {unknownTx}
              </span>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`${labels.captureTail} · ${labels.expand}`}
                >
                  {labels.expand}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                aria-label={labels.captureTail}
                className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-auto"
              >
                <PopoverTitle>{labels.captureTail}</PopoverTitle>
                <dl className="px-3 text-xs space-y-1">
                  <div>
                    <dt>{labels.captureFingerprint}</dt>
                    <dd className="break-all">{value.sourceFingerprint}</dd>
                  </div>
                  <div>
                    <dt>{labels.status}</dt>
                    <dd>{value.state}</dd>
                  </div>
                  <div>
                    <dt>{labels.verified}</dt>
                    <dd>{value.verifiedPrefix}</dd>
                  </div>
                  {(["containerComplete", "sourceContinuous"] as const).map(
                    (field) => (
                      <div key={field}>
                        <dt>{labels[field]}</dt>
                        <dd>
                          {value[field] ? labels.captureYes : labels.captureNo}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
                <p className="px-3 text-xs">
                  {labels.captureFirstRecord}: {value.firstRecord}
                </p>
                <details className="px-3 text-xs">
                  <summary>{labels.captureSource}</summary>
                  <ul>
                    {captureRecordSources(records).map((source) => (
                      <li key={source}>{source}</li>
                    ))}
                  </ul>
                </details>
                {!value.containerComplete && (
                  <p role="status">{labels.capturePartial}</p>
                )}
                {value.records.map((record) =>
                  record.kind === "reference" ? (
                    <p
                      key={record.recordOrdinal}
                      className="px-3 text-xs break-all"
                    >
                      {labels.captureLargeRecord} #{record.recordOrdinal} ·{" "}
                      {record.jsonBytes} {labels.bytes} · SHA-256{" "}
                      {record.jsonSha256}
                    </p>
                  ) : null,
                )}
                {records.map((record) =>
                  record.entry.kind === "tx_settlement" ? (
                    <p key={record.recordOrdinal}>
                      {labels.receipt}: {record.entry.value.receipt.operationId}{" "}
                      · {record.entry.value.receipt.outcome} [
                      {record.entry.value.receipt.byteStart},{" "}
                      {record.entry.value.receipt.byteEnd})
                    </p>
                  ) : null,
                )}
              </PopoverContent>
            </Popover>
          </div>
          {!value.records.length && <p role="status">{labels.captureEmpty}</p>}
          <StreamView
            key={key}
            items={captureRecordItems(records)}
            labels={labels}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
          />
        </>
      )}
    </section>
  );
}
