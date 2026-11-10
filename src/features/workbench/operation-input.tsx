import type { OperationInput } from "@serial-workbench/contracts";
import { useEffect, useRef, useState } from "react";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { nativeErrorCode } from "@/lib/native-error";
import { decodeBytes } from "./stream-model";
import type { WorkbenchLabels } from "./labels";
import { operationLogModule } from "./operation-failure-notices";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
export type OperationInputReader = (
  operationId: string,
  signal?: AbortSignal,
) => Promise<OperationInput>;
export function OperationInputView({
  operationId,
  actionId,
  read,
  labels,
}: {
  operationId: string;
  actionId?: string;
  read: OperationInputReader;
  labels: WorkbenchLabels;
}) {
  const [snapshot, setSnapshot] = useState<{
    operationId: string;
    read: OperationInputReader;
    value: OperationInput;
  }>();
  const value =
    snapshot?.operationId === operationId && snapshot.read === read
      ? snapshot.value
      : undefined;
  const [failed, setFailed] = useState<{
    operationId: string;
    read: OperationInputReader;
    code?: string;
    eventKey?: string;
  }>();
  const failure =
    failed?.operationId === operationId && failed.read === read
      ? failed
      : undefined;
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setSnapshot(undefined);
    setFailed(undefined);
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
    setSnapshot(undefined);
    setFailed(undefined);
    try {
      const input = await read(operationId, controller.signal);
      if (!controller.signal.aborted)
        setSnapshot({ operationId, read, value: input });
    } catch (reason) {
      if (!controller.signal.aborted)
        setFailed({
          operationId,
          read,
          code: nativeErrorCode(reason),
          eventKey: operationFailureEventKey(reason),
        });
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const bytes =
    value?.kind === "tx" ? decodeBytes(value.value.bytesBase64) : undefined;
  const message = failure
    ? labels.operationText.failure(failure.code)
    : undefined;
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
      <WorkbenchNotice
        noticeKey={JSON.stringify([
          "operation-input",
          operationId,
          failure?.code,
        ])}
        eventKey={failure?.eventKey}
        log={
          message
            ? {
                module: operationLogModule(actionId ?? ""),
                level: "error",
                code: failure?.code,
                context: labels.operationInput,
                message,
              }
            : undefined
        }
      >
        {message ? <span role="alert">{message}</span> : null}
      </WorkbenchNotice>
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
