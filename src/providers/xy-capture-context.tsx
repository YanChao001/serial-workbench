import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LanWorkbenchContext } from "@/features/lan/lan-workbench-context";
import type { HostConnection } from "@/lib/host-client";
import {
  alignXyAction,
  type CapturedXyAxes,
  type CapturedXyChannel,
  type CapturedXyPair,
} from "@/lib/xy-capture";
import {
  HostContext,
  useHost,
  type HostActionCheckInput,
  type HostState,
} from "@/providers/host-context";

type Axis = "x" | "y";
type Session = { sessionId: string; sessionEpoch: string };
type CaptureSource = Session & {
  kind: "live" | "replay";
  generation: string;
  connection: HostConnection;
};
type Slot = {
  source: CaptureSource;
  channel: CapturedXyChannel;
  check: HostActionCheckInput;
};
type Slots = Partial<Record<Axis, Slot>>;
type CaptureActions = {
  connection: HostConnection | undefined;
  available: boolean;
  axes: CapturedXyAxes;
  source(
    session: Session,
    kind: CaptureSource["kind"],
  ): CaptureSource | undefined;
  stage(axis: Axis, channel: CapturedXyChannel, source: CaptureSource): void;
  verify(pair: CapturedXyPair, signal: AbortSignal): Promise<boolean>;
  clear(): void;
};
const Context = createContext<CaptureActions | null>(null);

function sourceGeneration(
  state: HostState,
  { sessionId, sessionEpoch, kind }: Session & Pick<CaptureSource, "kind">,
) {
  const session = state.sessions.find(
    (session) =>
      session.sessionId === sessionId &&
      session.sessionEpoch === sessionEpoch &&
      session.state === "open",
  );
  if (!session) return;
  if (kind === "replay") return session.readOnly ? sessionEpoch : undefined;
  const stream = state.streams.get(sessionId);
  return stream?.error ? undefined : stream?.sourceSubscriptionId;
}

export function XyCaptureProvider({ children }: { children: ReactNode }) {
  const { connection, state, watchActions, checkAction } = useHost();
  const route = useContext(LanWorkbenchContext)?.route;
  const [draft, setDraft] = useState<Slots>({});
  const available =
    !route &&
    !!connection &&
    state.status === "ready" &&
    state.catalog.some(
      (action) =>
        action.actionId === alignXyAction &&
        action.targetKinds.includes("host"),
    );

  function currentSource(source: CaptureSource) {
    return (
      available &&
      source.connection === connection &&
      sourceGeneration(state, source) === source.generation
    );
  }
  const x = draft.x && currentSource(draft.x.source) ? draft.x : undefined;
  const y = draft.y && currentSource(draft.y.source) ? draft.y : undefined;
  if (draft.x !== x || draft.y !== y) setDraft({ x, y });
  const inputs = useMemo(
    () => [x?.check, y?.check].filter((input) => input !== undefined),
    [x, y],
  );
  const [observed, setObserved] = useState<{
    inputs: typeof inputs;
    watch: typeof watchActions;
    allowed: ReadonlySet<HostActionCheckInput>;
  }>();

  const seenApproval = useRef(new WeakSet<HostActionCheckInput>());
  useEffect(() => {
    if (!inputs.length) return;
    let active = true;
    const approved = seenApproval.current;
    const stop = watchActions(inputs, (values) => {
      if (!active) return;
      const allowed = new Set<HostActionCheckInput>();
      const lost = new Set<HostActionCheckInput>();
      for (const [index, { result, error }] of values.entries()) {
        // The observer clones check inputs and delivers results in request order.
        const input = inputs[index];
        if (!input) continue;
        if (result?.allowed === true && !error) {
          allowed.add(input);
          approved.add(input);
        } else if (approved.has(input) || result?.allowed === false || error) {
          lost.add(input);
        }
      }
      setObserved({ inputs, watch: watchActions, allowed });
      if (lost.size)
        setDraft((current) => ({
          x: current.x && !lost.has(current.x.check) ? current.x : undefined,
          y: current.y && !lost.has(current.y.check) ? current.y : undefined,
        }));
    });
    return () => {
      active = false;
      stop();
    };
  }, [inputs, watchActions]);

  const approval =
    observed?.inputs === inputs && observed.watch === watchActions
      ? observed.allowed
      : undefined;
  const visibleX = x && approval?.has(x.check) ? x : undefined;
  const visibleY = y && approval?.has(y.check) ? y : undefined;
  const latest = useRef({ x: visibleX, y: visibleY });
  latest.current = { x: visibleX, y: visibleY };
  const clear = useCallback(() => setDraft({}), []);

  return (
    <Context.Provider
      value={{
        connection,
        available,
        axes: { x: visibleX?.channel, y: visibleY?.channel },
        source(session, kind) {
          if (!available || !connection) return;
          const generation = sourceGeneration(state, { ...session, kind });
          if (generation === undefined) return;
          return { ...session, kind, generation, connection };
        },
        stage(axis, channel, source) {
          if (!currentSource(source)) return;
          const { sessionId, sessionEpoch, kind, connection } = source;
          const check: HostActionCheckInput = {
            actionId: kind === "replay" ? "replay.read" : "stream.cursor",
            target: {
              hostId: connection.hostTarget.hostId,
              kind: "session",
              id: sessionId,
              sessionId,
              sessionEpoch,
            },
            params:
              kind === "replay"
                ? {
                    sessionId,
                    sessionEpoch,
                    maxRecords: "1",
                    maxBytes: "65536",
                  }
                : {},
          };
          setDraft((current) => ({
            ...current,
            [axis]: { source, channel, check },
          }));
        },
        async verify(pair, signal) {
          const { x, y } = latest.current;
          if (!x || !y || x.channel !== pair.x || y.channel !== pair.y)
            return false;
          const decisions = await Promise.all([
            checkAction(x.check, signal),
            checkAction(y.check, signal),
          ]);
          return (
            latest.current.x === x &&
            latest.current.y === y &&
            decisions.every(({ allowed }) => allowed)
          );
        },
        clear,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useXyCapture() {
  const capture = useContext(Context);
  const host = useContext(HostContext);
  return capture?.connection === host?.connection ? capture : null;
}
