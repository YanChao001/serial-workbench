import { useMemo, useRef, useState } from "react";
import type {
  FileTransferParams,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import type { SelectedFileResource } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatByteSize } from "./metric-format";
import { nativeErrorCode } from "@/lib/native-error";
import { parseU64, U64_MAX } from "@/lib/u64";
import { WorkbenchNotice } from "./workbench-notice";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { OperationText } from "./operation-text";
import { OperationActions } from "./operation-actions";
import {
  isTransferActive,
  TransferProgress,
  type TransferReadProgressReader,
} from "./transfer-progress";
import { useToolAction, useToolDraft } from "./transfer-capture-actions";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

import { useToolActionAvailability } from "./use-tool-action-availability";
import { useTransferFileDrop } from "./use-transfer-file-drop";

export type TransferOptionsLabels = Record<
  | "transferOptions"
  | "selectSource"
  | "dropSource"
  | "source"
  | "offset"
  | "length"
  | "chunkBytes"
  | "bytesPerSecond"
  | "interChunkMs"
  | "writeWaitMs"
  | "preview"
  | "sendFile"
  | "invalidRange"
  | "transferEvidence"
  | "unavailable"
  | "draft"
  | "saveUnavailable"
  | "cancel"
  | "cancelRequested",
  string
> & {
  basic: string;
  advanced: string;
  fileSize: string;
  operationText: OperationText;
};
export type TransferDraft = Pick<
  FileTransferParams,
  | "offset"
  | "length"
  | "chunkBytes"
  | "bytesPerSecond"
  | "interChunkMs"
  | "writeWaitMs"
>;
export type TransferOptionsProps = {
  /** Include attachment generation and session epoch. Changes discard selected references. */
  contextKey: string;
  target?: Target;
  watchActions: HostContextValue["watchActions"];
  labels: TransferOptionsLabels;
  writeWaitMs: string;
  disabled?: boolean;
  operations?: readonly Operation[];
  readTransferProgress?: TransferReadProgressReader;
  initialDraft?: TransferDraft;
  pickSource?: (signal?: AbortSignal) => Promise<SelectedFileResource | null>;
  pickDroppedSource?: HostContextValue["pickDroppedFile"];
  onTransfer?: (
    params: FileTransferParams,
    signal?: AbortSignal,
  ) => Promise<Operation>;
  onSaveDraft?: (draft: TransferDraft, signal?: AbortSignal) => Promise<void>;
  onCancel?: (operation: Operation, signal?: AbortSignal) => Promise<void>;
};
export function TransferOptions(props: TransferOptionsProps) {
  return <TransferOptionsForm key={props.contextKey} {...props} />;
}
function TransferOptionsForm({
  labels,
  writeWaitMs,
  disabled,
  initialDraft,
  pickSource,
  pickDroppedSource,
  onTransfer,
  onSaveDraft,
  onCancel,
  target,
  watchActions,
  operations,
  readTransferProgress,
}: TransferOptionsProps) {
  const [source, setSource] = useState<SelectedFileResource>();
  const [draft, setDraft] = useState<TransferDraft>(
    initialDraft ?? {
      offset: "0",
      length: "0",
      chunkBytes: "4096",
      bytesPerSecond: "1048576",
      interChunkMs: "0",
      writeWaitMs,
    },
  );
  const action = useToolAction((reason) =>
    labels.operationText.failure(nativeErrorCode(reason)),
  );
  const [submitted, setSubmitted] = useState<Operation>();
  const candidates =
    operations?.filter(
      (value) =>
        value.actionId === "transfer.file" &&
        value.target.hostId === target?.hostId &&
        value.target.id === target?.id &&
        value.target.sessionEpoch === target?.sessionEpoch,
    ) ?? [];
  const current = submitted
    ? (candidates.find(
        (value) =>
          value.operationId === submitted.operationId &&
          value.executionHostId === submitted.executionHostId,
      ) ?? submitted)
    : (candidates.find((value) => isTransferActive(value.state)) ??
      candidates[0]);
  const active = !!current && isTransferActive(current.state);
  useToolDraft(
    draft,
    labels.draft,
    labels.saveUnavailable,
    setDraft,
    onSaveDraft,
  );
  const offset = parseU64(draft.offset),
    length = parseU64(draft.length);
  const chunk = parseU64(draft.chunkBytes ?? ""),
    rate = parseU64(draft.bytesPerSecond);
  const interval = parseU64(draft.interChunkMs),
    wait = parseU64(draft.writeWaitMs);
  const total = source ? parseU64(source.length) : undefined;
  const valid =
    offset !== undefined &&
    length !== undefined &&
    total !== undefined &&
    offset + length <= total &&
    offset + length <= U64_MAX &&
    chunk !== undefined &&
    chunk > 0n &&
    rate !== undefined &&
    rate > 0n &&
    interval !== undefined &&
    wait !== undefined &&
    wait > 0n;
  const locked = Boolean(disabled || action.busy || active);
  const inputs = useMemo<HostActionCheckInput[]>(
    () =>
      target && source && valid
        ? [
            {
              actionId: "transfer.file",
              target,
              params: { ...draft, sourceRef: source.reference },
            },
          ]
        : [],
    [target, source, valid, draft],
  );
  const allowed = useToolActionAvailability(inputs, watchActions);
  const dropZone = useRef<HTMLDivElement>(null);
  function acceptSource(
    selected: SelectedFileResource | null,
    signal: AbortSignal,
  ) {
    if (!selected || signal.aborted) return;
    setSource(selected);
    setSubmitted(undefined);
    setDraft((current) => ({
      ...current,
      offset: "0",
      length: selected.length,
    }));
  }
  useTransferFileDrop(dropZone, !!pickDroppedSource, (drop) => {
    if (locked || !pickDroppedSource) return;
    void action.run(async (signal) => {
      acceptSource(await pickDroppedSource(drop, signal), signal);
    });
  });
  return (
    <section
      aria-label={labels.transferOptions}
      aria-busy={action.busy}
      className="workbench-tool-form"
    >
      <h3 className="sr-only">{labels.transferOptions}</h3>
      <Tabs defaultValue="basic" className="workbench-tool-pages">
        <TabsList aria-label={labels.transferOptions}>
          <TabsTrigger value="basic">{labels.basic}</TabsTrigger>
          <TabsTrigger value="advanced">{labels.advanced}</TabsTrigger>
        </TabsList>
        <TabsContent value="basic" className="workbench-tool-page">
          <div className="workbench-form-fields">
            <div className="workbench-form-row">
              <span>{labels.source}</span>
              <div className="workbench-file-selection" ref={dropZone}>
                <output
                  aria-label={labels.source}
                  title={source?.name}
                  data-surface="control"
                >
                  {source?.name ??
                    (pickDroppedSource
                      ? labels.dropSource
                      : labels.selectSource)}
                </output>
                <WorkbenchIconButton
                  label={labels.selectSource}
                  variant="outline"
                  disabled={locked || !pickSource}
                  onClick={() =>
                    void action.run(async (signal) => {
                      acceptSource(await pickSource!(signal), signal);
                    })
                  }
                >
                  <FolderOpen aria-hidden="true" />
                </WorkbenchIconButton>
              </div>
            </div>
            <div className="workbench-form-row">
              <span>{labels.fileSize}</span>
              <output title={source?.length}>
                {source ? formatByteSize(source.length) : "—"}
              </output>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="advanced" className="workbench-tool-page">
          <fieldset disabled={locked}>
            <legend className="sr-only">{labels.transferOptions}</legend>
            <div className="workbench-form-fields">
              {(
                [
                  "offset",
                  "length",
                  "chunkBytes",
                  "bytesPerSecond",
                  "interChunkMs",
                  "writeWaitMs",
                ] as const
              ).map((field) => (
                <label key={field}>
                  <span>{labels[field]}</span>
                  <Input
                    inputMode="numeric"
                    value={draft[field] ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [field]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {valid ? (
            <output aria-label={labels.preview}>
              [{draft.offset}, {(offset! + length!).toString()}) /{" "}
              {source?.length}
            </output>
          ) : (
            source && <p role="status">{labels.invalidRange}</p>
          )}
        </TabsContent>
      </Tabs>
      {current && (
        <>
          <output role="status">
            {labels.operationText.states[current.state]}
          </output>
          <TransferProgress
            operation={current}
            labels={labels.operationText.transfer}
            readProgress={readTransferProgress}
          />
          {active && onCancel && (
            <OperationActions
              operation={current}
              watchActions={watchActions}
              labels={{
                operation: labels.sendFile,
                cancel: labels.cancel,
                cancelRequested: labels.cancelRequested,
              }}
              formatError={labels.operationText.failure}
              onCancel={(_id, signal) => onCancel(current, signal)}
            />
          )}
        </>
      )}
      <div className="workbench-tool-footer">
        <span className="sr-only">
          {!onTransfer ? labels.unavailable : undefined}
        </span>
        <Button
          size="sm"
          disabled={
            locked ||
            !allowed(inputs[0]) ||
            !valid ||
            !onTransfer ||
            source?.reference.kind !== "file" ||
            !source.reference.revision
          }
          onClick={() =>
            void action.run(async (signal) => {
              if (
                locked ||
                !source ||
                !valid ||
                !onTransfer ||
                !allowed(inputs[0])
              )
                return;
              const operation = await onTransfer(
                { ...draft, sourceRef: source.reference },
                signal,
              );
              if (!signal.aborted) setSubmitted(operation);
            })
          }
        >
          {labels.sendFile}
        </Button>
      </div>
      <WorkbenchNotice
        eventKey={action.eventKey}
        noticeKey={`transfer:${action.failureIndex}`}
        log={
          action.error
            ? {
                module: "transfer",
                level: "error",
                message: action.error,
                code: action.errorCode,
              }
            : undefined
        }
      >
        {action.error && <p role="alert">{action.error}</p>}
      </WorkbenchNotice>
    </section>
  );
}
