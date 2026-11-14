import { useEffect, useState } from "react";
import type { SessionInputs, Target } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode } from "@/lib/native-error";
import type { SessionControlsLabels } from "./session-controls";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchNotice } from "./workbench-notice";

type ReadInputs = HostContextValue["sessionInputs"];
const pendingSamples = new WeakMap<
  ReadInputs,
  Map<string, Promise<SessionInputs>>
>();
function sampleInputs(
  read: ReadInputs,
  target: Target,
): Promise<SessionInputs> {
  let samples = pendingSamples.get(read);
  if (!samples) {
    samples = new Map();
    pendingSamples.set(read, samples);
  }
  const key = JSON.stringify([
    target.hostId,
    target.sessionId,
    target.sessionEpoch,
  ]);
  const existing = samples.get(key);
  if (existing) return existing;
  // 关闭面板只解绑显示，实际查询由 Host 的有界预算管理，真实结束后释放占位。
  const pending = Promise.resolve().then(() => read(target));
  samples.set(key, pending);
  const release = () => {
    if (samples.get(key) === pending) samples.delete(key);
  };
  void pending.then(release, release);
  return pending;
}

export function SessionInputSamples({
  target,
  read,
  connected,
  labels,
}: {
  target?: Target;
  read?: HostContextValue["sessionInputs"];
  connected: boolean;
  labels: SessionControlsLabels;
}) {
  const [sample, setSample] = useState<SessionInputs>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hostId = target?.hostId,
    sessionId = target?.sessionId,
    epoch = target?.sessionEpoch;
  useEffect(() => {
    setSample(undefined);
    setError(undefined);
    setBusy(false);
    if (!read || !connected || !hostId || !sessionId || !epoch) return;
    const controller = new AbortController();
    const current: Target = {
      hostId,
      kind: "session",
      id: sessionId,
      sessionId,
      sessionEpoch: epoch,
    };
    let inflight = false,
      stopped = false;
    async function poll() {
      if (inflight || stopped || controller.signal.aborted) return;
      inflight = true;
      setBusy(true);
      try {
        const value = await sampleInputs(read!, current);
        if (!controller.signal.aborted) {
          if (value.sessionId !== sessionId || value.sessionEpoch !== epoch)
            throw { code: "EPOCH_MISMATCH" };
          setSample(value);
          setError(undefined);
        }
      } catch (reason: unknown) {
        if (!controller.signal.aborted) {
          setSample(undefined);
          const code = nativeErrorCode(reason) ?? "INTERNAL";
          setError(code);
          if (code === "UNSUPPORTED_CAPABILITY") {
            stopped = true;
          }
        }
      } finally {
        inflight = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 500);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [read, connected, hostId, sessionId, epoch]);
  const current =
    connected &&
    sample?.sessionId === sessionId &&
    sample?.sessionEpoch === epoch
      ? sample
      : undefined;
  const sampledAt = current ? new Date(current.sampledAt) : undefined;
  const unsupported = error === "UNSUPPORTED_CAPABILITY";
  const message = unsupported
    ? labels.inputSignalsUnavailable
    : labels.failure(error);
  return (
    <section
      aria-label={labels.inputSignals}
      className="space-y-2"
      aria-busy={busy}
    >
      <h3>{labels.inputSignals}</h3>
      <WorkbenchNotice
        noticeKey={`session-inputs:${error ?? "none"}`}
        log={
          error
            ? {
                module: "serial",
                level: unsupported ? "warning" : "error",
                code: error,
                message,
              }
            : undefined
        }
      >
        {error ? <span role="alert">{message}</span> : null}
      </WorkbenchNotice>
      <dl className="flex flex-wrap gap-3">
        {(["cts", "dsr", "ri", "cd"] as const).map((line) => (
          <div key={line}>
            <dt>{line.toUpperCase()}</dt>
            <dd aria-label={line.toUpperCase()}>
              {current
                ? current[line]
                  ? labels.on
                  : labels.off
                : labels.unknown}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
        <span>{labels.sampledAt}</span>
        <time dateTime={current?.sampledAt} aria-label={labels.sampledAt}>
          {sampledAt && Number.isFinite(sampledAt.getTime())
            ? sampledAt.toLocaleTimeString(undefined, { hourCycle: "h23" })
            : "—"}
        </time>
        <Popover>
          <PopoverTrigger asChild>
            <WorkbenchIconButton label={labels.details} disabled={!current}>
              <Info aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="workbench-detail-popover">
            <Textarea
              aria-label={labels.inputSignals}
              value={JSON.stringify(current, null, 2) ?? ""}
              readOnly
              className="workbench-log-details"
            />
          </PopoverContent>
        </Popover>
      </div>
      {(unsupported || !read) && <p>{labels.inputSignalsUnavailable}</p>}
    </section>
  );
}
