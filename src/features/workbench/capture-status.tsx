import type {
  CaptureStatusResult,
  ObjectRef,
} from "@serial-workbench/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Info, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode } from "@/lib/native-error";
import type { WorkbenchLabels } from "./labels";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { useToolActionAvailability } from "./use-tool-action-availability";

function captureKey(reference: ObjectRef): string {
  return JSON.stringify([
    reference.hostId,
    reference.kind,
    reference.id,
    reference.revision,
  ]);
}
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
/** 等待本次停止操作的真实终态；录制最终状态仍以独立状态快照为准。 */
export type CaptureStopper = (
  reference: ObjectRef,
  signal?: AbortSignal,
) => Promise<void>;
type Failure = {
  code?: string;
  eventKey?: string;
};
function captureFailure(reason: unknown): Failure {
  return {
    code: nativeErrorCode(reason),
    eventKey: operationFailureEventKey(reason),
  };
}
function CaptureFailureNotice({
  failure,
  labels,
  context,
}: {
  failure: Failure | undefined;
  labels: WorkbenchLabels;
  context: string;
}) {
  const message = failure
    ? labels.operationText.failure(failure.code)
    : undefined;
  return (
    <WorkbenchNotice
      noticeKey={`${context}:${failure?.code ?? "unknown"}`}
      eventKey={failure?.eventKey}
      log={{
        module: "capture",
        level: "error",
        code: failure?.code,
        message: message ?? "",
      }}
    >
      {message ? <span role="alert">{message}</span> : null}
    </WorkbenchNotice>
  );
}
type LiveCaptureStatusProps = {
  reference: ObjectRef;
  read: CaptureStatusReader;
  onStop?: CaptureStopper;
  disabled: boolean;
  labels: WorkbenchLabels;
  watchActions: HostContextValue["watchActions"];
};
export function LiveCaptureStatus(props: LiveCaptureStatusProps) {
  return <LiveCaptureStatusView key={captureKey(props.reference)} {...props} />;
}
function LiveCaptureStatusView({
  reference,
  read,
  ...props
}: LiveCaptureStatusProps) {
  const [value, setValue] = useState<CaptureStatusResult>();
  const [failure, setFailure] = useState<Failure>();
  const [attempt, setAttempt] = useState(0);
  const failedAttempt = useRef<
    | {
        read: CaptureStatusReader;
        attempt: number;
      }
    | undefined
  >(undefined);
  const { hostId, kind, id, revision } = reference;
  const stableReference = useMemo(
    () => ({
      hostId,
      kind,
      id,
      ...(revision === undefined ? {} : { revision }),
    }),
    [hostId, kind, id, revision],
  );
  const inputs = useMemo(
    () => [captureInput("capture.status", stableReference)],
    [stableReference],
  );
  const allowed = useToolActionAvailability(inputs, props.watchActions);
  const canRead = !props.disabled && allowed(inputs[0]);
  useEffect(() => {
    if (
      !canRead ||
      value ||
      (failedAttempt.current?.read === read &&
        failedAttempt.current.attempt === attempt)
    )
      return;
    const controller = new AbortController();
    setFailure(undefined);
    void read(stableReference, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          failedAttempt.current = { read, attempt };
          setFailure(captureFailure(reason));
        }
      });
    return () => controller.abort();
  }, [stableReference, read, attempt, canRead, value]);
  return value ? (
    <CaptureStatusView
      key={captureKey(value.captureRef)}
      {...props}
      value={value}
      read={read}
      fresh
    />
  ) : (
    <div aria-busy={canRead && !failure} className="workbench-toolbar">
      <WorkbenchIconButton
        label={props.labels.retry}
        className={failure ? undefined : "invisible"}
        disabled={!failure || !canRead}
        onClick={() => setAttempt((current) => current + 1)}
      >
        <RotateCw aria-hidden="true" />
      </WorkbenchIconButton>
      <CaptureFailureNotice
        failure={failure}
        labels={props.labels}
        context={`read:${captureKey(stableReference)}`}
      />
    </div>
  );
}
type CaptureStatusProps = {
  value: CaptureStatusResult;
  read?: CaptureStatusReader;
  onStop?: CaptureStopper;
  disabled: boolean;
  labels: WorkbenchLabels;
  watchActions: HostContextValue["watchActions"];
};
export function CaptureStatus(props: CaptureStatusProps) {
  return (
    <CaptureStatusView key={captureKey(props.value.captureRef)} {...props} />
  );
}
function CaptureStatusView({
  value,
  read,
  onStop,
  disabled,
  labels,
  watchActions,
  fresh = false,
}: CaptureStatusProps & { fresh?: boolean }) {
  const [snapshot, setSnapshot] = useState({ value, status: value });
  const status = snapshot.value === value ? snapshot.status : value;
  const [readFailure, setReadFailure] = useState<Failure>();
  const [stopFailure, setStopFailure] = useState<Failure>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const observed = useRef(fresh);
  const { hostId, kind, id, revision } = status.captureRef;
  const reference = useMemo(
    () => ({
      hostId,
      kind,
      id,
      ...(revision === undefined ? {} : { revision }),
    }),
    [hostId, kind, id, revision],
  );
  const inputs = useMemo(
    () => [
      captureInput("capture.status", reference),
      captureInput("capture.stop", reference),
    ],
    [reference],
  );
  const allowed = useToolActionAvailability(inputs, watchActions);
  const canRead = !disabled && !!read && allowed(inputs[0]);
  const summary = status.summary;
  const active =
    summary.state === "recording" || summary.state === "finalizing";
  useEffect(() => {
    if (!canRead || !read || (!active && observed.current) || readFailure)
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let failed = false;
    let finished = false;
    async function poll() {
      if (
        controller.signal.aborted ||
        reading ||
        document.hidden ||
        failed ||
        finished
      )
        return;
      reading = true;
      try {
        const next = await read!(reference, controller.signal);
        if (!controller.signal.aborted) {
          observed.current = true;
          finished =
            next.summary.state !== "recording" &&
            next.summary.state !== "finalizing";
          setSnapshot({ value, status: next });
        }
      } catch (reason: unknown) {
        if (!controller.signal.aborted) {
          failed = true;
          setReadFailure(captureFailure(reason));
        }
      } finally {
        reading = false;
        if (
          !controller.signal.aborted &&
          !document.hidden &&
          !failed &&
          !finished
        )
          timer = setTimeout(() => void poll(), 1000);
      }
    }
    function visible() {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    }
    document.addEventListener("visibilitychange", visible);
    // 已有真实状态时先保留该快照，之后仅在可见期间顺序采样。
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [canRead, read, active, reference, value, attempt, readFailure]);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function stop() {
    if (
      pending.current ||
      disabled ||
      !onStop ||
      stopRequested ||
      summary.state !== "recording" ||
      !allowed(inputs[1])
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setStopFailure(undefined);
    try {
      await onStop(reference, controller.signal);
      if (!controller.signal.aborted) setStopRequested(true);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setStopFailure(captureFailure(reason));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label={labels.capture} className="space-y-2">
      <div className="workbench-operation-heading">
        <span role="status">{labels.captureStates[summary.state]}</span>
        <span className={stopRequested && active ? undefined : "invisible"}>
          {labels.stopRequested}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <WorkbenchIconButton label={labels.captureStatusDetails}>
              <Info aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="workbench-detail-popover">
            <Textarea
              aria-label={labels.captureStatusDetails}
              value={JSON.stringify(status, null, 2)}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              className="workbench-log-details"
            />
          </PopoverContent>
        </Popover>
      </div>
      <dl className="workbench-capture-values">
        {(["written", "flushed", "synced", "verified"] as const).map((key) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd aria-label={labels[key]} title={summary.watermarks[key]}>
              {new Intl.NumberFormat().format(BigInt(summary.watermarks[key]))}{" "}
              {labels.operationText.records}
            </dd>
          </div>
        ))}
        <div>
          <dt>{labels.containerComplete}</dt>
          <dd>
            {summary.containerComplete ? labels.captureYes : labels.captureNo}
          </dd>
        </div>
        <div>
          <dt>{labels.sourceContinuous}</dt>
          <dd>
            {summary.sourceContinuous ? labels.captureYes : labels.captureNo}
          </dd>
        </div>
      </dl>
      <div className="workbench-toolbar">
        <Button
          size="sm"
          variant="outline"
          aria-busy={busy}
          disabled={
            disabled ||
            busy ||
            stopRequested ||
            !onStop ||
            summary.state !== "recording" ||
            !allowed(inputs[1])
          }
          onClick={() => void stop()}
        >
          {labels.stopCapture}
        </Button>
        <WorkbenchIconButton
          label={labels.retry}
          className={readFailure ? undefined : "invisible"}
          disabled={!readFailure || !canRead}
          onClick={() => {
            setReadFailure(undefined);
            setAttempt((current) => current + 1);
          }}
        >
          <RotateCw aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
      <CaptureFailureNotice
        failure={readFailure}
        labels={labels}
        context={`read:${captureKey(reference)}`}
      />
      <CaptureFailureNotice
        failure={stopFailure}
        labels={labels}
        context={`stop:${captureKey(reference)}`}
      />
    </section>
  );
}
