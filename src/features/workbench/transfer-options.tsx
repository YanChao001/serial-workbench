import { useEffect, useMemo, useRef, useState } from "react";
import { formatHex } from "@serial-workbench/host-client";
import {
  BROWSER_FILE_LIMIT,
  type BrowserFileProgress,
} from "@/lib/browser-file-transfer";
import type {
  FileTransferParams,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import type { SelectedFileResource } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { useBrowserFileDrop } from "./use-browser-file-drop";

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
  browserFile: {
    unavailable: string;
    invalidFile: string;
    sample: string;
    sampleUnavailable: string;
    upload: string;
    submitting: string;
    cancelUpload: string;
    uploadCancelled: string;
    stopSending: string;
    receiptPending: string;
    checkReceipt: string;
    noReceipt: string;
  };
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
  browserFile?: HostContextValue["browserFile"];
  browserTransferAvailable?: boolean;
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
  browserFile,
  browserTransferAvailable,
}: TransferOptionsProps) {
  const [source, setSource] = useState<SelectedFileResource>();
  const [browserSource, setBrowserSource] = useState<File>();
  const [selectionError, setSelectionError] = useState(false);
  const [browserProgress, setBrowserProgress] = useState<BrowserFileProgress>();
  const [feedback, setFeedback] = useState<string>();
  const [cancellingUpload, setCancellingUpload] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const isBrowser = Boolean(browserFile);
  const browserLabels = labels.browserFile;
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
      (browserSource ? undefined : candidates[0]));
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
  const sourceName = browserSource?.name ?? source?.name;
  const sourceLength = browserSource
    ? String(browserSource.size)
    : source?.length;
  const total = sourceLength ? parseU64(sourceLength) : undefined;
  const valid =
    offset !== undefined &&
    length !== undefined &&
    total !== undefined &&
    (!isBrowser || length > 0n) &&
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
  const needsReceipt = browserFile?.hasPending() ?? false;
  const browserInputs = useMemo<HostActionCheckInput[]>(
    () =>
      target && isBrowser && browserTransferAvailable
        ? [
            {
              actionId: "session.tx",
              target,
              params: { bytesBase64: "AA==", writeWaitMs: "1000" },
            },
          ]
        : [],
    [target, isBrowser, browserTransferAvailable],
  );
  const desktopInputs = useMemo<HostActionCheckInput[]>(
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
  const inputs = isBrowser ? browserInputs : desktopInputs;
  const allowed = useToolActionAvailability(inputs, watchActions)(inputs[0]);
  const canPickBrowser = isBrowser && allowed && !locked && !needsReceipt;
  const canSend =
    !locked &&
    allowed &&
    valid &&
    (isBrowser
      ? Boolean(browserSource && target && !needsReceipt)
      : Boolean(
          onTransfer &&
          source?.reference.kind === "file" &&
          source.reference.revision,
        ));
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
  function acceptBrowserSource(files: FileList | null) {
    if (!canPickBrowser || !files?.length) return;
    const candidate = files.item(0);
    const selected =
      files.length === 1 &&
      candidate &&
      candidate.size > 0 &&
      candidate.size <= BROWSER_FILE_LIMIT
        ? candidate
        : undefined;
    setSelectionError(!selected);
    setFeedback(undefined);
    setSubmitted(undefined);
    setBrowserSource(selected);
    setDraft((current) => ({
      ...current,
      offset: "0",
      length: String(selected?.size ?? 0),
    }));
  }
  const dragging = useBrowserFileDrop(
    dropZone,
    isBrowser,
    canPickBrowser,
    acceptBrowserSource,
  );
  function showOperation(operation: Operation | null, signal: AbortSignal) {
    if (signal.aborted) return;
    if (
      operation &&
      target &&
      operation.target.id === target.id &&
      operation.target.hostId === target.hostId &&
      operation.target.sessionEpoch === target.sessionEpoch
    ) {
      setSubmitted(operation);
    }
  }
  function send() {
    if (!canSend) return;
    void action.run(async (wait) => {
      setFeedback(undefined);
      if (browserFile && browserSource && target) {
        const owner = new AbortController();
        upload.current = owner;
        try {
          const operation = await browserFile.send(
            target,
            browserSource,
            draft,
            (progress) => {
              if (!wait.aborted) setBrowserProgress(progress);
            },
            AbortSignal.any([wait, owner.signal]),
          );
          showOperation(operation, wait);
          if (!operation && !wait.aborted)
            setFeedback(browserLabels.uploadCancelled);
        } finally {
          upload.current = null;
          if (!wait.aborted) {
            setBrowserProgress(undefined);
            setCancellingUpload(false);
          }
        }
      } else if (onTransfer && source) {
        showOperation(
          await onTransfer({ ...draft, sourceRef: source.reference }, wait),
          wait,
        );
      }
    });
  }
  function fields(keys: readonly (keyof TransferDraft)[], inline = false) {
    return keys.map((field) => (
      <label
        key={field}
        className={
          inline ? "grid min-w-0 content-end gap-1 text-sm" : undefined
        }
      >
        <span>{labels[field]}</span>
        <Input
          inputMode="numeric"
          value={draft[field] ?? ""}
          onChange={(event) =>
            setDraft((current) => ({ ...current, [field]: event.target.value }))
          }
        />
      </label>
    ));
  }
  const range = valid ? (
    <output
      aria-label={labels.preview}
      data-surface={isBrowser ? "transparent" : undefined}
      className={
        isBrowser
          ? "min-h-0 p-0 text-sm tabular-nums text-muted-foreground"
          : undefined
      }
    >
      [{draft.offset}, {(offset! + length!).toString()}) / {sourceLength}
    </output>
  ) : (
    sourceName && <p role="status">{labels.invalidRange}</p>
  );
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
          {isBrowser && (
            <input
              className="hidden"
              type="file"
              ref={fileInput}
              disabled={!canPickBrowser}
              onChange={(event) => {
                acceptBrowserSource(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          )}
          <div className="workbench-form-fields">
            <div
              className={
                isBrowser ? "grid min-w-0 gap-1.5" : "workbench-form-row"
              }
            >
              {isBrowser ? (
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-sm">
                  <span>{labels.source}</span>
                  <span
                    className="text-muted-foreground tabular-nums"
                    title={sourceLength}
                  >
                    {labels.fileSize}{" "}
                    {sourceLength ? formatByteSize(sourceLength) : "—"}
                  </span>
                </div>
              ) : (
                <span>{labels.source}</span>
              )}
              <div
                className={
                  dragging
                    ? "workbench-file-selection ring-1 ring-ring"
                    : "workbench-file-selection"
                }
                ref={dropZone}
              >
                {isBrowser && sourceName ? (
                  <Input
                    aria-label={labels.source}
                    title={sourceName}
                    value={sourceName}
                    readOnly
                  />
                ) : (
                  <output
                    aria-label={labels.source}
                    title={sourceName}
                    data-surface="control"
                  >
                    {sourceName ??
                      (isBrowser || pickDroppedSource
                        ? labels.dropSource
                        : labels.selectSource)}
                  </output>
                )}
                <WorkbenchIconButton
                  label={labels.selectSource}
                  variant="outline"
                  disabled={isBrowser ? !canPickBrowser : locked || !pickSource}
                  onClick={() => {
                    if (isBrowser) fileInput.current?.click();
                    else if (pickSource)
                      void action.run(async (signal) => {
                        acceptSource(await pickSource(signal), signal);
                      });
                  }}
                >
                  <FolderOpen aria-hidden="true" />
                </WorkbenchIconButton>
              </div>
            </div>
            {!isBrowser && (
              <div className="workbench-form-row">
                <span>{labels.fileSize}</span>
                <output title={sourceLength}>
                  {sourceLength ? formatByteSize(sourceLength) : "—"}
                </output>
              </div>
            )}
          </div>
          {isBrowser && (
            <>
              {selectionError && (
                <p role="alert">{browserLabels.invalidFile}</p>
              )}
              {(!allowed || disabled) && (
                <p className="text-sm text-muted-foreground">
                  {browserLabels.unavailable}
                </p>
              )}
              <fieldset disabled={locked || !allowed || needsReceipt}>
                <legend className="sr-only">{labels.transferOptions}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {fields(["offset", "length"], true)}
                </div>
              </fieldset>
              {range}
              {browserSource && valid && (
                <BrowserTransferPreview
                  file={browserSource}
                  offset={Number(offset)}
                  length={Number(length)}
                  labels={browserLabels}
                />
              )}
            </>
          )}
        </TabsContent>
        <TabsContent value="advanced" className="workbench-tool-page">
          <fieldset
            disabled={locked || (isBrowser && (!allowed || needsReceipt))}
          >
            <legend className="sr-only">{labels.transferOptions}</legend>
            <div className="workbench-form-fields">
              {fields(
                isBrowser
                  ? [
                      "bytesPerSecond",
                      "chunkBytes",
                      "interChunkMs",
                      "writeWaitMs",
                    ]
                  : [
                      "offset",
                      "length",
                      "chunkBytes",
                      "bytesPerSecond",
                      "interChunkMs",
                      "writeWaitMs",
                    ],
              )}
            </div>
          </fieldset>
          {!isBrowser && range}
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
                cancel: isBrowser ? browserLabels.stopSending : labels.cancel,
                cancelRequested: labels.cancelRequested,
              }}
              formatError={labels.operationText.failure}
              onCancel={(_id, signal) => onCancel(current, signal)}
            />
          )}
        </>
      )}
      {browserProgress?.kind === "upload" && (
        <div className="grid min-w-0 gap-1 text-sm">
          <span>{browserLabels.upload}</span>
          <Progress
            className="h-1.5 bg-muted [&>[data-slot=progress-indicator]]:bg-primary"
            aria-label={browserLabels.upload}
            aria-valuetext={`${formatByteSize(String(browserProgress.received))} / ${formatByteSize(String(browserProgress.total))}`}
            max={browserProgress.total}
            value={browserProgress.received}
          />
        </div>
      )}
      {browserProgress?.kind === "submitting" && (
        <p role="status">{browserLabels.submitting}</p>
      )}
      {feedback && <p role="status">{feedback}</p>}
      {needsReceipt && !action.busy && (
        <p role="status">{browserLabels.receiptPending}</p>
      )}
      <div className="workbench-tool-footer">
        {!isBrowser && !onTransfer && (
          <span className="sr-only">{labels.unavailable}</span>
        )}
        {browserProgress ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancellingUpload}
            onClick={() => {
              setCancellingUpload(true);
              upload.current?.abort();
            }}
          >
            {cancellingUpload
              ? labels.cancelRequested
              : browserLabels.cancelUpload}
          </Button>
        ) : needsReceipt && browserFile ? (
          <Button
            type="button"
            size="sm"
            disabled={action.busy}
            onClick={() =>
              void action.run(async (wait) => {
                setFeedback(undefined);
                const operation = await browserFile.recover(wait);
                showOperation(operation, wait);
                if (!operation && !wait.aborted)
                  setFeedback(browserLabels.noReceipt);
              })
            }
          >
            {browserLabels.checkReceipt}
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={!canSend} onClick={send}>
            {labels.sendFile}
          </Button>
        )}
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

function BrowserTransferPreview({
  file,
  offset,
  length,
  labels,
}: {
  file: File;
  offset: number;
  length: number;
  labels: TransferOptionsLabels["browserFile"];
}) {
  const [sample, setSample] = useState<{
    file: File;
    offset: number;
    length: number;
    hex: string | null;
  }>();
  useEffect(() => {
    let active = true;
    void file
      .slice(offset, offset + Math.min(length, 16))
      .arrayBuffer()
      .then(
        (bytes) => {
          if (active)
            setSample({
              file,
              offset,
              length,
              hex: formatHex(new Uint8Array(bytes)),
            });
        },
        () => {
          if (active) setSample({ file, offset, length, hex: null });
        },
      );
    return () => {
      active = false;
    };
  }, [file, offset, length]);
  if (
    sample?.file !== file ||
    sample.offset !== offset ||
    sample.length !== length
  )
    return null;
  if (sample.hex === null)
    return <p role="status">{labels.sampleUnavailable}</p>;
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      <span>{labels.sample}</span>
      <output
        aria-label={labels.sample}
        data-surface="reading"
        className="min-w-0 rounded-md border px-2 py-1.5 font-mono wrap-anywhere"
      >
        {offset}: {sample.hex}
        {length > 16 ? " …" : ""}
      </output>
    </div>
  );
}
