import type {
  CaptureStatusResult,
  ObjectRef,
} from "@serial-workbench/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

import { useToolActionAvailability } from "./use-tool-action-availability";

function captureInput(
  actionId: string,
  reference: ObjectRef,
): HostActionCheckInput {
  return {
    actionId,
    target: {
      hostId: reference.hostId,
      kind: reference.kind,
      id: reference.id,
    },
    params: { captureRef: reference },
  };
}
export type CaptureStatusReader = (
  reference: ObjectRef,
  signal?: AbortSignal,
) => Promise<CaptureStatusResult>;
export type CaptureStopper = (
  reference: ObjectRef,
  signal?: AbortSignal,
) => Promise<unknown>;
export function LiveCaptureStatus({
  reference,
  read,
  ...props
}: {
  reference: ObjectRef;
  read: CaptureStatusReader;
  onStop?: CaptureStopper;
  disabled: boolean;
  labels: WorkbenchLabels;
  watchActions: HostContextValue["watchActions"];
}) {
  const [snapshot, setSnapshot] = useState<{
    reference: ObjectRef;
    value: CaptureStatusResult;
  }>();
  const value = snapshot?.reference === reference ? snapshot.value : undefined;
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const inputs = useMemo(
    () => [captureInput("capture.status", reference)],
    [reference],
  );
  const allowed = useToolActionAvailability(inputs, props.watchActions);
  const canRead = !props.disabled && allowed(inputs[0]);
  useEffect(() => {
    if (!canRead || value) return;
    const controller = new AbortController();
    setError(undefined);
    void read(reference, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot({ reference, value });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [reference, read, attempt, canRead, value]);
  return value ? (
    <CaptureStatus {...props} value={value} read={read} />
  ) : (
    <div aria-busy={!error}>
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAttempt((attempt) => attempt + 1)}
            disabled={!canRead}
          >
            {props.labels.refresh}
          </Button>
        </>
      )}
    </div>
  );
}
export function CaptureStatus({
  value,
  read,
  onStop,
  disabled,
  labels,
  watchActions,
}: {
  value: CaptureStatusResult;
  read?: CaptureStatusReader;
  onStop?: CaptureStopper;
  disabled: boolean;
  labels: WorkbenchLabels;
  watchActions: HostContextValue["watchActions"];
}) {
  const [snapshot, setSnapshot] = useState({ value, status: value });
  const status = snapshot.value === value ? snapshot.status : value;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const inputs = useMemo(
    () => [
      captureInput("capture.status", status.captureRef),
      captureInput("capture.stop", status.captureRef),
    ],
    [status.captureRef],
  );
  const allowed = useToolActionAvailability(inputs, watchActions);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function act(action: (signal: AbortSignal) => Promise<unknown>) {
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
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const summary = status.summary;
  return (
    <div aria-label={`${labels.capture} ${summary.captureId}`}>
      <p>
        {summary.captureId} · {summary.state}
      </p>
      <dl className="workbench-transfer-result">
        {(["written", "flushed", "synced", "verified"] as const).map((key) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd>{summary.watermarks[key]}</dd>
          </div>
        ))}
      </dl>
      <label>
        <input type="checkbox" disabled checked={summary.containerComplete} />
        {labels.containerComplete}
      </label>
      <label>
        <input type="checkbox" disabled checked={summary.sourceContinuous} />
        {labels.sourceContinuous}
      </label>
      <div className="workbench-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !read || busy || !allowed(inputs[0])}
          onClick={() =>
            void act(async (signal) => {
              if (disabled || !read || !allowed(inputs[0])) return;
              const next = await read!(status.captureRef, signal);
              if (!signal.aborted) setSnapshot({ value, status: next });
            })
          }
        >
          {labels.refresh}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            busy ||
            !onStop ||
            summary.state !== "recording" ||
            !allowed(inputs[1])
          }
          onClick={() =>
            void act(async (signal) => {
              if (
                disabled ||
                !onStop ||
                summary.state !== "recording" ||
                !allowed(inputs[1])
              )
                return;
              await onStop(status.captureRef, signal);
            })
          }
        >
          {labels.stopCapture}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
