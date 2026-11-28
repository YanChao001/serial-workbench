import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  FileTransferParams,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ManualSendRecording } from "./manual-send-recording";

type Capture = { recording: ManualSendRecording; observer: AbortController };
type Snapshot = ReturnType<ManualSendRecording["snapshot"]>;
type TransferOptions = Omit<FileTransferParams, "sourceRef">;
export type ObserveFileTransfer = <Result extends Operation | null>(
  params: TransferOptions,
  send: (guardRevision: boolean) => Promise<Result>,
) => Promise<Result>;

export function useManualSendRecording(
  scope: string | undefined,
  target: Target | undefined,
  wait: HostContextValue["waitForOperation"],
  readFileReceipts: HostContextValue["readFileReceipts"] | undefined,
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

  function start(referenceBytes = false) {
    if (active.current || !scope || !target) return;
    const capture = {
      recording: new ManualSendRecording(scope, target, referenceBytes),
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

  async function observeAction<Result extends Operation | null>(
    add: (recording: ManualSendRecording) => number | undefined,
    complete: (
      recording: ManualSendRecording,
      index: number,
      admitted: Operation | undefined,
      settled: Operation | undefined,
      signal: AbortSignal,
    ) => void | Promise<void>,
    send: (guardRevision: boolean) => Promise<Result>,
  ) {
    const capture = active.current;
    if (!capture || capture.recording.scope !== scope) return send(false);
    const index = add(capture.recording);
    if (index === undefined) {
      if (snapshot?.phase === "recording") publish(capture);
      return send(false);
    }
    publish(capture);

    const { signal } = capture.observer;
    const settle = async (admitted?: Operation, settled?: Operation) => {
      if (active.current !== capture || signal.aborted) return;
      await complete(capture.recording, index, admitted, settled, signal);
      publish(capture);
    };

    let admitted: Result;
    try {
      admitted = await send(true);
    } catch (error) {
      await settle();
      throw error;
    }
    if (!admitted) {
      await settle();
    } else if (!signal.aborted) {
      void wait(admitted, signal).then(
        (settled) => settle(admitted, settled),
        () => settle(admitted),
      );
    }
    return admitted;
  }

  function observe(
    bytes: Uint8Array,
    writeWaitMs: string,
    send: (guardRevision: boolean) => Promise<Operation>,
  ) {
    return observeAction(
      (recording) =>
        recording.add(bytes, performance.now(), Number(writeWaitMs)),
      (recording, index, admitted, settled) => {
        recording.settle(index, admitted, settled, performance.now());
      },
      send,
    );
  }

  const observeFile: ObserveFileTransfer = (params, send) => {
    if (!readFileReceipts) return send(false);
    return observeAction(
      (recording) => recording.addFile(params, performance.now()),
      (recording, index, admitted, settled, signal) =>
        recording.settleFile(
          index,
          admitted,
          settled,
          readFileReceipts,
          signal,
          performance.now(),
        ),
      send,
    );
  };

  return { snapshot, start, stop, discard, observe, observeFile };
}
