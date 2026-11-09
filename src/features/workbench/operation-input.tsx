import type { OperationInput } from "@serial-workbench/contracts";
import { useEffect, useRef, useState } from "react";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { decodeBytes } from "./stream-model";
import type { WorkbenchLabels } from "./labels";
export type OperationInputReader = (
  operationId: string,
  signal?: AbortSignal,
) => Promise<OperationInput>;
export function OperationInputView({
  operationId,
  read,
  labels,
}: {
  operationId: string;
  read: OperationInputReader;
  labels: WorkbenchLabels;
}) {
  const [value, setValue] = useState<OperationInput>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setValue(undefined);
    setError(undefined);
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [read, operationId]);
  async function load() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setValue(undefined);
    setError(undefined);
    try {
      const input = await read(operationId, controller.signal);
      if (!controller.signal.aborted) setValue(input);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const bytes =
    value?.kind === "tx" ? decodeBytes(value.value.bytesBase64) : undefined;
  return (
    <div aria-busy={busy}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${labels.operationInput} ${operationId}`}
        disabled={busy}
        onClick={() => void load()}
      >
        {labels.operationInput}
      </Button>
      {error && <p role="alert">{error}</p>}
      {value?.kind === "redacted" ? (
        <p>
          {labels.redactedInput}: {value.value.reason}
        </p>
      ) : bytes ? (
        <>
          <pre aria-label={labels.text} className="workbench-input-body">
            {new TextDecoder().decode(bytes)}
          </pre>
          <pre aria-label={labels.hex} className="workbench-input-body">
            {formatHex(bytes)}
          </pre>
        </>
      ) : value ? (
        <pre className="workbench-input-body">
          {JSON.stringify(value.value, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
