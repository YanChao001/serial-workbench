import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Operation, Target } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ManualSendRecording } from "./manual-send-recording";

type Capture = { recording: ManualSendRecording; observer: AbortController };
type Snapshot = ReturnType<ManualSendRecording["snapshot"]>;

export function useManualSendRecording(
  scope: string | undefined,
  target: Target | undefined,
  wait: HostContextValue["waitForOperation"],
  label: string,
) {
  const id = useId();
  const active = useRef<Capture | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>();

  function publish(capture: Capture) {
    if (active.current !== capture) return;
    const next = capture.recording.snapshot();
    if (next.phase === "ready") capture.observer.abort();
    setSnapshot(next);
  }

  useLayoutEffect(() => {
    const capture = active.current;
    if (capture && scope !== capture.recording.scope) {
      capture.recording.stop("scope");
      publish(capture);
    }
  }, [scope]);

  useEffect(
    () => () => {
      active.current?.observer.abort();
      active.current = undefined;
    },
    [],
  );

  function start() {
    if (active.current || !scope || !target) return;
    const capture = {
      recording: new ManualSendRecording(scope, target),
      observer: new AbortController(),
    };
    active.current = capture;
    publish(capture);
  }

  function stop() {
    const capture = active.current;
    if (!capture) return;
    capture.recording.stop("user");
    publish(capture);
  }

  function discard() {
    const capture = active.current;
    active.current = undefined;
    capture?.observer.abort();
    setSnapshot(undefined);
  }

  useUnsavedWork({
    id,
    label,
    dirty: snapshot?.dirty ?? false,
    retainAfterUnmount: false,
    discard,
  });

  async function observe(bytes: Uint8Array, send: () => Promise<Operation>) {
    const capture = active.current;
    if (!capture || capture.recording.scope !== scope) return send();
    const index = capture.recording.add(bytes, performance.now());
    if (index === undefined) {
      if (snapshot?.phase === "recording") publish(capture);
      return send();
    }
    publish(capture);

    const settle = (admitted?: Operation, settled?: Operation) => {
      if (active.current !== capture) return;
      capture.recording.settle(index, admitted, settled, performance.now());
      publish(capture);
    };

    let admitted: Operation;
    try {
      admitted = await send();
    } catch (error) {
      settle();
      throw error;
    }
    const { signal } = capture.observer;
    if (!signal.aborted) {
      void wait(admitted, signal).then(
        (settled) => settle(admitted, settled),
        () => settle(admitted),
      );
    }
    return admitted;
  }

  return { snapshot, start, stop, discard, observe };
}
