import type { StreamHighlightRule } from "./stream-highlight";
import type {
  CaptureRecord,
  ReplayArchiveRange,
  ReplayControlParams,
  ReplayReadParams,
  ReplayReadResult,
  ReplayRecord,
  ReplaySearchHit,
  TextEncoding,
  SessionSnapshot,
  TerminalSettings,
} from "@serial-workbench/contracts";
import { ContractValidationError } from "@serial-workbench/contracts";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  ChartLine,
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  CornerDownRight,
  Gauge,
  Info,
  List,
  Pause,
  Play,
  StepForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { nativeErrorCode } from "@/lib/native-error";
import { parseU64 } from "@/lib/u64";
import type { HostActionCheckInput } from "@/providers/host-context";
import type {
  ComparisonSide,
  ReplayComparisonSample,
} from "./session-comparison-model";
import { captureRecordItems } from "./capture-record-items";
import { StreamView } from "./stream-view";
import { CaptureRedactedRecords } from "./capture-redacted-records";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchDialog } from "./workbench-dialog";
import {
  ReplaySearchTool,
  type ReplaySearchOptions,
} from "./replay-search-tool";
import { useToolActionAvailability } from "./use-tool-action-availability";
import type { ChartSourceSelection } from "./stream-chart-selection";
import { WorkbenchNotice, operationFailureEventKey } from "./workbench-notice";
import { workbenchStatus } from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";
import type { WorkbenchLabels } from "./labels";
import type { StreamPresentationLabels } from "./stream-presentation";

const ReplayFieldChart = lazy(() => import("./replay-field-chart"));
export type ReplayReader = (
  params: ReplayReadParams,
  signal?: AbortSignal,
) => Promise<ReplayReadResult>;
export type ReplayRecordReader = (
  record: Extract<ReplayRecord, { kind: "reference" }>,
  signal?: AbortSignal,
) => Promise<CaptureRecord>;
export type ReplayController = (
  params: ReplayControlParams,
  signal?: AbortSignal,
) => Promise<ReplayReadResult>;
export type ReplayPanelProps = {
  session: SessionSnapshot;
  read: ReplayReader;
  readRecord: ReplayRecordReader;
  control: ReplayController;
  playbackSupported?: boolean;
  archiveAccess?: Pick<ReplaySearchOptions, "hostId" | "watchActions">;
  search?: ReplaySearchOptions;
  recordingName?: string;
  searchEncoding?: TextEncoding;
  disabled: boolean;
  labels: WorkbenchLabels;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
  highlightRules?: readonly StreamHighlightRule[];
  onHighlightRulesChange?: (rules: StreamHighlightRule[]) => void;
  comparison?: {
    label: string;
    count: number;
    stage: (side: ComparisonSide, sample: ReplayComparisonSample) => void;
    open: (trigger: HTMLElement) => void;
  };
};
function ReplayComparisonButton({
  comparison,
  disabled,
}: {
  comparison: NonNullable<ReplayPanelProps["comparison"]>;
  disabled: boolean;
}) {
  return (
    <WorkbenchIconButton
      label={comparison.label}
      disabled={disabled || comparison.count === 0}
      onClick={(event) => comparison.open(event.currentTarget)}
    >
      <GitCompareArrows aria-hidden="true" />
    </WorkbenchIconButton>
  );
}

const ARCHIVE_PAGE_RECORDS = 100;

type ArchivePage = {
  result: ReplayReadResult;
  first: bigint;
  total: bigint;
  request: number;
};

function checkedArchivePage(
  range: ReplayArchiveRange,
  result: ReplayReadResult,
  request: number,
): ArchivePage {
  const total = parseU64(result.archiveTotalRecords);
  const next = parseU64(result.nextRecord);
  const pivot = parseU64(range.record);
  const count = result.records.length;
  const first = (next ?? 0n) - BigInt(count);
  if (
    total === undefined ||
    next === undefined ||
    pivot === undefined ||
    first < 1n ||
    next > total + 1n ||
    count > ARCHIVE_PAGE_RECORDS ||
    result.playback ||
    result.atEnd !== (next === total + 1n) ||
    (range.kind === "from"
      ? first !== pivot || (count === 0 && !result.atEnd)
      : next !== pivot || (count === 0 && pivot !== 1n)) ||
    result.records.some(
      (entry, index) =>
        parseU64(
          entry.kind === "inline"
            ? entry.record.recordOrdinal
            : entry.recordOrdinal,
        ) !==
        first + BigInt(index),
    )
  )
    throw new ContractValidationError("Replay archive page changed");
  return { result, first, total, request };
}

export function ReplayPanel({
  session,
  read,
  readRecord,
  control,
  playbackSupported = false,
  archiveAccess,
  search,
  recordingName,
  searchEncoding = "utf-8",
  disabled,
  labels,
  terminalSettings,
  presentationLabels,
  highlightRules,
  onHighlightRulesChange,
  comparison,
}: ReplayPanelProps) {
  const [playbackPage, setPage] = useState<ReplayReadResult>();
  const [archivePage, setArchivePage] = useState<ArchivePage>();
  const [searchLocation, setSearchLocation] = useState<{
    page: ReplayReadResult;
    hit: ReplaySearchHit;
  }>();
  const latestPage = useRef<ReplayReadResult | undefined>(undefined);
  const [expanded, setExpanded] = useState<Record<string, CaptureRecord>>({});
  const [seek, setSeek] = useState("");
  const [breakpointDraft, setBreakpointDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; eventKey: string }>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const chartTrigger = useRef<HTMLButtonElement | null>(null);
  const [chartLink, setChartLink] = useState<{
    page: ReplayReadResult;
    selection?: ChartSourceSelection;
    reveal?: ChartSourceSelection;
  }>();
  const noticeId = useId();
  const attempts = useRef(0);
  const pending = useRef<{
    controller: AbortController;
    archive: boolean;
  } | null>(null);
  useEffect(() => {
    setBusy(false);
    setPage(undefined);
    setArchivePage(undefined);
    setSearchLocation(undefined);
    setExpanded({});
    setSeek("");
    setBreakpointDraft(undefined);
    setError(undefined);
    setDetailsOpen(false);
    setChartOpen(false);
    setChartLink(undefined);
    return () => {
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, [read, readRecord, control, session.sessionId, session.sessionEpoch]);
  async function act(
    action: (signal: AbortSignal) => Promise<void>,
    archive = false,
  ) {
    if (pending.current) return false;
    const controller = new AbortController();
    pending.current = { controller, archive };
    const attempt = ++attempts.current;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
      return !controller.signal.aborted;
    } catch (reason) {
      if (
        !controller.signal.aborted &&
        !(reason instanceof DOMException && reason.name === "AbortError")
      )
        setError({
          code: nativeErrorCode(reason) ?? "INTERNAL",
          eventKey:
            operationFailureEventKey(reason) ?? `${noticeId}:replay:${attempt}`,
        });
      return false;
    } finally {
      if (pending.current?.controller === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const target = {
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
  };
  const sourceAccess =
    archiveAccess ?? (playbackSupported ? search : undefined);
  const sourceHostId = sourceAccess?.hostId;
  const sourceChecks = useMemo<HostActionCheckInput[]>(
    () =>
      sourceHostId && !disabled
        ? [
            {
              actionId: "replay.read",
              target: {
                hostId: sourceHostId,
                kind: "session",
                id: session.sessionId,
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
              },
              params: {
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
                maxRecords: "1",
                maxBytes: "65536",
              },
            },
          ]
        : [],
    [sourceHostId, disabled, session.sessionId, session.sessionEpoch],
  );
  const canReadSource = useToolActionAvailability(
    sourceChecks,
    sourceAccess?.watchActions,
  )(sourceChecks[0]);
  const archiveAllowed = !!archiveAccess && canReadSource;
  const activeArchive = archiveAllowed ? archivePage : undefined;
  const page =
    activeArchive?.result ?? (archivePage ? undefined : playbackPage);
  latestPage.current = page;
  useEffect(() => {
    if (archiveAllowed) return;
    if (pending.current?.archive) {
      pending.current.controller.abort();
      pending.current = null;
      setBusy(false);
    }
    if (archivePage) {
      setPage(undefined);
      setArchivePage(undefined);
      setExpanded({});
      setSearchLocation(undefined);
      setChartOpen(false);
      setChartLink(undefined);
      setDetailsOpen(false);
    }
  }, [archiveAllowed, archivePage]);

  const records = useMemo(
    () =>
      page?.records.flatMap((record) =>
        record.kind === "inline"
          ? [record.record]
          : expanded[record.recordOrdinal]
            ? [expanded[record.recordOrdinal]!]
            : [],
      ) ?? [],
    [expanded, page],
  );
  const items = useMemo(() => captureRecordItems(records), [records]);
  const redacted = page?.mode === "redacted";
  const linked = chartLink?.page === page ? chartLink : undefined;
  const searchAllowed =
    !redacted && canReadSource && (playbackSupported || !!activeArchive);
  if (!searchAllowed && searchLocation) setSearchLocation(undefined);
  const playback = page?.playback;
  const availableControls = !disabled && !busy;
  const breakpoint = breakpointDraft ?? playback?.breakpointRecord ?? "";
  const seekOrdinal = parseU64(seek);
  const breakpointOrdinal = parseU64(breakpoint);
  const validSeek =
    seekOrdinal !== undefined &&
    seekOrdinal > 0n &&
    (!activeArchive || seekOrdinal <= activeArchive.total);
  const validBreakpoint =
    breakpointOrdinal !== undefined && breakpointOrdinal > 0n;
  const timedSpeeds = [25, 50, 100, 150, 200, 300, 400];
  const rate = playback?.rate;
  const speed = rate?.kind === "timed" ? rate.speedPercent : undefined;
  const speeds =
    speed !== undefined && !timedSpeeds.includes(speed)
      ? [...timedSpeeds, speed].sort((a, b) => a - b)
      : timedSpeeds;
  const archiveStatus =
    activeArchive &&
    (activeArchive.total === 0n
      ? labels.captureEmpty
      : labels.replayArchiveRange(
          activeArchive.first.toString(),
          (BigInt(activeArchive.result.nextRecord) - 1n).toString(),
          activeArchive.total.toString(),
        ));
  const playbackStatus = page?.atEnd
    ? labels.atEnd
    : playback?.breakpointHit && playback.breakpointRecord !== undefined
      ? labels.replayBreakpointHit + " " + playback.breakpointRecord
      : playback?.paused
        ? labels.replayPaused
        : playbackSupported && page
          ? labels.replayNextRecord + " " + page.nextRecord
          : "";

  const status = archiveStatus ?? playbackStatus;

  function closePageDetails() {
    setExpanded({});
    setChartLink(undefined);
    setChartOpen(false);
    setDetailsOpen(false);
    setSearchLocation(undefined);
  }

  const browsePage = (
    range: ReplayArchiveRange,
    location?: {
      hit: ReplaySearchHit;
      waiting: AbortSignal;
    },
  ) =>
    act(async (owned) => {
      const signal = location
        ? AbortSignal.any([owned, location.waiting])
        : owned;
      signal.throwIfAborted();
      const result = await read(
        {
          ...target,
          archive: range,
          maxRecords: String(ARCHIVE_PAGE_RECORDS),
          maxBytes: "65536",
        },
        signal,
      );
      signal.throwIfAborted();
      const next = checkedArchivePage(range, result, attempts.current);
      if (activeArchive && activeArchive.total !== next.total)
        throw new ContractValidationError("Replay archive size changed");
      closePageDetails();
      setArchivePage(next);
      if (location) setSearchLocation({ page: result, hit: location.hit });
    }, true);

  function handleSeek() {
    if (!availableControls || !validSeek) return;
    const record = seekOrdinal.toString();
    if (activeArchive) void browsePage({ kind: "from", record });
    else void sendControl(true, { seekRecord: record });
  }

  const readPage = (singleStep = false) =>
    act(async (signal) => {
      const result = await read(
        {
          ...target,
          maxRecords: singleStep ? "1" : "100",
          maxBytes: "65536",
          ...(playbackSupported ? { reportPlayback: true } : {}),
          ...(singleStep ? { singleStep: true } : {}),
        },
        signal,
      );
      if (signal.aborted) return;
      if (
        (playbackSupported && !result.playback) ||
        (singleStep && result.records.length > 1)
      )
        throw new ContractValidationError("Replay read result changed");
      setPage(result);
      setExpanded({});
      setChartLink(undefined);
    });
  const sendControl = (
    paused: boolean,
    update: Pick<ReplayControlParams, "seekRecord" | "playback"> = {},
  ) =>
    act(async (signal) => {
      const { playback: _legacyPlayback, ...terminalPosition } = await control(
        { ...target, paused, ...update },
        signal,
      );
      if (signal.aborted) return;
      if (
        terminalPosition.records.length ||
        (update.seekRecord !== undefined &&
          terminalPosition.nextRecord !== update.seekRecord)
      )
        throw new ContractValidationError("Replay control result changed");

      let position: ReplayReadResult = terminalPosition;
      try {
        if (playbackSupported) {
          const snapshot = await read(
            {
              ...target,
              maxRecords: "1",
              maxBytes: "65536",
              inspectPlayback: true,
            },
            signal,
          );
          if (!snapshot.playback || snapshot.records.length)
            throw new ContractValidationError(
              "Replay playback snapshot changed",
            );
          position = snapshot;
        }
      } finally {
        if (!signal.aborted) {
          if (
            !page ||
            update.seekRecord !== undefined ||
            page.readerGeneration !== position.readerGeneration
          ) {
            setPage(position);
            setExpanded({});
            setChartLink(undefined);
          } else {
            setPage({ ...position, records: page.records });
          }
          if (update.playback?.kind === "set_breakpoint")
            setBreakpointDraft(undefined);
        }
      }
    });
  const locateSearchHit = (hit: ReplaySearchHit, waiting: AbortSignal) =>
    activeArchive
      ? browsePage({ kind: "from", record: hit.firstRecord }, { hit, waiting })
      : act(async (owned) => {
          const signal = AbortSignal.any([owned, waiting]);
          signal.throwIfAborted();
          const position = await control(
            { ...target, paused: true, seekRecord: hit.firstRecord },
            signal,
          );
          signal.throwIfAborted();
          if (
            position.nextRecord !== hit.firstRecord ||
            position.records.length
          )
            throw new ContractValidationError("Replay search position changed");
          const result = await read(
            {
              ...target,
              singleStep: true,
              reportPlayback: true,
              maxRecords: "1",
              maxBytes: "65536",
            },
            signal,
          );
          signal.throwIfAborted();
          const record = result.records[0];
          const ordinal =
            record?.kind === "inline"
              ? record.record.recordOrdinal
              : record?.recordOrdinal;
          if (
            result.records.length !== 1 ||
            ordinal !== hit.firstRecord ||
            !result.playback?.paused ||
            result.readerGeneration !== position.readerGeneration
          )
            throw new ContractValidationError("Replay search record changed");
          setPage(result);
          setExpanded({});
          setChartLink(undefined);
          setSearchLocation({ page: result, hit });
        });
  const located =
    searchAllowed && searchLocation?.page === page
      ? searchLocation?.hit
      : undefined;
  const locatedLabel =
    located &&
    search?.t("workbench.replaySearchLocated", {
      record: located.firstRecord,
      start: located.byteStart,
      end: located.byteEnd,
    });
  return (
    <section aria-label={labels.replay} className="workbench-replay">
      <div className="workbench-toolbar workbench-replay-toolbar">
        <h2 className="sr-only">{labels.replay}</h2>
        {archiveAllowed && (
          <WorkbenchIconButton
            label={labels.browseReplay}
            aria-pressed={!!activeArchive}
            variant={activeArchive ? "secondary" : "ghost"}
            disabled={!availableControls}
            onClick={() => {
              if (activeArchive) {
                setArchivePage(undefined);
                closePageDetails();
              } else {
                void browsePage({ kind: "from", record: "1" });
              }
            }}
          >
            <List aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        {activeArchive ? (
          <>
            <WorkbenchIconButton
              label={labels.previousReplayPage}
              disabled={!availableControls || activeArchive.first <= 1n}
              onClick={() =>
                void browsePage({
                  kind: "before",
                  record: activeArchive.first.toString(),
                })
              }
            >
              <ChevronLeft aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.nextReplayPage}
              disabled={!availableControls || activeArchive.result.atEnd}
              onClick={() =>
                void browsePage({
                  kind: "from",
                  record: activeArchive.result.nextRecord,
                })
              }
            >
              <ChevronRight aria-hidden="true" />
            </WorkbenchIconButton>
          </>
        ) : (
          <>
            <WorkbenchIconButton
              label={labels.readReplay}
              disabled={busy}
              onClick={() => void readPage()}
            >
              <BookOpen aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.pauseReplay}
              disabled={disabled || busy}
              onClick={() => void sendControl(true)}
            >
              <Pause aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.resumeReplay}
              disabled={disabled || busy}
              onClick={() => void sendControl(false)}
            >
              <Play aria-hidden="true" />
            </WorkbenchIconButton>
            {playbackSupported ? (
              <WorkbenchIconButton
                label={labels.stepReplay}
                disabled={!availableControls || page?.atEnd}
                onClick={() => void readPage(true)}
              >
                <StepForward aria-hidden="true" />
              </WorkbenchIconButton>
            ) : null}
          </>
        )}
        <Input
          aria-label={labels.seekRecord}
          value={seek}
          onChange={(event) => setSeek(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSeek();
            }
          }}
          inputMode="numeric"
          className="workbench-replay-seek"
        />
        <WorkbenchIconButton
          label={labels.seekRecord}
          disabled={disabled || busy || !validSeek}
          onClick={handleSeek}
        >
          <CornerDownRight aria-hidden="true" />
        </WorkbenchIconButton>
        {search && searchAllowed && (
          <ReplaySearchTool
            search={search}
            target={target}
            recording={recordingName ?? labels.replay}
            initialEncoding={searchEncoding}
            closeLabel={labels.closeView}
            jumpDisabled={!availableControls}
            onJump={locateSearchHit}
          />
        )}
        <span
          role="status"
          className="workbench-replay-status"
          title={locatedLabel || status}
        >
          {locatedLabel
            ? [status, locatedLabel].filter(Boolean).join(" · ")
            : status}
        </span>
        {redacted && <span>{labels.captureRedacted}</span>}
        {playbackSupported && !activeArchive ? (
          <Popover>
            <PopoverTrigger asChild>
              <WorkbenchIconButton label={labels.replayPlayback}>
                <Gauge aria-hidden="true" />
              </WorkbenchIconButton>
            </PopoverTrigger>
            <PopoverContent
              aria-label={labels.replayPlayback}
              align="end"
              className="w-64 max-w-[calc(100vw-1.5rem)] space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor={noticeId + "-speed"}>{labels.replayRate}</Label>
                <Select
                  disabled={!availableControls}
                  value={
                    rate?.kind === "timed"
                      ? String(rate.speedPercent)
                      : (rate?.kind ?? "")
                  }
                  onValueChange={(value) =>
                    void sendControl(playback?.paused ?? false, {
                      playback: {
                        kind: "set_rate",
                        rate:
                          value === "fastest"
                            ? { kind: "fastest" }
                            : { kind: "timed", speedPercent: Number(value) },
                      },
                    })
                  }
                >
                  <SelectTrigger id={noticeId + "-speed"} className="w-full">
                    <SelectValue placeholder={labels.replayRate} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fastest">
                      {labels.replayFastest}
                    </SelectItem>
                    {speeds.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option}%
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={noticeId + "-breakpoint"}>
                  {labels.replayBreakpoint}
                </Label>
                <Input
                  id={noticeId + "-breakpoint"}
                  disabled={!availableControls}
                  inputMode="numeric"
                  value={breakpoint}
                  onChange={(event) => setBreakpointDraft(event.target.value)}
                />
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!availableControls || !validBreakpoint}
                    onClick={() => {
                      if (validBreakpoint)
                        void sendControl(playback?.paused ?? false, {
                          playback: {
                            kind: "set_breakpoint",
                            record: breakpointOrdinal.toString(),
                          },
                        });
                    }}
                  >
                    {labels.setReplayBreakpoint}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      !availableControls ||
                      playback?.breakpointRecord === undefined
                    }
                    onClick={() =>
                      void sendControl(playback?.paused ?? false, {
                        playback: { kind: "set_breakpoint" },
                      })
                    }
                  >
                    {labels.clearReplayBreakpoint}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        {!redacted && (
          <WorkbenchIconButton
            label={labels.replayFieldChart}
            disabled={
              busy ||
              !items.some(
                (item) => item.kind === "source" && item.event.kind === "rx",
              )
            }
            onClick={(event) => {
              if (pending.current) return;
              chartTrigger.current = event.currentTarget;
              setChartLink(undefined);
              setChartOpen(true);
            }}
          >
            <ChartLine aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        {!redacted && comparison ? (
          <ReplayComparisonButton comparison={comparison} disabled={disabled} />
        ) : null}
        <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={labels.operationText.details}
              disabled={!page && !error}
            >
              <Info aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent
            aria-label={labels.operationText.details}
            align="end"
            className="workbench-detail-popover workbench-replay-details"
          >
            {error && <p>{labels.operationText.failure(error.code)}</p>}
            {page?.records.map(
              (record) =>
                record.kind === "reference" && (
                  <section key={record.recordOrdinal}>
                    <h3>
                      {labels.captureLargeRecord} {record.recordOrdinal}
                    </h3>
                    {!expanded[record.recordOrdinal] && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(async (signal) => {
                            const result = await readRecord(record, signal);
                            if (!signal.aborted)
                              setExpanded((current) => ({
                                ...current,
                                [record.recordOrdinal]: result,
                              }));
                          }, !!activeArchive)
                        }
                      >
                        {labels.readReplay} {record.recordOrdinal}
                      </Button>
                    )}
                    <Textarea
                      readOnly
                      aria-label={labels.captureLargeRecord}
                      value={JSON.stringify(record, null, 2)}
                      className="workbench-log-details"
                    />
                  </section>
                ),
            )}
            {records.map(
              (record) =>
                record.entry.kind === "tx_settlement" && (
                  <section key={record.recordOrdinal}>
                    <h3>
                      {labels.receipt} {record.recordOrdinal}
                    </h3>
                    <p>
                      {workbenchStatus(
                        record.entry.value.receipt.outcome,
                        labels,
                      )}
                    </p>
                    <TxReceiptFacts
                      receipt={record.entry.value.receipt}
                      labels={labels}
                    />
                    <Textarea
                      readOnly
                      aria-label={labels.receipt}
                      className="workbench-log-details"
                      value={JSON.stringify(
                        {
                          recordOrdinal: record.recordOrdinal,
                          hostId: record.entry.value.hostId,
                          instanceEpoch: record.entry.value.instanceEpoch,
                          operationId: record.entry.value.receipt.operationId,
                          sessionId: record.entry.value.receipt.sessionId,
                          sessionEpoch: record.entry.value.receipt.sessionEpoch,
                          outcome: record.entry.value.receipt.outcome,
                          backendErrorCode:
                            record.entry.value.receipt.backendError?.code,
                        },
                        null,
                        2,
                      )}
                    />
                  </section>
                ),
            )}
          </PopoverContent>
        </Popover>
      </div>
      <WorkbenchNotice
        noticeKey={`replay:${error?.code ?? "none"}`}
        eventKey={error?.eventKey}
        log={
          error
            ? {
                module: "capture",
                level: "error",
                code: error.code,
                message: labels.operationText.failure(error.code),
                context: labels.replay,
              }
            : undefined
        }
      >
        {error ? (
          <span role="alert">{labels.operationText.failure(error.code)}</span>
        ) : null}
      </WorkbenchNotice>
      {redacted ? (
        <CaptureRedactedRecords records={records} labels={labels} />
      ) : (
        <StreamView
          key={playbackPage?.readerGeneration ?? "unread"}
          fixedPageKey={activeArchive?.request}
          items={items}
          chartReveal={linked?.reveal}
          onChartSelection={
            page && !busy
              ? (selection, trigger) => {
                  if (pending.current) return;
                  chartTrigger.current = trigger;
                  setChartLink({ page, selection });
                  setChartOpen(true);
                }
              : undefined
          }
          labels={labels}
          terminalSettings={terminalSettings}
          presentationLabels={presentationLabels}
          highlightRules={highlightRules}
          onHighlightRulesChange={onHighlightRulesChange}
        />
      )}
      <WorkbenchDialog
        open={chartOpen && !redacted}
        scopeKey={JSON.stringify([
          session.sessionId,
          session.sessionEpoch,
          page?.readerGeneration,
          page?.nextRecord,
        ])}
        title={labels.replayFieldChart}
        closeLabel={labels.closeView}
        returnFocus={chartTrigger}
        onRequestClose={() => setChartOpen(false)}
      >
        {(beforeReplace) => (
          <Suspense>
            <ReplayFieldChart
              records={records}
              replaySession={session}
              sourceSelection={linked?.selection}
              onStageComparison={
                page && comparison && !disabled
                  ? (side, sample) =>
                      void beforeReplace().then((allowed) => {
                        if (!allowed || latestPage.current !== page) return;
                        comparison.stage(side, sample);
                        setChartOpen(false);
                      })
                  : undefined
              }
              onRevealSource={
                page
                  ? (source) =>
                      void beforeReplace().then((allowed) => {
                        if (!allowed || latestPage.current !== page) return;
                        setChartLink({ page, reveal: source });
                        setChartOpen(false);
                      })
                  : undefined
              }
            />
          </Suspense>
        )}
      </WorkbenchDialog>
    </section>
  );
}
