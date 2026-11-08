import type {
  CaptureRecord,
  Operation,
  ReplayControlParams,
  ReplayReadParams,
  ReplayReadResult,
  ReplayRecord,
  SessionSnapshot,
  TerminalSettings,
} from "@serial-workbench/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { captureRecordItems } from "./capture-record-items";
import { StreamView } from "./stream-view";
import type { WorkbenchLabels } from "./labels";
import type { StreamPresentationLabels } from "./stream-presentation";
export type ReplayReader = (
  params: ReplayReadParams,
  signal?: AbortSignal,
) => Promise<ReplayReadResult>;
export type ReplayRecordReader = (
  record: Extract<ReplayRecord, { kind: "reference" }>,
  signal?: AbortSignal,
) => Promise<CaptureRecord>;
export type ReplayController = (
  params: ReplayControlParams,
  signal?: AbortSignal,
) => Promise<Operation>;
export type ReplayPanelProps = {
  session: SessionSnapshot;
  read: ReplayReader;
  readRecord: ReplayRecordReader;
  control: ReplayController;
  disabled: boolean;
  labels: WorkbenchLabels;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
};
export function ReplayPanel({
  session,
  read,
  readRecord,
  control,
  disabled,
  labels,
  terminalSettings,
  presentationLabels,
}: ReplayPanelProps) {
  const [page, setPage] = useState<ReplayReadResult>();
  const [expanded, setExpanded] = useState<Record<string, CaptureRecord>>({});
  const [seek, setSeek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setPage(undefined);
    setExpanded({});
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [read, readRecord]);
  async function act(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const records =
    page?.records.flatMap((record) =>
      record.kind === "inline"
        ? [record.record]
        : expanded[record.recordOrdinal]
          ? [expanded[record.recordOrdinal]!]
          : [],
    ) ?? [];
  const items = captureRecordItems(records);
  const sendControl = (paused: boolean, seekRecord?: string) =>
    act(async (signal) => {
      await control(
        {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          paused,
          ...(seekRecord !== undefined ? { seekRecord } : {}),
        },
        signal,
      );
      if (!signal.aborted && seekRecord !== undefined) {
        setPage(undefined);
        setExpanded({});
      }
    });
  const validSeek =
    /^(0|[1-9][0-9]*)$/.test(seek) && BigInt(seek) <= 18446744073709551615n;
  return (
    <section aria-label={labels.replay}>
      <div className="workbench-toolbar">
        <h2>{labels.replay}</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async (signal) => {
              const result = await read(
                {
                  sessionId: session.sessionId,
                  sessionEpoch: session.sessionEpoch,
                  maxRecords: "100",
                  maxBytes: "65536",
                },
                signal,
              );
              if (!signal.aborted) {
                setPage(result);
                setExpanded({});
              }
            })
          }
        >
          {labels.readReplay}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void sendControl(true)}
        >
          {labels.pauseReplay}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void sendControl(false)}
        >
          {labels.resumeReplay}
        </Button>
        <Input
          aria-label={labels.seekRecord}
          value={seek}
          onChange={(event) => setSeek(event.target.value)}
          inputMode="numeric"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy || !validSeek}
          onClick={() => void sendControl(true, seek)}
        >
          {labels.seekRecord}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {page?.atEnd && <p role="status">{labels.atEnd}</p>}
      {page?.records.map((record) =>
        record.kind === "reference" && !expanded[record.recordOrdinal] ? (
          <Button
            key={record.recordOrdinal}
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async (signal) => {
                const result = await readRecord(record, signal);
                if (!signal.aborted)
                  setExpanded((current) => ({
                    ...current,
                    [record.recordOrdinal]: result,
                  }));
              })
            }
          >
            {labels.readReplay} {record.recordOrdinal}
          </Button>
        ) : null,
      )}
      {page && (
        <StreamView
          key={page.readerGeneration}
          items={items}
          labels={labels}
          terminalSettings={terminalSettings}
          presentationLabels={presentationLabels}
        />
      )}
      {records.map((record) =>
        record.entry.kind === "tx_settlement" ? (
          <p key={record.recordOrdinal}>
            {labels.receipt}: {record.entry.value.receipt.operationId} ·{" "}
            {record.entry.value.receipt.outcome} [
            {record.entry.value.receipt.byteStart},{" "}
            {record.entry.value.receipt.byteEnd})
          </p>
        ) : null,
      )}
    </section>
  );
}
