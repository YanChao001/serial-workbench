import { useMemo, useState } from "react";
import type {
  FileTransferParams,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import type { SelectedFileResource } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
>;
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
  const action = useToolAction();
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
      className="space-y-3"
    >
      <h3>{labels.transferOptions}</h3>
      <Button
        variant="outline"
        size="sm"
        disabled={locked || !pickSource}
        onClick={() =>
          void action.run(async (signal) => {
            const selected = await pickSource!(signal);
            if (selected && !signal.aborted) {
              setSource(selected);
              setDraft((current) => ({
                ...current,
                offset: "0",
                length: selected.length,
              }));
            }
          })
        }
      >
        {labels.selectSource}
      </Button>
      {source && (
        <p aria-label={labels.source}>
          <span>{source.name}</span> · {source.length} · {source.reference.id} @{" "}
          {source.reference.revision}
        </p>
      )}
      <fieldset disabled={locked}>
        <legend>{labels.transferOptions}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
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
            <label key={field} className="space-y-1">
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
          [{draft.offset}, {(offset! + length!).toString()}) / {source?.length}
        </output>
      ) : (
        source && <p role="status">{labels.invalidRange}</p>
      )}
      <p className="text-xs text-muted-foreground">{labels.transferEvidence}</p>
      {!onTransfer && <p>{labels.unavailable}</p>}
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
            await onTransfer({ ...draft, sourceRef: source.reference }, signal);
          })
        }
      >
        {labels.sendFile}
      </Button>
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
