import { useMemo, useState } from "react";
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
import { WorkbenchNotice } from "./workbench-notice";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { operationProgress, type OperationText } from "./operation-text";
import {
  unsigned,
  useToolAction,
  useToolDraft,
} from "./transfer-capture-actions";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

import { useToolActionAvailability } from "./use-tool-action-availability";

export type TransferOptionsLabels = Record<
  | "transferOptions"
  | "selectSource"
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
  | "saveUnavailable",
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
  initialDraft?: TransferDraft;
  pickSource?: (signal?: AbortSignal) => Promise<SelectedFileResource | null>;
  onTransfer?: (
    params: FileTransferParams,
    signal?: AbortSignal,
  ) => Promise<Operation>;
  onSaveDraft?: (draft: TransferDraft, signal?: AbortSignal) => Promise<void>;
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
  onTransfer,
  onSaveDraft,
  target,
  watchActions,
  operations,
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
  const current =
    operations?.find((value) => value.operationId === submitted?.operationId) ??
    submitted;
  useToolDraft(
    draft,
    labels.draft,
    labels.saveUnavailable,
    setDraft,
    onSaveDraft,
  );
  const offset = unsigned(draft.offset),
    length = unsigned(draft.length);
  const chunk = unsigned(draft.chunkBytes ?? ""),
    rate = unsigned(draft.bytesPerSecond);
  const interval = unsigned(draft.interChunkMs),
    wait = unsigned(draft.writeWaitMs);
  const total = source ? unsigned(source.length) : undefined;
  const valid =
    offset !== undefined &&
    length !== undefined &&
    total !== undefined &&
    offset + length <= total &&
    offset + length <= 18446744073709551615n &&
    chunk !== undefined &&
    chunk > 0n &&
    rate !== undefined &&
    rate > 0n &&
    interval !== undefined &&
    wait !== undefined &&
    wait > 0n;
  const locked = Boolean(disabled || action.busy);
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
              <div className="workbench-file-selection">
                <output aria-label={labels.source} title={source?.name}>
                  {source?.name ?? "—"}
                </output>
                <WorkbenchIconButton
                  label={labels.selectSource}
                  variant="outline"
                  disabled={locked || !pickSource}
                  onClick={() =>
                    void action.run(async (signal) => {
                      const selected = await pickSource!(signal);
                      if (selected && !signal.aborted) {
                        setSource(selected);
                        setSubmitted(undefined);
                        setDraft((current) => ({
                          ...current,
                          offset: "0",
                          length: selected.length,
                        }));
                      }
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
      <div className="workbench-tool-footer">
        {current && (
          <output role="status">
            {labels.operationText.states[current.state]}
            {current.progress
              ? ` · ${operationProgress(current.progress, labels.operationText)}`
              : ""}
          </output>
        )}
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
