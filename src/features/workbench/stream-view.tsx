import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Download,
  Eraser,
  FileText,
  Info,
  Pause,
  Play,
  Search,
  Settings2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import type {
  StreamItem,
  TxReceipt,
  TerminalSettings,
  TerminalMode,
  TextEncoding,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { NotificationDetails } from "@/components/notification-content";
import { TextEncodingSelect } from "./text-encoding-select";
import {
  createTextDecoder,
  ENCODING_NAMES,
  receiveEncodingFor,
} from "@/lib/text-encoding";
import { detectTextEncoding } from "@/lib/encoding-detection";
import { receiveEncodingSample } from "./encoding-sample";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchNotice } from "./workbench-notice";
import { useStreamNotices } from "./stream-notices";
import { nativeErrorCode } from "@/lib/native-error";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { WorkbenchLabels } from "./labels";
import {
  decodeBytes,
  projectStreamItems,
  streamSourceKey,
  type StreamMatch,
} from "./stream-model";
import {
  presentStreamTimes,
  terminalTypographyStyle,
  compactStreamTime,
  workbenchStatus,
  type StreamPresentationLabels,
} from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";
import { formatByteSize } from "./metric-format";
import { requestStreamSearch } from "./stream-search-client";
import { ReceiveHistoryControls } from "./receive-history-controls";
import {
  DEFAULT_RECEIVE_HISTORY,
  ReceiveHistoryBuffer,
  type ReceiveHistory,
  type HistoryStreamItem,
} from "@/lib/receive-history";

function atStreamEnd(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
}

export type StreamViewProps = {
  historyLimits?: Readonly<ReceiveHistory>;
  onHistoryLimitsChange?: (value: ReceiveHistory) => void;
  encoding?: TextEncoding | null;
  sendEncoding?: TextEncoding;
  onEncodingChange?: (encoding: TextEncoding | null) => void;
  mode?: TerminalMode;
  onReceiveModeChange?: (mode: TerminalMode) => void;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
  replay?: boolean;
  initialMode?: "text" | "hex";
  items: readonly HistoryStreamItem[];
  labels: WorkbenchLabels;
  error?: Error | null;
  trimmed?: boolean;
  onOpenCapture?: () => void;
  onOpenActivity?: () => void;
  onClearView?: () => void;
  captureActive?: boolean;
  displayLabels?: {
    displayOptions: string;
    clearView: string;
  };
};
export function StreamView({
  historyLimits,
  onHistoryLimitsChange,
  items,
  labels,
  error,
  trimmed,
  initialMode = "text",
  mode: controlledMode,
  onReceiveModeChange,
  encoding: controlledEncoding,
  sendEncoding,
  onEncodingChange,
  terminalSettings,
  presentationLabels,
  replay = false,
  onOpenCapture,
  onOpenActivity,
  onClearView,
  captureActive = false,
  displayLabels,
}: StreamViewProps) {
  const id = useId();
  const [localEncoding, setEncoding] = useState<TextEncoding | null>();
  const encoding = receiveEncodingFor(
    controlledEncoding,
    localEncoding,
    terminalSettings?.receiveEncoding,
  );
  const [localMode, setMode] = useState<TerminalMode | null>(null);
  const [split, setSplit] = useState(false);
  const mode = split
    ? "split"
    : (controlledMode ??
      localMode ??
      terminalSettings?.receiveMode ??
      initialMode);
  const [timeMode, setTimeMode] = useState<
    "absolute" | "relative" | "interval"
  >("absolute");
  const [frozen, setFrozen] = useState<readonly HistoryStreamItem[] | null>(
    null,
  );
  const [reviewed, setReviewed] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState("");
  const [queryMode, setQueryMode] = useState<"text" | "hex">("text");
  const [match, setMatch] = useState<StreamMatch | null>(null);
  const [searched, setSearched] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [searchCount, setSearchCount] = useState(0);
  const [searchIndex, setSearchIndex] = useState(0);
  const searching = useRef<AbortController | null>(null);
  const found = useRef<
    | {
        key: string;
        source: readonly StreamItem[];
        matches: StreamMatch[];
        index: number;
      }
    | undefined
  >(undefined);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followInset = useRef(0);
  const scrollIntent = useRef<{
    top: number;
    direction: "up" | "down" | "drag";
  } | null>(null);
  const touchY = useRef<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const displayed = frozen ?? items;
  const historyMaxRecords = historyLimits?.maxRecords;
  const historyMaxBytes = historyLimits?.maxBytes;
  useEffect(() => {
    setFrozen((snapshot) => {
      if (!snapshot) return snapshot;
      const history = new ReceiveHistoryBuffer({
        maxRecords: historyMaxRecords ?? DEFAULT_RECEIVE_HISTORY.maxRecords,
        maxBytes: historyMaxBytes ?? DEFAULT_RECEIVE_HISTORY.maxBytes,
      });
      history.append(snapshot);
      return history.trimmed ? history.items() : snapshot;
    });
  }, [historyMaxRecords, historyMaxBytes]);
  useEffect(() => {
    const release = (event: Event) => {
      if (
        event.type !== "pointerup" ||
        scrollIntent.current?.direction === "drag"
      )
        scrollIntent.current = null;
      touchY.current = null;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  useStreamNotices(items, labels.gapHelp, replay ? undefined : labels);
  const pendingBoundary = useMemo(
    () => (frozen ? new Set(frozen.map(streamItemIdentity)) : reviewed),
    [frozen, reviewed],
  );
  const pendingCount = useMemo(
    () =>
      pendingBoundary
        ? items.filter((item) => !pendingBoundary.has(streamItemIdentity(item)))
            .length
        : 0,
    [pendingBoundary, items],
  );
  const following = !frozen && !reviewed;
  const followingActive = useRef(true);
  const reviewHistory = () => {
    if (frozen) return;
    setReviewed((current) => current ?? new Set(items.map(streamItemIdentity)));
  };
  const resume = () => {
    scrollIntent.current = null;
    setFrozen(null);
    setReviewed(null);
  };
  const projected = useMemo(() => projectStreamItems(displayed), [displayed]);
  const encodingSample = useMemo(
    () => (encoding === null ? receiveEncodingSample(displayed) : ""),
    [encoding, displayed],
  );
  const detection = useMemo(
    () => (encoding === null ? detectTextEncoding(encodingSample) : undefined),
    [encoding, encodingSample],
  );
  const receiveCodec = encoding ?? detection?.encoding ?? "utf-8";
  const sendCodec = sendEncoding ?? terminalSettings?.sendEncoding ?? "utf-8";
  const times = useMemo(
    () =>
      presentStreamTimes(
        projected.map(({ itemIndex }) => {
          const item = displayed[itemIndex]!;
          return item.kind === "source" && item.displayTime
            ? { ...item, event: { ...item.event, time: item.displayTime } }
            : item;
        }),
      ),
    [displayed, projected],
  );
  const rows = useMemo(() => {
    let decoder = createTextDecoder(receiveCodec);
    let txDecoder = createTextDecoder(sendCodec);
    let previousEnd: string | undefined;
    let previousSource: string | undefined;
    let previousTxEnd: string | undefined;
    let previousTxSource: string | undefined;
    const decoded = projected.map(({ item, itemIndex }, displayIndex) => {
      if (item.kind === "reader_gap") {
        decoder = createTextDecoder(receiveCodec);
        txDecoder = createTextDecoder(sendCodec);
        previousEnd = undefined;
        previousTxEnd = undefined;
        return {
          itemIndex,
          displayIndex,
          kind: "gap",
          text: `${item.gap.reason} [${item.gap.missingEventRange.start}, ${item.gap.missingEventRange.end})`,
        };
      }
      const event = item.event;
      if (
        event.kind === "configuration_boundary" ||
        event.kind === "lifecycle"
      ) {
        decoder = createTextDecoder(receiveCodec);
        txDecoder = createTextDecoder(sendCodec);
        previousEnd = undefined;
        previousTxEnd = undefined;
      }
      if (event.kind === "gap") {
        decoder = createTextDecoder(receiveCodec);
        txDecoder = createTextDecoder(sendCodec);
        previousEnd = undefined;
        previousTxEnd = undefined;
        const range = event.payload.missingByteRange;
        return {
          itemIndex,
          displayIndex,
          kind: "gap",
          text: `${event.payload.reason}${range ? ` [${range.start}, ${range.end})` : ""}`,
        };
      }
      if (event.kind === "rx") {
        const source = streamSourceKey(event);
        if (
          previousEnd !== event.payload.byteStart ||
          previousSource !== source
        )
          decoder = createTextDecoder(receiveCodec);
        previousEnd = event.payload.byteEnd;
        previousSource = source;
        const bytes = decodeBytes(event.payload.bytesBase64);
        return {
          itemIndex,
          displayIndex,
          kind: "rx",
          text: decoder.decode(bytes, { stream: true }),
          hex: mode === "text" ? undefined : formatHex(bytes),
          offset: event.payload.byteStart,
          byteEnd: event.payload.byteEnd,
          source: JSON.stringify([
            source,
            event.configurationRevision,
            event.time.clockId,
          ]),
          recordId: displayed[itemIndex]?.displayRecord,
        };
      }
      if (event.kind === "tx" || event.kind === "tx_intent") {
        const source = streamSourceKey(event);
        if (
          previousTxEnd !== event.payload.byteStart ||
          previousTxSource !== source
        )
          txDecoder = createTextDecoder(sendCodec);
        previousTxEnd = event.payload.byteEnd;
        previousTxSource = source;
        const bytes = decodeBytes(event.payload.bytesBase64);
        return {
          itemIndex,
          displayIndex,
          kind: "tx",
          text: txDecoder.decode(bytes, { stream: true }),
          hex: mode === "text" ? undefined : formatHex(bytes),
          offset: event.payload.byteStart,
          byteEnd: event.payload.byteEnd,
          receipt: event.kind === "tx" ? event.payload : undefined,
        };
      }
      const text = (() => {
        if (event.kind === "configuration_boundary")
          return event.payload.certainty === "confirmed"
            ? labels.configurationApplied
            : labels.configurationUncertain;
        if (event.kind === "lifecycle") {
          const state = event.payload.state;
          switch (state) {
            case "open":
            case "opening":
            case "closed":
            case "closing":
            case "disconnected":
              return workbenchStatus(state, labels);
            default:
              return `${labels.sessionLabel} · ${labels.unknown}`;
          }
        }
        return labels.controlEvent;
      })();
      return {
        itemIndex,
        displayIndex,
        kind: event.kind,
        text,
      };
    });
    const joined: ((typeof decoded)[number] & { itemIndexes: number[] })[] = [];
    for (const row of decoded) {
      const previous = joined.at(-1);
      // 连续段共享记录边界，单个渲染块仍有界。
      if (
        (mode === "text" || !!row.recordId) &&
        row.kind === "rx" &&
        previous?.kind === "rx" &&
        row.source === previous.source &&
        row.offset === previous.byteEnd &&
        row.recordId === previous.recordId &&
        BigInt(row.byteEnd!) - BigInt(previous.offset!) <= 131072n
      ) {
        previous.text += row.text;
        if (row.hex) previous.hex = `${previous.hex} ${row.hex}`;
        previous.byteEnd = row.byteEnd;
        previous.displayIndex = row.displayIndex;
        previous.itemIndexes.push(row.itemIndex);
      } else joined.push({ ...row, itemIndexes: [row.itemIndex] });
    }
    let recordStart: string | undefined;
    return joined
      .map((row, index) => {
        const continuation =
          !!row.recordId && row.recordId === joined[index - 1]?.recordId;
        const continues =
          !!row.recordId && row.recordId === joined[index + 1]?.recordId;
        if (!continuation) recordStart = row.offset;
        return { ...row, continuation, continues, recordStart };
      })
      .filter((row) => replay || row.kind !== "configuration_boundary");
  }, [projected, displayed, mode, receiveCodec, sendCodec, labels, replay]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const followToEnd = useCallback(() => {
    const element = viewport.current;
    if (!followingActive.current || !element || element.clientHeight === 0)
      return;
    const body = content.current;
    if (body) {
      // scrollHeight 按 CSS 像素取整，不能改按设备像素舍入。
      // 在起始处补齐不足一像素的高度，稳定末行与时间戳的位置。
      const height = body.getBoundingClientRect().height - followInset.current;
      const inset =
        element.scrollHeight > element.clientHeight
          ? Math.max(0, Math.ceil(height) - height)
          : 0;
      if (inset !== followInset.current) {
        followInset.current = inset;
        body.style.paddingBlockStart = `${inset}px`;
      }
    }
    element.scrollTop = element.scrollHeight;
    if (scrollIntent.current) scrollIntent.current.top = element.scrollTop;
  }, []);
  useLayoutEffect(() => {
    followingActive.current = following;
    if (following) followToEnd();
  }, [displayed, following, followToEnd]);
  useEffect(() => {
    if (!following || !viewport.current || !content.current) return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        followToEnd();
      });
    });
    observer.observe(viewport.current);
    observer.observe(content.current);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [following, followToEnd]);
  useEffect(() => {
    if (match) {
      const row = rowRefs.current.get(match.itemIndex);
      row?.scrollIntoView({ block: "nearest" });
    }
  }, [match]);
  const find = useCallback(
    async (direction = 1) => {
      setSearched(true);
      const key = JSON.stringify([
        query,
        queryMode,
        caseSensitive,
        wholeWord,
        regex,
        receiveCodec,
      ]);
      const cached = found.current;
      if (
        cached?.key === key &&
        cached.source === displayed &&
        cached.matches.length
      ) {
        cached.index =
          (cached.index + direction + cached.matches.length) %
          cached.matches.length;
        setMatch(cached.matches[cached.index]!);
        setSearchIndex(cached.index);
        return;
      }
      searching.current?.abort();
      const controller = new AbortController();
      searching.current = controller;
      setFrozen((current) => current ?? displayed);
      setInvalid(false);
      setSearchError(undefined);
      try {
        const result = await requestStreamSearch(
          displayed,
          query,
          queryMode,
          { caseSensitive, wholeWord, regex, encoding: receiveCodec },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const index =
          direction < 0 ? Math.max(0, result.matches.length - 1) : 0;
        found.current = {
          key,
          source: displayed,
          matches: result.matches,
          index,
        };
        setSearchCount(result.matches.length);
        setSearchIndex(index);
        setMatch(result.matches[index] ?? null);
        setInvalid(Boolean(result.error));
        setSearchError(result.error);
      } catch (error) {
        if (!controller.signal.aborted) {
          setInvalid(true);
          setSearchError(
            error instanceof Error && error.message === "SEARCH_TIMEOUT"
              ? "timeout"
              : "syntax",
          );
          setMatch(null);
          setSearchCount(0);
        }
      }
    },
    [
      displayed,
      query,
      queryMode,
      caseSensitive,
      wholeWord,
      regex,
      receiveCodec,
    ],
  );
  const latestFind = useRef(find);
  latestFind.current = find;
  useEffect(() => {
    searching.current?.abort();
    found.current = undefined;
    setMatch(null);
    setSearchCount(0);
    if (!searchOpen || !query) return;
    const timer = setTimeout(() => void latestFind.current(), 120);
    return () => {
      clearTimeout(timer);
      searching.current?.abort();
    };
  }, [
    query,
    queryMode,
    caseSensitive,
    wholeWord,
    regex,
    searchOpen,
    receiveCodec,
  ]);
  useEffect(() => () => searching.current?.abort(), []);
  const totals = useMemo(() => {
    let rx = 0n,
      tx = 0n;
    for (const { item } of projected) {
      if (item.kind !== "source") continue;
      const { event } = item;
      if (event.kind === "rx")
        rx += BigInt(event.payload.byteEnd) - BigInt(event.payload.byteStart);
      if (event.kind === "tx")
        for (const range of event.payload.acceptedRanges)
          tx += BigInt(range.end) - BigInt(range.start);
    }
    return { rx: rx.toString(), tx: tx.toString() };
  }, [projected]);
  // 输入和权限续检不重建接收列表；只有源数据或显示偏好改变才重新呈现。
  const renderedRows = useMemo(
    () =>
      rows.map((row) => (
        <div
          key={row.itemIndex}
          ref={(element) => {
            for (const itemIndex of row.itemIndexes) {
              if (element) rowRefs.current.set(itemIndex, element);
              else rowRefs.current.delete(itemIndex);
            }
          }}
          tabIndex={-1}
          data-offset={row.offset}
          data-direction={row.kind}
          data-outcome={row.kind === "tx" ? row.receipt?.outcome : undefined}
          data-continuation={row.continuation || undefined}
          data-continues={row.continues || undefined}
          className={`workbench-stream-row ${row.kind === "gap" ? "workbench-gap" : ""}`}
          data-theme-snapshot-block=""
        >
          <span className="workbench-offset sr-only">
            {labels.offset} {row.offset ?? "—"}
          </span>
          <span
            className={`workbench-direction ${row.kind === "tx" ? "text-primary" : replay ? "text-muted-foreground" : "text-foreground"}`}
          >
            {replay && presentationLabels
              ? `${presentationLabels.replay} · `
              : ""}
            {row.kind === "rx" && !row.continuation && (
              <Download aria-hidden="true" />
            )}
            {row.kind === "tx" && (
              <TxStreamReceipt
                receipt={row.receipt}
                byteStart={row.offset!}
                byteEnd={row.byteEnd!}
                labels={labels}
              />
            )}
            {row.kind === "rx" || row.kind === "tx" ? (
              <span className="sr-only">
                {row.kind === "rx" ? labels.terminal : labels.send}
              </span>
            ) : row.kind === "gap" ? (
              <>
                <TriangleAlert aria-hidden="true" />
                <span className="sr-only">{labels.gap}</span>
              </>
            ) : (
              <Info aria-hidden="true" />
            )}
          </span>
          {presentationLabels && !row.continues && (
            <div className="workbench-stream-meta">
              <time
                className="workbench-stream-time"
                dateTime={times[row.displayIndex]!.absolute ?? undefined}
              >
                {timeMode === "absolute"
                  ? times[row.displayIndex]!.absolute
                    ? compactStreamTime(times[row.displayIndex]!.absolute!)
                    : presentationLabels.missingTime
                  : (timeMode === "relative"
                        ? times[row.displayIndex]!.relativeNs
                        : times[row.displayIndex]!.intervalNs) === null
                    ? presentationLabels.missingTime
                    : (timeMode === "relative"
                        ? times[row.displayIndex]!.relativeNs
                        : times[row.displayIndex]!.intervalNs) + " ns"}
              </time>
              {(row.kind === "rx" || row.kind === "tx") &&
                row.offset !== undefined &&
                row.byteEnd !== undefined && (
                  <span
                    title={`${BigInt(row.byteEnd) - BigInt(row.recordStart ?? row.offset)} B`}
                  >
                    {row.kind === "rx" ? "↓" : "↑"}{" "}
                    {formatByteSize(
                      (
                        BigInt(row.byteEnd) -
                        BigInt(row.recordStart ?? row.offset)
                      ).toString(),
                    )}
                  </span>
                )}
            </div>
          )}
          <div
            className="workbench-stream-content"
            data-mode={mode}
            style={terminalTypographyStyle(terminalSettings?.typography)}
          >
            {row.kind === "rx" || row.kind === "tx" ? (
              <>
                <span
                  className={mode === "hex" ? "sr-only" : "workbench-payload"}
                >
                  {row.text}
                </span>
                {mode !== "text" && (
                  <span className="workbench-payload">{row.hex}</span>
                )}
              </>
            ) : (
              <span className="workbench-payload">{row.text}</span>
            )}
          </div>
        </div>
      )),
    [
      rows,
      labels,
      replay,
      presentationLabels,
      times,
      timeMode,
      mode,
      terminalSettings,
    ],
  );
  return (
    <section
      aria-label={labels.terminal}
      className="workbench-stream"
      data-panel-id="terminal"
    >
      <div
        className="workbench-toolbar workbench-receive-toolbar"
        data-surface="transparent"
      >
        <h2 className="sr-only">{labels.terminal}</h2>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={mode}
          aria-label={labels.terminal}
          onValueChange={(value) => {
            if (value !== "text" && value !== "hex") return;
            setSplit(false);
            setMode(value);
            onReceiveModeChange?.(value);
          }}
        >
          {(["text", "hex"] as const).map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {labels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <TextEncodingSelect
          value={encoding}
          label={labels.receiveEncoding}
          automatic={labels.encodingAuto}
          automaticValue={
            detection?.reason === "pending"
              ? labels.encodingPending
              : `${labels.encodingAutoShort} · ${ENCODING_NAMES[receiveCodec]}`
          }
          hint={encoding === null ? labels.encodingGuessHelp : undefined}
          onChange={(value) => {
            setEncoding(value);
            onEncodingChange?.(value);
          }}
        />
        <span className="workbench-toolbar-spacer" />
        <WorkbenchIconButton
          ref={searchTrigger}
          label={labels.search}
          aria-expanded={searchOpen}
          aria-controls={`${id}-search`}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={frozen ? labels.resume : labels.freeze}
          aria-pressed={Boolean(frozen)}
          onClick={() => {
            searching.current?.abort();
            found.current = undefined;
            if (frozen) resume();
            else {
              setFrozen([...items]);
              setReviewed(null);
            }
            setMatch(null);
          }}
        >
          {frozen ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </WorkbenchIconButton>
        {onOpenCapture && (
          <WorkbenchIconButton
            label={labels.capture}
            aria-pressed={captureActive}
            onClick={onOpenCapture}
          >
            <Circle aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        {onOpenActivity && (
          <WorkbenchIconButton label={labels.activity} onClick={onOpenActivity}>
            <FileText aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={displayLabels?.displayOptions ?? labels.encodingHelp}
            >
              <Settings2 aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="workbench-display-options">
            <PopoverTitle>
              {displayLabels?.displayOptions ?? labels.encodingHelp}
            </PopoverTitle>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={split}
              onClick={() => setSplit(!split)}
            >
              {labels.split}
            </Button>
            {presentationLabels && (
              <fieldset className="workbench-choice">
                <legend className="sr-only">
                  {presentationLabels.timeMode}
                </legend>
                {(["absolute", "relative", "interval"] as const).map(
                  (value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`${id}-time`}
                        checked={timeMode === value}
                        onChange={() => setTimeMode(value)}
                      />
                      {presentationLabels[`${value}Time`]}
                    </label>
                  ),
                )}
              </fieldset>
            )}
            <p className="text-muted-foreground text-xs">
              {labels.encodingHelp} · {ENCODING_NAMES[receiveCodec]}
            </p>
            {onHistoryLimitsChange && (
              <ReceiveHistoryControls
                value={historyLimits ?? DEFAULT_RECEIVE_HISTORY}
                onChange={onHistoryLimitsChange}
                labels={labels}
              />
            )}
          </PopoverContent>
        </Popover>
        {onClearView && (
          <WorkbenchIconButton
            label={displayLabels?.clearView ?? labels.terminal}
            disabled={!items.length}
            onClick={() => {
              searching.current?.abort();
              found.current = undefined;
              resume();
              setMatch(null);
              onClearView();
            }}
          >
            <Eraser aria-hidden="true" />
          </WorkbenchIconButton>
        )}
      </div>
      {searchOpen && (
        <form
          id={`${id}-search`}
          className="workbench-toolbar workbench-stream-search"
          data-surface="popover"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              setSearchOpen(false);
              searchTrigger.current?.focus();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
        >
          <Input
            ref={searchInput}
            aria-label={labels.search}
            placeholder={labels.search}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatch(null);
              setSearched(false);
            }}
            className="workbench-search"
          />
          <fieldset className="workbench-choice">
            <legend className="sr-only">{labels.searchMode}</legend>
            {(["text", "hex"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${id}-search`}
                  checked={queryMode === value}
                  aria-label={`${labels[value]} ${labels.search}`}
                  onChange={() => {
                    setQueryMode(value);
                    setMatch(null);
                  }}
                />
                {labels[value]}
              </label>
            ))}
          </fieldset>
          <WorkbenchIconButton
            data-search-option
            aria-pressed={caseSensitive}
            label={labels.searchCase}
            disabled={queryMode === "hex"}
            variant={caseSensitive ? "secondary" : "ghost"}
            onClick={() => setCaseSensitive((value) => !value)}
          >
            Aa
          </WorkbenchIconButton>
          <WorkbenchIconButton
            data-search-option
            aria-pressed={wholeWord}
            label={labels.searchWord}
            disabled={queryMode === "hex"}
            variant={wholeWord ? "secondary" : "ghost"}
            onClick={() => setWholeWord((value) => !value)}
          >
            ab
          </WorkbenchIconButton>
          <WorkbenchIconButton
            data-search-option
            aria-pressed={regex}
            label={labels.searchRegex}
            disabled={queryMode === "hex"}
            variant={regex ? "secondary" : "ghost"}
            onClick={() => setRegex((value) => !value)}
          >
            .*
          </WorkbenchIconButton>
          {searched && (
            <span role="status">
              {invalid ? (
                queryMode === "hex" ? (
                  labels.invalidHex
                ) : searchError === "timeout" ? (
                  labels.searchTimeout
                ) : searchError === "encoding" ? (
                  labels.searchEncoding
                ) : searchError === "limit" ? (
                  labels.searchLimit
                ) : (
                  labels.searchInvalid
                )
              ) : match ? (
                <>
                  {searchIndex + 1}/{searchCount}
                  <span className="sr-only">{`${labels.offset} ${match.offset}`}</span>
                </>
              ) : (
                labels.noMatches
              )}
            </span>
          )}
          <WorkbenchIconButton
            label={labels.searchPrevious}
            disabled={!query}
            onClick={() => void find(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </WorkbenchIconButton>
          <WorkbenchIconButton
            label={labels.find}
            disabled={!query}
            onClick={() => void find(1)}
          >
            <ArrowDown aria-hidden="true" />
          </WorkbenchIconButton>
          <WorkbenchIconButton
            label={labels.searchClose}
            onClick={() => {
              setSearchOpen(false);
              searchTrigger.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </WorkbenchIconButton>
        </form>
      )}
      <div className="workbench-receive-frame app-reading-surface">
        <div
          role="log"
          aria-label={labels.terminal}
          aria-live="off"
          tabIndex={0}
          ref={viewport}
          className="workbench-stream-log app-scroll-region"
          data-surface="transparent"
          data-following={following}
          onWheel={(event) => {
            if (event.ctrlKey || event.deltaY === 0) return;
            const element = event.currentTarget;
            // 被动滚轮事件可能在合成线程已经滚到顶后才到达 JS。
            if (
              event.deltaY < 0 &&
              element.scrollHeight > element.clientHeight
            ) {
              scrollIntent.current = {
                top: element.scrollTop,
                direction: "up",
              };
              reviewHistory();
            } else if (event.deltaY > 0) {
              scrollIntent.current = {
                top: element.scrollTop,
                direction: "down",
              };
              if (!frozen && atStreamEnd(element)) setReviewed(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const element = event.currentTarget;
            if (
              ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
              (event.key === " " && event.shiftKey)
            ) {
              if (element.scrollHeight > element.clientHeight) {
                scrollIntent.current = {
                  top: element.scrollTop,
                  direction: "up",
                };
                reviewHistory();
              }
            } else if (
              ["ArrowDown", "PageDown", "End", " "].includes(event.key)
            ) {
              scrollIntent.current = {
                top: element.scrollTop,
                direction: "down",
              };
              if (!frozen && (event.key === "End" || atStreamEnd(element)))
                setReviewed(null);
            }
          }}
          onPointerDown={(event) => {
            scrollIntent.current = {
              top: event.currentTarget.scrollTop,
              direction: "drag",
            };
          }}
          onTouchStart={(event) => {
            touchY.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY;
            if (
              y !== undefined &&
              touchY.current !== null &&
              y !== touchY.current
            ) {
              const element = event.currentTarget;
              const direction = y > touchY.current ? "up" : "down";
              scrollIntent.current = { top: element.scrollTop, direction };
              if (
                direction === "up" &&
                element.scrollHeight > element.clientHeight
              )
                reviewHistory();
              else if (direction === "down" && !frozen && atStreamEnd(element))
                setReviewed(null);
            }
            touchY.current = y ?? null;
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            const upward =
              scrollIntent.current !== null &&
              scrollIntent.current.direction !== "down" &&
              element.scrollTop < scrollIntent.current.top - 0.5;
            const downward =
              scrollIntent.current !== null &&
              scrollIntent.current.direction !== "up" &&
              element.scrollTop > scrollIntent.current.top + 0.5;
            if (scrollIntent.current)
              scrollIntent.current.top = element.scrollTop;
            if (frozen) return;
            // 只让向下到底的用户手势恢复跟随，裁剪或晚排版产生的滚动保留历史状态。
            if (upward) reviewHistory();
            else if (downward && atStreamEnd(element)) setReviewed(null);
          }}
          onScrollEnd={() => {
            if (scrollIntent.current?.direction !== "drag")
              scrollIntent.current = null;
          }}
        >
          <div ref={content}>{renderedRows}</div>
        </div>
        <div className="workbench-stream-totals" aria-live="off">
          <div className="workbench-stream-status">
            {frozen && <span>{labels.displayPaused}</span>}
            {frozen && pendingCount > 0 && (
              <span className="workbench-pending-count">
                {labels.pendingUpdates.replace(
                  "{count}",
                  pendingCount.toLocaleString(),
                )}
              </span>
            )}
            {reviewed && !frozen && (
              <Button
                variant="outline"
                size="sm"
                onClick={resume}
                aria-label={labels.returnToLatest}
                title={labels.returnToLatest}
                className="workbench-follow-latest"
              >
                {pendingCount > 0
                  ? labels.newUpdates.replace(
                      "{count}",
                      pendingCount.toLocaleString(),
                    )
                  : labels.returnToLatest}
                <ArrowDown aria-hidden="true" />
              </Button>
            )}
            {trimmed && (
              <span
                className="workbench-stream-retention"
                role="status"
                title={labels.historyHint}
              >
                {labels.historyTrimmed}
              </span>
            )}
          </div>
          <span role="group" aria-label={labels.displayedTxBytes}>
            <ArrowUp aria-hidden="true" />
            {formatByteSize(totals.tx)}
          </span>
          <span role="group" aria-label={labels.displayedRxBytes}>
            <ArrowDown aria-hidden="true" />
            {formatByteSize(totals.rx)}
          </span>
        </div>
      </div>
      <WorkbenchNotice
        noticeKey={`stream:${error?.message ?? ""}:${labels.streamUnavailable}`}
        log={{
          module: "display",
          level: "error",
          message: labels.streamUnavailable,
          code: nativeErrorCode(error),
        }}
      >
        {error && (
          <div className="workbench-stream-error" role="alert">
            <p>{labels.streamUnavailable}</p>
            <p>{labels.disconnectHelp}</p>
            <NotificationDetails label={labels.errorDetails}>
              {error.message}
            </NotificationDetails>
          </div>
        )}
      </WorkbenchNotice>
    </section>
  );
}

function streamItemIdentity(item: StreamItem): string {
  return item.kind === "source"
    ? JSON.stringify([
        item.event.hostId,
        item.event.instanceEpoch,
        item.event.sessionId,
        item.event.sessionEpoch,
        item.event.eventSeq,
      ])
    : JSON.stringify(item.gap);
}

function TxStreamReceipt({
  receipt,
  byteStart,
  byteEnd,
  labels,
}: {
  receipt?: TxReceipt;
  byteStart: string;
  byteEnd: string;
  labels: WorkbenchLabels;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={labels.receipt}
          className="workbench-direction-button"
        >
          <Upload aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="workbench-detail-popover"
        aria-label={labels.receipt}
      >
        <PopoverTitle>{labels.receipt}</PopoverTitle>
        {receipt ? (
          <>
            <p>{workbenchStatus(receipt.outcome, labels)}</p>
            <TxReceiptFacts receipt={receipt} labels={labels} />
          </>
        ) : (
          <>
            <p>{labels.awaitingReceipt}</p>
            <p>
              {labels.requestedBytes}: [{byteStart}, {byteEnd})
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
