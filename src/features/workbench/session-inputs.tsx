import { useEffect, useRef, useState } from "react";
import type { SessionInputs, Target } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import { Button } from "@/components/ui/button";
import type { SessionControlsLabels } from "./session-controls";

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
  const [unsupported, setUnsupported] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const hostId = target?.hostId,
    sessionId = target?.sessionId,
    epoch = target?.sessionEpoch;
  useEffect(() => {
    setSample(undefined);
    setError(undefined);
    setBusy(false);
    setUnsupported(false);
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
        const value = await read!(current, controller.signal);
        if (!controller.signal.aborted) {
          if (value.sessionId !== sessionId || value.sessionEpoch !== epoch)
            throw new Error("EPOCH_MISMATCH");
          setSample(value);
          setError(undefined);
        }
      } catch (reason: unknown) {
        if (!controller.signal.aborted) {
          setSample(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
          if (
            typeof reason === "object" &&
            reason !== null &&
            "code" in reason &&
            reason.code === "UNSUPPORTED_CAPABILITY"
          ) {
            stopped = true;
            setUnsupported(true);
          }
        }
      } finally {
        inflight = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    refresh.current = () => void poll();
    void poll();
    const interval = setInterval(() => void poll(), 500);
    return () => {
      controller.abort();
      clearInterval(interval);
      refresh.current = () => {};
    };
  }, [read, connected, hostId, sessionId, epoch]);
  const current =
    connected &&
    sample?.sessionId === sessionId &&
    sample?.sessionEpoch === epoch
      ? sample
      : undefined;
  return (
    <section
      aria-label={labels.inputSignals}
      className="space-y-2"
      aria-busy={busy}
    >
      <h3>{labels.inputSignals}</h3>
      <Button
        size="sm"
        variant="outline"
        disabled={!read || !connected || !target || busy || unsupported}
        onClick={() => refresh.current()}
      >
        {labels.refreshInputs}
      </Button>
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
      {current && (
        <p>
          {labels.sampledAt}: <span>{current.sampledAt}</span> ·{" "}
          {current.sampledMonoNs} ns
        </p>
      )}
      {(unsupported || !read) && <p>{labels.inputSignalsUnavailable}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
