import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { nativeErrorCode } from "@/lib/native-error";
import type { SessionSnapshot } from "@serial-workbench/contracts";
import type {
  ComparisonSide,
  ReplayComparisonSample,
} from "./session-comparison-model";

type ReplayOwner = Pick<SessionSnapshot, "sessionId" | "sessionEpoch">;

type Slot = {
  owner: ReplayOwner;
  sample: ReplayComparisonSample;
  check: HostActionCheckInput;
};

type Selection = Partial<Record<ComparisonSide, Slot>>;
const sides = ["baseline", "candidate"] as const;

export function useReplayComparison({
  scope,
  hostId,
  sessions,
  ready,
  watchActions,
}: {
  scope: string;
  hostId: string | undefined;
  sessions: readonly SessionSnapshot[];
  ready: boolean;
  watchActions: HostContextValue["watchActions"];
}) {
  const [stored, setStored] = useState<{ scope: string; slots: Selection }>();
  const [dialog, setDialog] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);

  const slots = ready && stored?.scope === scope ? stored.slots : undefined;
  useEffect(() => {
    setDialog((current) => (ready && current === scope ? current : undefined));
  }, [ready, scope]);
  function isOpen(slot: Slot | undefined) {
    return Boolean(
      slot &&
      sessions.some(
        (session) =>
          session.sessionId === slot.owner.sessionId &&
          session.sessionEpoch === slot.owner.sessionEpoch &&
          session.readOnly &&
          session.state === "open",
      ),
    );
  }
  const baseline = isOpen(slots?.baseline) ? slots?.baseline : undefined;
  const candidate = isOpen(slots?.candidate) ? slots?.candidate : undefined;
  const count = Number(Boolean(baseline)) + Number(Boolean(candidate));
  const inputs = useMemo(
    () =>
      [baseline?.check, candidate?.check].filter(
        (value) => value !== undefined,
      ),
    [baseline, candidate],
  );
  const [observation, setObservation] = useState<{
    inputs: typeof inputs;
    watch: typeof watchActions;
    values: readonly HostActionAvailability[];
  }>();
  useEffect(() => {
    setStored((current) => {
      if (!current) return current;
      if (!ready || current.scope !== scope) return undefined;
      const { baseline: oldBaseline, candidate: oldCandidate } = current.slots;
      if (oldBaseline === baseline && oldCandidate === candidate)
        return current;
      return {
        scope,
        slots: {
          baseline: oldBaseline === slots?.baseline ? baseline : oldBaseline,
          candidate:
            oldCandidate === slots?.candidate ? candidate : oldCandidate,
        },
      };
    });
  }, [ready, scope, slots, baseline, candidate]);
  useEffect(() => {
    if (!inputs.length) return;
    let active = true;
    const stop = watchActions(inputs, (values) => {
      if (!active) return;
      setObservation({ inputs, watch: watchActions, values });
      const denied = new Set(
        values
          .filter(
            ({ result, error }) =>
              result?.allowed === false ||
              nativeErrorCode(error) === "PERMISSION_DENIED" ||
              nativeErrorCode(error) === "NOT_FOUND",
          )
          .map(({ input }) => JSON.stringify(input)),
      );
      if (!denied.size) return;
      setStored((current) => {
        if (!current || current.scope !== scope) return current;
        const kept = { ...current.slots };
        for (const side of sides) {
          const slot = kept[side];
          if (slot && denied.has(JSON.stringify(slot.check))) delete kept[side];
        }
        return { scope, slots: kept };
      });
    });
    return () => {
      active = false;
      stop();
    };
  }, [inputs, watchActions, scope]);

  function authorized(slot: Slot | undefined) {
    if (
      slot &&
      observation?.inputs === inputs &&
      observation.watch === watchActions &&
      observation.values.some(
        ({ input, result, error }) =>
          error === null &&
          result?.allowed === true &&
          JSON.stringify(input) === JSON.stringify(slot.check),
      )
    )
      return slot.sample;
  }

  const authorizedBaseline = authorized(baseline);
  const authorizedCandidate = authorized(candidate);
  return {
    count,
    baseline: authorizedBaseline,
    candidate: authorizedCandidate,
    checking: Boolean(
      (baseline && !authorizedBaseline) || (candidate && !authorizedCandidate),
    ),
    open: ready && dialog === scope,
    trigger,
    show(element: HTMLElement) {
      if (!count) return;
      trigger.current = element;
      setDialog(scope);
    },
    close() {
      setDialog(undefined);
    },
    clear() {
      setStored(undefined);
      setDialog(undefined);
    },
    stage(
      owner: ReplayOwner,
      side: ComparisonSide,
      sample: ReplayComparisonSample,
    ) {
      if (!ready || !hostId || !sample.frames.length) return;
      const { sessionId, sessionEpoch } = owner;
      const check: HostActionCheckInput = {
        actionId: "replay.read",
        target: {
          kind: "session",
          hostId,
          id: sessionId,
          sessionId,
          sessionEpoch,
        },
        params: {
          sessionId,
          sessionEpoch,
          maxRecords: "1",
          maxBytes: "65536",
        },
      };
      setStored((current) => ({
        scope,
        slots: {
          ...(current?.scope === scope ? current.slots : undefined),
          [side]: { owner, sample, check },
        },
      }));
    },
  };
}
