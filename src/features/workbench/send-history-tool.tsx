import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DeviceDescriptor,
  OperationSummary,
  SessionSnapshot,
} from "@serial-workbench/contracts";
import { createSendHistoryPinStore } from "@/lib/client-send-history";
import { settingsErrorCode } from "@/lib/settings-sync";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { useToolActionAvailability } from "./use-tool-action-availability";
import { SendHistoryPanel } from "./send-history-panel";
import { historyRows, maxHistoryBatch } from "./send-history-model";

const emptyPins: ReadonlySet<string> = new Set();

export function SendHistoryTool({
  summaries,
  sessions,
  devices,
  workspaceId,
  readSummary,
  ...panel
}: Omit<
  ComponentProps<typeof SendHistoryPanel>,
  | "rows"
  | "pinned"
  | "onPin"
  | "pinError"
  | "pinRetry"
  | "pinSaving"
  | "onRestorePin"
  | "readingPin"
> & {
  summaries: readonly OperationSummary[];
  sessions: readonly SessionSnapshot[];
  devices: readonly DeviceDescriptor[];
  workspaceId?: string;
  readSummary?: HostContextValue["readOperationSummary"];
}) {
  const { hostId } = panel;
  const [store] = useState(createSendHistoryPinStore);
  const [pinned, setPinned] = useState<ReadonlySet<string>>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [restored, setRestored] = useState<OperationSummary[]>([]);
  const [readingPin, setReadingPin] = useState<string>();
  const pendingRead = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const pendingSave = useRef(false);

  useEffect(() => {
    setPinned(undefined);
    setSaving(false);
    setError(undefined);
    setRestored([]);
    setReadingPin(undefined);
    if (!workspaceId) return;
    const controller = new AbortController();
    lifetime.current = controller;
    void store.read({ hostId, workspaceId }, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setPinned(value);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(settingsErrorCode(reason));
      },
    );
    return () => {
      lifetime.current = null;
      pendingSave.current = false;
      pendingRead.current = false;
      controller.abort();
    };
  }, [store, workspaceId, hostId, attempt]);

  async function togglePin(id: string) {
    const signal = lifetime.current?.signal;
    if (!signal || !workspaceId || !pinned || pendingSave.current) return;
    pendingSave.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const next = await store.set(
        { hostId, workspaceId },
        id,
        !pinned.has(id),
        signal,
      );
      if (!signal.aborted) setPinned(next);
    } catch (reason) {
      if (!signal.aborted) setError(settingsErrorCode(reason));
    } finally {
      if (!signal.aborted) {
        pendingSave.current = false;
        setSaving(false);
      }
    }
  }

  async function restore(id: string) {
    const signal = lifetime.current?.signal;
    if (!signal || !readSummary || !pinned?.has(id) || pendingRead.current)
      return;
    pendingRead.current = true;
    setReadingPin(id);
    setError(undefined);
    try {
      const summary = await readSummary(id, signal);
      if (summary.actionId !== "session.tx" || summary.target.hostId !== hostId)
        throw { code: "NOT_FOUND" };
      if (!signal.aborted)
        setRestored((current) =>
          [...current.filter((item) => item.operationId !== id), summary].slice(
            -maxHistoryBatch,
          ),
        );
    } catch (reason) {
      if (!signal.aborted) setError(settingsErrorCode(reason));
    } finally {
      if (!signal.aborted) {
        pendingRead.current = false;
        setReadingPin(undefined);
      }
    }
  }

  const restoredInputs = useMemo<HostActionCheckInput[]>(
    () =>
      restored
        .filter((entry) => pinned?.has(entry.operationId))
        .map(({ operationId }) => ({
          actionId: "operation.get",
          target: { hostId, kind: "host", id: hostId },
          params: { operationId },
        })),
    [restored, hostId, pinned],
  );
  const allowed = useToolActionAvailability(restoredInputs, panel.watchActions);
  const observed = new Set(summaries.map(({ operationId }) => operationId));
  const readable = new Set(
    restoredInputs.filter(allowed).map(({ params }) => params.operationId),
  );
  const rows = historyRows(
    [
      ...summaries,
      ...restored.filter(
        ({ operationId }) =>
          !observed.has(operationId) && readable.has(operationId),
      ),
    ],
    sessions,
    devices,
    hostId,
    pinned ?? emptyPins,
  );
  return (
    <SendHistoryPanel
      {...panel}
      rows={rows}
      onRestorePin={readSummary ? (id) => void restore(id) : undefined}
      readingPin={readingPin}
      pinned={pinned ?? emptyPins}
      onPin={pinned ? (id) => void togglePin(id) : undefined}
      pinError={error}
      pinSaving={saving}
      pinRetry={
        error && !pinned ? () => setAttempt((value) => value + 1) : undefined
      }
    />
  );
}
