import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StreamItem } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import type { HostState } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { distinctWorkspaceLabels } from "./workspace-model";
import { sliceRawBytes } from "./stream-model";
import {
  liveReceiveRows,
  matchLiveReceiveRow,
  receiveComparisonModes,
  receiveComparisonToleranceMs,
  type ReceiveComparisonMode,
  type ReceiveComparisonRow,
} from "./live-session-comparison-model";

type Side = "left" | "right";
const sides = ["left", "right"] as const;
const emptyStream: readonly StreamItem[] = [];
const rowHeight = 56;
const previewBytes = 24;
const detailBytes = 256;

type ComparisonSource = Parameters<typeof liveReceiveRows>[1];

export default function LiveSessionComparison({
  state,
  watchIds,
  selectedSession,
  attachment,
}: {
  state: HostState;
  watchIds: string;
  selectedSession?: string;
  attachment?: Pick<ComparisonSource, "hostId" | "instanceEpoch">;
}) {
  const { t } = useI18n();
  const alignmentTrigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const trigger = alignmentTrigger.current;
    if (trigger?.closest(".workbench-dialog-body") === document.activeElement)
      trigger?.focus({ preventScroll: true });
  }, []);
  const sessions = useMemo(() => {
    const watched = new Set(watchIds.split("\0"));
    return state.status === "ready" && attachment
      ? state.sessions.filter(
          (session) =>
            watched.has(session.sessionId) && session.state === "open",
        )
      : [];
  }, [state.status, state.sessions, watchIds, attachment]);
  const [selection, setSelection] = useState(() => {
    const left =
      sessions.find((session) => session.sessionId === selectedSession) ??
      sessions[0];
    const right = sessions.find(
      (session) => session.sessionId !== left?.sessionId,
    );
    return { left: left?.sessionId, right: right?.sessionId };
  });
  const [policy, setPolicy] = useState({
    mode: "time" as ReceiveComparisonMode,
    linked: true,
    revision: 0,
  });
  const { mode, linked } = policy;
  const choices = distinctWorkspaceLabels(
    sessions.map((session) => ({
      value: session.sessionId,
      label:
        state.devices.find((device) => device.deviceId === session.deviceId)
          ?.systemName ?? session.deviceId,
    })),
  );
  const sources = sides.map((side) => {
    const session = sessions.find(
      (candidate) => candidate.sessionId === selection[side],
    );
    const view = session && state.streams.get(session.sessionId);
    const subscriptionId = view?.error ? undefined : view?.sourceSubscriptionId;
    return {
      side,
      subscriptionId,
      source:
        attachment && session
          ? {
              hostId: attachment.hostId,
              instanceEpoch: attachment.instanceEpoch,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
            }
          : undefined,
      items: subscriptionId ? (view?.sourceItems ?? emptyStream) : emptyStream,
      unavailable: !subscriptionId,
      trimmed: Boolean(subscriptionId && view?.trimmed),
    };
  });
  const rules = receiveComparisonModes.map((value) => ({
    value,
    label: t(`liveCompare.mode.${value}`),
  }));
  return (
    <div className="workbench-live-compare">
      <div className="workbench-live-compare-actions">
        <OptionsSelect
          label={t("liveCompare.rule")}
          triggerRef={alignmentTrigger}
          options={rules}
          value={mode}
          onValueChange={(value) => {
            const next = receiveComparisonModes.find(
              (entry) => entry === value,
            );
            if (next)
              setPolicy((current) => ({
                ...current,
                mode: next,
                revision: current.revision + 1,
              }));
          }}
        />
        <Button
          size="sm"
          variant={linked ? "secondary" : "outline"}
          aria-pressed={linked}
          onClick={() =>
            setPolicy((current) => ({
              ...current,
              linked: !current.linked,
              revision: current.revision + 1,
            }))
          }
        >
          {t("liveCompare.link")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(`liveCompare.rule.${mode}`, { ms: receiveComparisonToleranceMs })}
      </p>
      {sessions.length < 2 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("liveCompare.needSessions")}
        </p>
      )}
      <LinkedPanes
        key={JSON.stringify(
          sources.map(({ source, subscriptionId }) => [source, subscriptionId]),
        )}
        policy={policy}
        panes={sources.map((pane) => {
          const side = pane.side;
          const other = side === "left" ? "right" : "left";
          const label = t(`liveCompare.${side}`);
          return {
            ...pane,
            label,
            picker: (
              <OptionsSelect
                label={label}
                placeholder={t("liveCompare.choose")}
                disabled={choices.every(
                  (choice) => choice.value === selection[other],
                )}
                options={choices.filter(
                  (choice) => choice.value !== selection[other],
                )}
                value={
                  choices.some((choice) => choice.value === selection[side])
                    ? (selection[side] ?? "")
                    : ""
                }
                onValueChange={(id) =>
                  setSelection((current) => ({ ...current, [side]: id }))
                }
              />
            ),
          };
        })}
      />
    </div>
  );
}

type PaneSource = {
  side: Side;
  source?: ComparisonSource;
  items: readonly StreamItem[];
  trimmed: boolean;
  unavailable: boolean;
  label: string;
  picker: ReactNode;
};
type Alignment = {
  revision: number;
  side: Side;
  sourceKey: string;
  targetKey?: string;
  timeDeltaNs?: bigint;
};

function LinkedPanes({
  panes,
  policy,
}: {
  panes: readonly PaneSource[];
  policy: { mode: ReceiveComparisonMode; linked: boolean; revision: number };
}) {
  const { t } = useI18n();
  const left = panes[0]!;
  const right = panes[1]!;
  const leftRows = useReceiveRows(left);
  const rightRows = useReceiveRows(right);
  const [alignment, setAlignment] = useState<Alignment>();
  const rowsBySide = { left: leftRows, right: rightRows };
  const [details, setDetails] = useState<{
    side: Side;
    key: string;
    offset: number;
  }>();
  const selected =
    details && rowsBySide[details.side].find((row) => row.key === details.key);
  const inspected = selected?.kind === "rx" ? selected : undefined;
  const current =
    alignment?.revision === policy.revision ? alignment : undefined;
  const active =
    current &&
    rowsBySide[current.side].some((row) => row.key === current.sourceKey)
      ? current
      : undefined;
  const aligned =
    active?.targetKey &&
    rowsBySide[active.side === "left" ? "right" : "left"].some(
      (row) => row.key === active.targetKey,
    );

  function align(side: Side, source: ReceiveComparisonRow) {
    if (!policy.linked) return;
    const targetSide = side === "left" ? "right" : "left";
    const match = matchLiveReceiveRow(
      source,
      rowsBySide[targetSide],
      policy.mode,
    );
    setAlignment({
      revision: policy.revision,
      side,
      sourceKey: source.key,
      targetKey: match?.key,
      timeDeltaNs: match?.timeDeltaNs,
    });
  }

  return (
    <>
      <p
        role="status"
        className="workbench-live-compare-status text-xs text-muted-foreground"
      >
        {current &&
          (aligned
            ? active?.timeDeltaNs === undefined
              ? t("liveCompare.aligned")
              : t("liveCompare.alignedTime", {
                  delta: active.timeDeltaNs.toString(),
                })
            : t("liveCompare.noMatch"))}
      </p>
      <div className="workbench-live-compare-panes">
        {panes.map((pane) => (
          <ComparisonPane
            key={pane.side}
            pane={pane}
            rows={rowsBySide[pane.side]}
            alignment={
              aligned && active?.side !== pane.side ? active : undefined
            }
            onAnchor={align}
            inspectedKey={
              inspected && details?.side === pane.side
                ? inspected.key
                : undefined
            }
            onInspect={(side, row) => {
              setDetails((current) =>
                current?.side === side && current.key === row.key
                  ? undefined
                  : { side, key: row.key, offset: 0 },
              );
              align(side, row);
            }}
          />
        ))}
      </div>
      {inspected && details && (
        <div className="workbench-live-compare-detail">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">
              {details.side === "left" ? left.label : right.label}
            </span>
            <span className="text-xs tabular-nums">
              {t("liveCompare.detail", {
                start: String(inspected.start + BigInt(details.offset)),
                end: String(
                  inspected.start +
                    BigInt(
                      Math.min(
                        Number(inspected.end - inspected.start),
                        details.offset + detailBytes,
                      ),
                    ),
                ),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={details.offset === 0}
              onClick={() =>
                setDetails({ ...details, offset: details.offset - detailBytes })
              }
            >
              {t("liveCompare.previous")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                BigInt(details.offset + detailBytes) >=
                inspected.end - inspected.start
              }
              onClick={() =>
                setDetails({ ...details, offset: details.offset + detailBytes })
              }
            >
              {t("liveCompare.next")}
            </Button>
          </div>
          <pre data-surface="reading">
            {formatHex(
              bytePage(inspected, details.offset, detailBytes) ??
                new Uint8Array(),
            )}
          </pre>
        </div>
      )}
    </>
  );
}

function useReceiveRows({ items, source, unavailable }: PaneSource) {
  const { hostId, instanceEpoch, sessionId, sessionEpoch } = source ?? {};
  return useMemo(
    () =>
      !unavailable && hostId && instanceEpoch && sessionId && sessionEpoch
        ? liveReceiveRows(items, {
            hostId,
            instanceEpoch,
            sessionId,
            sessionEpoch,
          })
        : [],
    [items, unavailable, hostId, instanceEpoch, sessionId, sessionEpoch],
  );
}

function bytePage(
  row: Extract<ReceiveComparisonRow, { kind: "rx" }>,
  from: number,
  budget: number,
) {
  const length = row.end - row.start;
  return sliceRawBytes(
    row.event.payload.bytesBase64,
    length,
    from,
    Math.min(Number(length), from + budget),
  );
}

function ComparisonPane({
  pane,
  rows,
  alignment,
  onAnchor,
  inspectedKey,
  onInspect,
}: {
  pane: PaneSource;
  rows: readonly ReceiveComparisonRow[];
  alignment?: Alignment;
  onAnchor: (side: Side, row: ReceiveComparisonRow) => void;
  inspectedKey?: string;
  onInspect: (side: Side, row: ReceiveComparisonRow) => void;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const suppressedTop = useRef<number | undefined>(undefined);
  const lastAnchor = useRef<string | undefined>(undefined);
  const [view, setView] = useState({ top: 0, height: 280 });
  const index = alignment
    ? rows.findIndex((row) => row.key === alignment.targetKey)
    : -1;
  const first = Math.max(0, Math.floor(view.top / rowHeight) - 3);
  const last = Math.ceil((view.top + view.height) / rowHeight) + 3;
  const scrollLabel = t("liveCompare.records", { pane: pane.label });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setView({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || index < 0) return;
    const before = element.scrollTop;
    element.scrollTop = index * rowHeight;
    if (before !== element.scrollTop) {
      suppressedTop.current = element.scrollTop;
      setView({ top: element.scrollTop, height: element.clientHeight });
    }
  }, [index, alignment]);

  return (
    <div className="workbench-live-compare-pane">
      <label className="grid min-w-0 gap-1 text-sm">
        {pane.label}
        {pane.picker}
      </label>
      {pane.source && (
        <div
          ref={viewport}
          tabIndex={0}
          role="region"
          aria-label={scrollLabel}
          data-surface="reading"
          className="workbench-live-compare-log app-scroll-region"
          onScroll={(event) => {
            const element = event.currentTarget;
            setView({ top: element.scrollTop, height: element.clientHeight });
            const suppressed = suppressedTop.current;
            suppressedTop.current = undefined;
            if (
              suppressed !== undefined &&
              Math.abs(element.scrollTop - suppressed) < 1
            )
              return;
            const row =
              rows[
                Math.min(
                  rows.length - 1,
                  Math.floor(element.scrollTop / rowHeight),
                )
              ];
            if (!row || row.key === lastAnchor.current) return;
            lastAnchor.current = row.key;
            onAnchor(pane.side, row);
          }}
        >
          {rows.length ? (
            <ol
              className="workbench-live-compare-rows"
              style={{ height: rows.length * rowHeight }}
            >
              {rows.slice(first, last).map((row, relative) => {
                const match = index === first + relative;
                return (
                  <li
                    key={row.key}
                    style={{
                      top: (first + relative) * rowHeight,
                      height: rowHeight,
                    }}
                    data-aligned={match || undefined}
                    data-source-event={
                      row.kind === "rx" ? row.event.eventSeq : undefined
                    }
                  >
                    {row.kind === "rx" ? (
                      <Button
                        variant="ghost"
                        type="button"
                        className="workbench-live-compare-row"
                        aria-expanded={inspectedKey === row.key}
                        onClick={() => onInspect(pane.side, row)}
                      >
                        <span className="workbench-live-compare-coordinates">
                          <span>
                            {t("liveCompare.event", {
                              value: row.event.eventSeq,
                            })}
                          </span>
                          <span>
                            {t("liveCompare.offset", {
                              value: row.event.payload.byteStart,
                            })}
                          </span>
                          <time
                            title={
                              row.event.time.sourceWallTime ??
                              row.event.time.receivedWallTime
                            }
                          >
                            {(
                              row.event.time.sourceWallTime ??
                              row.event.time.receivedWallTime
                            ).slice(11, 23)}
                          </time>
                        </span>
                        <span className="workbench-live-compare-bytes">
                          {formatHex(
                            bytePage(row, 0, previewBytes) ?? new Uint8Array(),
                          )}
                          {row.end - row.start > previewBytes ? " …" : ""}
                        </span>
                      </Button>
                    ) : (
                      <div className="workbench-live-compare-boundary">
                        {t(
                          row.kind === "gap"
                            ? "liveCompare.gap"
                            : "liveCompare.configuration",
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t(
                pane.unavailable
                  ? "liveCompare.unavailable"
                  : "liveCompare.empty",
              )}
            </p>
          )}
        </div>
      )}
      {pane.trimmed && (
        <p className="text-xs text-muted-foreground">
          {t("liveCompare.trimmed")}
        </p>
      )}
    </div>
  );
}
