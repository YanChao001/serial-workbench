import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  useContext,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Binary,
  ChartLine,
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
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { DEFAULT_ANSI_SCROLLBACK_LINES } from "@/lib/client-settings";
import { SettingsContext } from "@/providers/settings-context";
import { NotificationDetails } from "@/components/notification-content";
import { TextEncodingSelect } from "./text-encoding-select";
import type { AnsiKeyboardTarget } from "./ansi-keyboard";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  receivePacketTiming,
  terminalTypographyStyle,
  compactStreamTime,
  workbenchStatus,
  type StreamPresentationLabels,
} from "./stream-presentation";
import {
  defaultHexFormat,
  formatStreamHex,
  hexByteCount,
  HEX_COLUMNS,
  HEX_GROUPS,
  type HexFormat,
} from "./stream-hex";
import {
  readStreamHexSelection,
  restoreStreamHexSelection,
  type StreamHexSelection,
} from "./stream-hex-selection";
import { StreamCopyPopover } from "./stream-copy-popover";
import {
  StreamContextMenu,
  type StreamContextPoint,
  type StreamContextSend,
} from "./stream-context-menu";
import {
  chartSelectionRows,
  retainedChartSelection,
  sourceSelectionFromDisplay,
  streamHexEventSource,
  type ChartSourceSelection,
} from "./stream-chart-selection";
import {
  collectLongStreamRecords,
  visibleLongRecordPages,
} from "./stream-long-record";
import { LongStreamRecordView } from "./stream-long-record-view";
import { readStreamCopySample } from "./stream-copy";
import { StreamNumberInspector } from "./stream-number-inspector";
import { streamNumberSample, type StreamNumberSample } from "./stream-number";
import { TxReceiptFacts } from "./tx-receipt-facts";
import { formatByteSize } from "./metric-format";
import { requestStreamSearch } from "./stream-search-client";
import type { StreamHighlightRule } from "./stream-highlight";
import { StreamHighlightEditor } from "./stream-highlight-editor";
import { renderStreamHighlights } from "./stream-highlight-text";
import { useStreamHighlights } from "./use-stream-highlights";
import {
  filterStreamRows,
  streamMatchRanges,
  type MatchVisibility,
  type SearchDirection,
} from "./stream-filter";
import { StreamFilterControls } from "./stream-filter-controls";
import {
  StreamLocationPopover,
  StreamRecordNumbers,
} from "./stream-location-controls";
import {
  findStreamLocation,
  numberStreamRows,
  streamEventBookmark,
  type StreamBookmark,
  type StreamLocationKind,
} from "./stream-location";
import { ReceiveHistoryControls } from "./receive-history-controls";
import {
  DEFAULT_RECEIVE_HISTORY,
  RECEIVE_IDLE_MS,
  ReceiveHistoryBuffer,
  type ReceiveHistory,
  type ReceiveIdleMs,
  type HistoryStreamItem,
} from "@/lib/receive-history";

function atStreamEnd(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
}

const AnsiScreen = lazy(() => import("./ansi-screen"));

export type StreamViewProps = {
  keyboard?: AnsiKeyboardTarget;
  historyLimits?: Readonly<ReceiveHistory>;
  onHistoryLimitsChange?: (value: ReceiveHistory) => void;
  receiveIdleMs?: ReceiveIdleMs;
  onReceiveIdleMsChange?: (value: ReceiveIdleMs) => void;
  highlightRules?: readonly StreamHighlightRule[];
  onHighlightRulesChange?: (rules: StreamHighlightRule[]) => void;
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
  onOpenCapture?: (trigger: HTMLButtonElement) => void;
  onOpenActivity?: () => void;
  onClearView?: () => void;
  captureActive?: boolean;
  chartReveal?: ChartSourceSelection;
  chartSourceItems?: readonly StreamItem[];
  contextSender?: StreamContextSend;
  bookmarks?: readonly StreamBookmark[];
  onBookmarksChange?: (value: readonly StreamBookmark[]) => void;
  onChartSelection?: (
    selection: ChartSourceSelection,
    trigger: HTMLButtonElement,
  ) => void;
  displayLabels?: {
    displayOptions: string;
    clearView: string;
  };
};
export function StreamView({
  keyboard,
  historyLimits,
  onHistoryLimitsChange,
  receiveIdleMs,
  onReceiveIdleMsChange,
  highlightRules: sharedHighlightRules,
  onHighlightRulesChange,
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
  chartReveal,
  chartSourceItems,
  contextSender,
  bookmarks,
  onBookmarksChange,
  onChartSelection,
  displayLabels,
}: StreamViewProps) {
  const id = useId();
  const settings = useContext(SettingsContext);
  const [localEncoding, setEncoding] = useState<TextEncoding | null>();
  const [encodingMenuOpen, setEncodingMenuOpen] = useState(false);
  const encoding = receiveEncodingFor(
    controlledEncoding,
    localEncoding,
    terminalSettings?.receiveEncoding,
  );
  const [localMode, setMode] = useState<TerminalMode | null>(null);
  const [showRecordNumbers, setShowRecordNumbers] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [viewBookmarks, setViewBookmarks] = useState<readonly StreamBookmark[]>(
    [],
  );
  const [contextCopyFeedback, setContextCopyFeedback] = useState<string>();
  const currentBookmarks = bookmarks ?? viewBookmarks;
  const changeBookmarks = onBookmarksChange ?? setViewBookmarks;
  const [locationTarget, setLocationTarget] = useState<{
    source: readonly StreamItem[];
    itemIndex: number;
  }>();
  const [split, setSplit] = useState(false);
  const [showAnsi, setShowAnsi] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayTrigger = useRef<HTMLButtonElement>(null);
  const openingHighlights = useRef(false);
  const [highlightEditorOpen, setHighlightEditorOpen] = useState(false);
  const [localHighlightRules, setLocalHighlightRules] = useState<
    StreamHighlightRule[]
  >([]);
  const highlightRules = sharedHighlightRules ?? localHighlightRules;
  const setHighlightRules = onHighlightRulesChange ?? setLocalHighlightRules;
  const [longTexts, setLongTexts] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const trackLongText = useCallback((key: string, text?: string) => {
    setLongTexts((previous) => {
      if (previous.get(key) === text) return previous;
      const next = new Map(previous);
      if (text === undefined) next.delete(key);
      else next.set(key, text);
      return next;
    });
  }, []);
  const [ansiConvertEol, setAnsiConvertEol] = useState(true);
  const [wrapReceiveText, setWrapReceiveText] = useState(true);
  const [showTransmitEcho, setShowTransmitEcho] = useState(true);
  const [hexFormat, setHexFormat] = useState(defaultHexFormat);
  const pendingNumberSelection = useRef<StreamHexSelection | undefined>(
    undefined,
  );
  const pendingChartSelection = useRef<ChartSourceSelection | undefined>(
    undefined,
  );
  const [chartRevealResult, setChartRevealResult] = useState<{
    request: ChartSourceSelection;
    snapshot?: readonly HistoryStreamItem[];
    first?: number;
    last?: number;
    ownsFreeze?: boolean;
    previousFreeze?: readonly HistoryStreamItem[];
    unavailable?: boolean;
  }>();
  const [numberSample, setNumberSample] = useState<StreamNumberSample>();
  const previousHexSelection = useRef<StreamHexSelection | undefined>(
    undefined,
  );
  const changedHexFormat = useRef(false);
  function updateHexFormat(patch: Partial<HexFormat>) {
    changedHexFormat.current = true;
    setHexFormat((current) => {
      const next = { ...current, ...patch };
      if ((next.offsets || next.ascii) && next.columns === "0")
        next.columns = "16";
      return next;
    });
  }
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
  const [searchDirection, setSearchDirection] =
    useState<SearchDirection>("all");
  const [matchVisibility, setMatchVisibility] =
    useState<MatchVisibility>("all");
  const [searchRows, setSearchRows] = useState<{
    key: string;
    source: readonly StreamItem[];
    ranges?: ReturnType<typeof streamMatchRanges>;
    partial?: true;
  }>();
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
  const chartHexFallback = useRef<HTMLElement>(null);
  const chartCursor = useRef<
    | { anchor: Node | null; focus: Node | null; start: number; end: number }
    | undefined
  >(undefined);
  const content = useRef<HTMLDivElement>(null);
  const followInset = useRef(0);
  const scrollIntent = useRef<{
    top: number;
    direction: "up" | "down" | "drag";
  } | null>(null);
  const touchY = useRef<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const displayed = frozen ?? items;
  const visibleChartSelection =
    chartRevealResult?.request === chartReveal &&
    chartRevealResult?.snapshot === frozen
      ? chartReveal
      : undefined;
  function readChartSelection(): ChartSourceSelection | undefined {
    const sources = chartSourceItems ?? items;
    const shown = readStreamHexSelection(viewport.current, hexFormat);
    if (shown) {
      const range = sourceSelectionFromDisplay(displayed, sources, shown);
      const retained = range && retainedChartSelection(sources, range);
      if (range && retained) return { range, hex: retained.hex };
      return;
    }
    const text = chartHexFallback.current?.firstChild;
    const selected = viewport.current?.ownerDocument.getSelection();
    if (
      !visibleChartSelection ||
      !text ||
      selected?.anchorNode !== text ||
      selected.focusNode !== text
    )
      return;
    if (
      Math.abs(selected.anchorOffset - selected.focusOffset) ===
      text.textContent?.length
    )
      return visibleChartSelection;
  }
  useEffect(() => {
    if (!chartReveal) {
      if (!chartRevealResult) return;
      const previous = chartRevealResult.snapshot;
      if (previous) {
        const selected = viewport.current?.ownerDocument.getSelection();
        const cursor = chartCursor.current;
        if (
          selected &&
          cursor &&
          selected.anchorNode === cursor.anchor &&
          selected.focusNode === cursor.focus &&
          selected.anchorOffset === cursor.start &&
          selected.focusOffset === cursor.end
        )
          selected.removeAllRanges();
        chartCursor.current = undefined;
        if (chartRevealResult.ownsFreeze)
          setFrozen((current) =>
            current === previous
              ? (chartRevealResult.previousFreeze ?? null)
              : current,
          );
        setLocationTarget((target) =>
          target?.source === previous &&
          target.itemIndex === chartRevealResult.first
            ? undefined
            : target,
        );
      }
      setChartRevealResult(undefined);
      return;
    }
    if (chartRevealResult?.request === chartReveal) return;
    const sources = chartSourceItems ?? items;
    const retained = retainedChartSelection(sources, chartReveal.range);
    const originalView =
      frozen && chartSelectionRows(sources, frozen, chartReveal.range);
    const snapshot = originalView ? frozen! : items;
    const bounds =
      originalView || chartSelectionRows(sources, items, chartReveal.range);
    if (!retained || retained.hex !== chartReveal.hex || !bounds) {
      setChartRevealResult({ request: chartReveal, unavailable: true });
      return;
    }
    setChartRevealResult({
      request: chartReveal,
      snapshot,
      ...bounds,
      ownsFreeze: snapshot !== frozen,
      previousFreeze: snapshot !== frozen ? (frozen ?? undefined) : undefined,
    });
    setFrozen(snapshot);
    setSearchOpen(false);
    setShowAnsi(false);
    setSplit(false);
    setMode("hex");
    onReceiveModeChange?.("hex");
    setLocationTarget({ source: snapshot, itemIndex: bounds.first });
  }, [
    chartReveal,
    chartRevealResult,
    chartSourceItems,
    frozen,
    items,
    onReceiveModeChange,
  ]);
  useEffect(() => {
    const previous = chartRevealResult?.snapshot;
    if (
      previous &&
      previous !== frozen &&
      chartRevealResult.request === chartReveal
    ) {
      setLocationTarget((target) =>
        target?.source === previous &&
        target.itemIndex === chartRevealResult.first
          ? undefined
          : target,
      );
      setChartRevealResult({ request: chartRevealResult.request });
    }
  }, [chartReveal, chartRevealResult, frozen]);
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
    searching.current?.abort();
    found.current = undefined;
    setSearchRows(undefined);
    setMatch(null);
    setSearched(false);
    setMatchVisibility("all");
    setLocationTarget(undefined);
    setFrozen(null);
    setReviewed(null);
  };
  const projected = useMemo(() => projectStreamItems(displayed), [displayed]);
  const detectEncoding = encoding === null || encodingMenuOpen;
  const encodingSample = useMemo(
    () => (detectEncoding ? receiveEncodingSample(displayed) : ""),
    [detectEncoding, displayed],
  );
  const detection = useMemo(
    () => (detectEncoding ? detectTextEncoding(encodingSample) : undefined),
    [detectEncoding, encodingSample],
  );
  const receiveCodec = encoding ?? detection?.encoding ?? "utf-8";
  const sendCodec = sendEncoding ?? terminalSettings?.sendEncoding ?? "utf-8";
  const searchKey = JSON.stringify([
    query,
    queryMode,
    caseSensitive,
    wholeWord,
    regex,
    receiveCodec,
    sendCodec,
    searchDirection,
  ]);
  const currentSearch =
    searchRows?.key === searchKey && searchRows.source === displayed
      ? searchRows
      : undefined;
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
  const longRecords = useMemo(
    () => collectLongStreamRecords(projected, displayed),
    [projected, displayed],
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
        const longRecord = longRecords.get(itemIndex);
        const text = decoder.decode(bytes, { stream: true });
        return {
          itemIndex,
          displayIndex,
          kind: "rx",
          longRecord,
          text: longRecord ? "" : text,
          hex: longRecord || mode === "text" ? undefined : formatHex(bytes),
          hexSource: streamHexEventSource(event),
          hexLane:
            mode === "text"
              ? undefined
              : JSON.stringify([
                  source,
                  event.kind,
                  event.configurationRevision,
                ]),
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
        const longRecord = longRecords.get(itemIndex);
        const text = txDecoder.decode(bytes, { stream: true });
        return {
          itemIndex,
          displayIndex,
          kind: "tx",
          longRecord,
          text: longRecord ? "" : text,
          hex: longRecord || mode === "text" ? undefined : formatHex(bytes),
          hexSource: JSON.stringify([source, event.eventSeq]),
          hexLane:
            mode === "text"
              ? undefined
              : JSON.stringify([
                  source,
                  event.kind,
                  event.configurationRevision,
                ]),
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
      const sameLongRecord =
        row.longRecord && row.longRecord === previous?.longRecord;
      const joinInline =
        !row.longRecord &&
        !previous?.longRecord &&
        (mode === "text" || !!row.recordId) &&
        row.kind === "rx" &&
        previous?.kind === "rx" &&
        row.source === previous.source &&
        row.offset === previous.byteEnd &&
        row.recordId === previous.recordId &&
        BigInt(row.byteEnd!) - BigInt(previous.offset!) <= 131072n;
      if (previous && (sameLongRecord || joinInline)) {
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
  }, [
    projected,
    displayed,
    mode,
    receiveCodec,
    sendCodec,
    labels,
    replay,
    longRecords,
  ]);
  useEffect(() => {
    if (
      !visibleChartSelection ||
      !chartRevealResult ||
      mode !== "hex" ||
      showAnsi
    )
      return;
    const first = rows.find(
      (row) =>
        chartRevealResult.first !== undefined &&
        row.itemIndexes.includes(chartRevealResult.first),
    );
    const last = rows.find(
      (row) =>
        chartRevealResult.last !== undefined &&
        row.itemIndexes.includes(chartRevealResult.last),
    );
    const animation = requestAnimationFrame(() => {
      const { range } = visibleChartSelection;
      const root = viewport.current;
      const selected = root?.ownerDocument.getSelection();
      if (!selected) return;
      const restored =
        first?.hexSource &&
        first === last &&
        restoreStreamHexSelection(
          root,
          {
            ...range,
            start: { ...range.start, source: first.hexSource },
            end: { ...range.end, source: first.hexSource },
          },
          hexFormat,
        );
      if (!restored) {
        const text = chartHexFallback.current?.firstChild;
        if (!text) return;
        selected.setBaseAndExtent(text, 0, text, text.textContent?.length ?? 0);
      }
      chartCursor.current = {
        anchor: selected.anchorNode,
        focus: selected.focusNode,
        start: selected.anchorOffset,
        end: selected.focusOffset,
      };
    });
    return () => cancelAnimationFrame(animation);
  }, [
    visibleChartSelection,
    chartRevealResult,
    rows,
    mode,
    showAnsi,
    hexFormat,
  ]);
  const locations = useMemo(
    () =>
      showRecordNumbers || locationOpen
        ? numberStreamRows(rows, projected, displayed)
        : undefined,
    [showRecordNumbers, locationOpen, rows, projected, displayed],
  );
  const locatedItem =
    locationTarget?.source === displayed ? locationTarget.itemIndex : undefined;
  function locateRecord(
    kind: StreamLocationKind,
    input: string,
  ): ReturnType<typeof findStreamLocation> {
    const result = findStreamLocation(
      locations ?? numberStreamRows(rows, projected, displayed),
      kind,
      input,
    );
    if (result.kind === "found") {
      // Clear the display filter so a retained target can be reached.
      setSearchOpen(false);
      setFrozen((current) => current ?? displayed);
      setLocationTarget({ source: displayed, itemIndex: result.row.itemIndex });
    }
    return result;
  }
  const copyLocation = useCallback(
    (reference: string) => {
      void copyText(reference).then(
        () => toast.success(labels.copyDone),
        () => toast.error(labels.copyFailed),
      );
    },
    [labels.copyDone, labels.copyFailed],
  );
  useLayoutEffect(() => {
    if (locatedItem === undefined || showAnsi) return;
    let frame: number;
    let attempts = 0;
    let previouslyVisible = false;
    const center = () => {
      const row = rowRefs.current.get(locatedItem);
      const log = viewport.current;
      if (!row || !log) return;
      const bounds = row.getBoundingClientRect();
      const viewportBounds = log.getBoundingClientRect();
      const visible =
        bounds.top < viewportBounds.bottom &&
        bounds.bottom > viewportBounds.top;
      if (!attempts || !visible) row.scrollIntoView({ block: "center" });
      else if (previouslyVisible) return;
      previouslyVisible = visible && attempts > 0;
      // Reinserted rows using content-visibility can change the height above the target after painting.
      if (++attempts < 8) frame = requestAnimationFrame(center);
    };
    frame = requestAnimationFrame(center);
    return () => cancelAnimationFrame(frame);
  }, [locatedItem, locationTarget, searchOpen, showAnsi]);
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
    if (following && !showAnsi) followToEnd();
  }, [displayed, following, followToEnd, showAnsi]);
  useEffect(() => {
    if (showAnsi || !following || !viewport.current || !content.current) return;
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
  }, [following, followToEnd, showAnsi]);
  useEffect(() => {
    if (match) {
      const row = rowRefs.current.get(match.itemIndex);
      row?.scrollIntoView({ block: "nearest" });
    }
  }, [match]);
  const find = useCallback(
    async (direction = 1) => {
      setSearched(true);
      const key = searchKey;
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
      setSearchRows(undefined);
      try {
        const result = await requestStreamSearch(
          displayed,
          query,
          queryMode,
          {
            caseSensitive,
            wholeWord,
            regex,
            encoding: receiveCodec,
            transmitEncoding: sendCodec,
            direction: searchDirection,
          },
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
        setSearchRows({
          key,
          source: displayed,
          ranges:
            result.error || result.partial
              ? undefined
              : streamMatchRanges(result.matches),
          partial: result.partial,
        });
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
      sendCodec,
      searchDirection,
      searchKey,
    ],
  );
  const latestFind = useRef(find);
  latestFind.current = find;
  useEffect(() => {
    searching.current?.abort();
    found.current = undefined;
    setMatch(null);
    setSearchCount(0);
    setSearchRows(undefined);
    setSearched(false);
    if (!searchOpen || !query) return;
    const timer = setTimeout(() => void latestFind.current(), 120);
    return () => {
      clearTimeout(timer);
      searching.current?.abort();
    };
  }, [searchKey, searchOpen, query]);
  useEffect(() => () => searching.current?.abort(), []);
  const visibleRows = useMemo(
    () =>
      searchOpen
        ? filterStreamRows(
            rows,
            searchDirection,
            matchVisibility,
            currentSearch?.ranges,
          )
        : rows,
    [rows, searchOpen, searchDirection, matchVisibility, currentSearch?.ranges],
  );
  const highlightEnabled =
    !showAnsi &&
    mode !== "hex" &&
    highlightRules.some((rule) => rule.enabled && rule.pattern);
  const highlightTexts = useMemo(
    () =>
      highlightEnabled
        ? [
            ...longTexts.values(),
            ...[...visibleRows]
              .reverse()
              .flatMap((row) =>
                !row.longRecord &&
                (row.kind === "rx" || (row.kind === "tx" && showTransmitEcho))
                  ? [row.text]
                  : [],
              ),
          ]
        : [],
    [highlightEnabled, longTexts, visibleRows, showTransmitEcho],
  );
  const highlights = useStreamHighlights(
    highlightRules,
    highlightTexts,
    highlightEnabled,
  );
  const highlightText = useCallback(
    (text: string) =>
      renderStreamHighlights(
        text,
        highlights?.ranges.get(text),
        highlightRules,
      ),
    [highlightRules, highlights],
  );
  const highlightNotice =
    highlights?.failed === "timeout"
      ? labels.highlightTimeout
      : highlights?.failed
        ? labels.highlightFailed
        : highlights?.limited
          ? labels.highlightLimit
          : undefined;

  const totals = useMemo(() => {
    let rx = 0n,
      tx = 0n;
    const visible =
      visibleRows === rows
        ? undefined
        : new Set(visibleRows.flatMap((row) => row.itemIndexes));
    for (const { item, itemIndex } of projected) {
      if (item.kind !== "source" || (visible && !visible.has(itemIndex)))
        continue;
      const { event } = item;
      if (event.kind === "rx")
        rx += BigInt(event.payload.byteEnd) - BigInt(event.payload.byteStart);
      if (event.kind === "tx")
        for (const range of event.payload.acceptedRanges)
          tx += BigInt(range.end) - BigInt(range.start);
    }
    return { rx: rx.toString(), tx: tx.toString() };
  }, [projected, rows, visibleRows]);
  function readContextSample(selection: StreamHexSelection) {
    if (error) return;
    return readStreamCopySample(
      visibleLongRecordPages(visibleRows, viewport.current),
      projected,
      selection,
    );
  }

  function readContext(target: EventTarget | null): StreamContextPoint {
    const root = viewport.current;
    if (!root || root.hidden || !(target instanceof Element)) return {};
    const clicked = target.closest<HTMLElement>("[data-stream-context-item]");
    const selected = root.ownerDocument.getSelection();
    const range =
      selected?.rangeCount && !selected.isCollapsed
        ? selected.getRangeAt(0)
        : undefined;
    const selectionInView =
      range &&
      root.contains(range.startContainer) &&
      root.contains(range.endContainer) &&
      (!clicked || range.intersectsNode(clicked));
    const hex = selectionInView
      ? readStreamHexSelection(root, hexFormat)
      : undefined;
    const sample = hex ? readContextSample(hex) : undefined;
    const rangeRow = selectionInView
      ? range.startContainer.parentElement?.closest<HTMLElement>(
          "[data-stream-context-item]",
        )
      : undefined;
    const position = (rangeRow ?? clicked)?.dataset.streamContextItem;
    const row =
      position === undefined
        ? undefined
        : visibleRows.find((row) => row.itemIndex === Number(position));
    const item =
      row &&
      projected.find(
        ({ item, itemIndex }) =>
          item.kind === "source" && row.itemIndexes.includes(itemIndex),
      )?.item;
    return {
      anchor:
        item?.kind === "source" ? streamEventBookmark(item.event) : undefined,
      bytes: hex && sample ? { range: hex, sample } : undefined,
      text: selectionInView && !error ? selected?.toString() : undefined,
    };
  }

  function bookmark(anchor: StreamBookmark) {
    const current = findStreamLocation(
      locations ?? numberStreamRows(rows, projected, displayed),
      "reference",
      anchor.reference,
    );
    if (current.kind !== "found") {
      toast.info(labels.locationUnavailable);
      return;
    }
    if (
      !currentBookmarks.some(({ reference }) => reference === anchor.reference)
    )
      changeBookmarks([...currentBookmarks.slice(-31), anchor]);
    toast.success(labels.contextBookmarked);
  }

  function splitAt(anchor: StreamBookmark) {
    if (locateRecord("reference", anchor.reference).kind !== "found") {
      toast.info(labels.locationUnavailable);
      return;
    }
    setShowAnsi(false);
    setSplit(true);
  }

  // 输入和权限续检不重建接收列表；只有源数据或显示偏好改变才重新呈现。
  const renderedRows = useMemo(
    () =>
      visibleRows.map((row) => (
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
          data-stream-context-item={row.itemIndex}
          data-location-target={
            (locatedItem !== undefined &&
              row.itemIndexes.includes(locatedItem)) ||
            undefined
          }
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
                {row.kind === "rx" ? labels.terminal : labels.transmitSource}
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
                title={receivePacketTiming(
                  displayed[projected[row.displayIndex]!.itemIndex]!,
                  labels,
                )}
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
          {showRecordNumbers && (
            <StreamRecordNumbers
              row={locations?.get(row.itemIndex)}
              labels={labels}
              onCopy={copyLocation}
            />
          )}
          <div
            className="workbench-stream-content"
            data-mode={mode}
            style={terminalTypographyStyle(terminalSettings?.typography)}
            hidden={row.kind === "tx" && !showTransmitEcho}
          >
            {row.longRecord ? (
              <LongStreamRecordView
                key={row.longRecord.key}
                record={row.longRecord}
                labels={labels}
                mode={mode}
                encoding={row.kind === "tx" ? sendCodec : receiveCodec}
                hexFormat={hexFormat}
                hexSource={row.hexSource}
                highlight={
                  highlightEnabled
                    ? { track: trackLongText, render: highlightText }
                    : undefined
                }
                receipt={row.kind === "tx" ? row.receipt : undefined}
              />
            ) : row.kind === "rx" || row.kind === "tx" ? (
              <>
                <span
                  className={mode === "hex" ? "sr-only" : "workbench-payload"}
                  data-unwrapped={
                    mode !== "hex" && row.kind === "rx" && !wrapReceiveText
                      ? true
                      : undefined
                  }
                  tabIndex={
                    mode !== "hex" && row.kind === "rx" && !wrapReceiveText
                      ? 0
                      : undefined
                  }
                >
                  {mode === "hex" ? row.text : highlightText(row.text)}
                </span>
                {mode !== "text" && (
                  <span
                    className="workbench-payload"
                    dir="ltr"
                    data-hex-source={row.hexSource}
                    data-hex-byte-start={row.offset}
                    data-hex-byte-count={hexByteCount(row.hex ?? "")}
                    data-hex-grouped={hexFormat.columns !== "0" || undefined}
                    tabIndex={hexFormat.columns !== "0" ? 0 : undefined}
                  >
                    {formatStreamHex(row.hex ?? "", row.offset!, hexFormat)}
                  </span>
                )}
              </>
            ) : (
              <span className="workbench-payload">{row.text}</span>
            )}
          </div>
        </div>
      )),
    [
      visibleRows,
      showRecordNumbers,
      locations,
      locatedItem,
      copyLocation,
      labels,
      replay,
      presentationLabels,
      times,
      displayed,
      projected,
      timeMode,
      mode,
      terminalSettings,
      wrapReceiveText,
      showTransmitEcho,
      hexFormat,
      receiveCodec,
      sendCodec,
      highlightEnabled,
      highlightText,
      trackLongText,
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
          value={showAnsi ? "" : mode}
          aria-label={labels.terminal}
          onValueChange={(value) => {
            if (value !== "text" && value !== "hex") return;
            setShowAnsi(false);
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
          evidence={detection && { detection, labels }}
          onOpenChange={setEncodingMenuOpen}
          onChange={(value) => {
            setEncoding(value);
            onEncodingChange?.(value);
          }}
        />
        <span className="workbench-toolbar-spacer" />
        <StreamLocationPopover
          labels={labels}
          showNumbers={showRecordNumbers}
          onShowNumbers={setShowRecordNumbers}
          onOpenChange={(open) => {
            setLocationOpen(open);
            if (open) setShowAnsi(false);
          }}
          onLocate={locateRecord}
          onCopy={copyLocation}
          bookmarks={currentBookmarks}
          onRemoveBookmark={(reference) =>
            changeBookmarks(
              currentBookmarks.filter(
                (bookmark) => bookmark.reference !== reference,
              ),
            )
          }
        />
        <WorkbenchIconButton
          ref={searchTrigger}
          label={labels.search}
          aria-expanded={searchOpen}
          aria-controls={`${id}-search`}
          onClick={() => {
            setShowAnsi(false);
            setSearchOpen(!searchOpen);
          }}
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
            onClick={(event) => onOpenCapture(event.currentTarget)}
          >
            <Circle aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        {onOpenActivity && (
          <WorkbenchIconButton label={labels.activity} onClick={onOpenActivity}>
            <FileText aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        {!showAnsi && mode !== "text" && (
          <StreamCopyPopover
            readSelection={() =>
              readStreamHexSelection(viewport.current, hexFormat)
            }
            readSample={(selection) =>
              readStreamCopySample(
                visibleLongRecordPages(visibleRows, viewport.current),
                projected,
                selection,
              )
            }
            receiveEncoding={receiveCodec}
            sendEncoding={sendCodec}
            labels={labels}
          />
        )}
        {!showAnsi && mode !== "text" && onChartSelection ? (
          <WorkbenchIconButton
            label={labels.chartReceiveSelection}
            onPointerDownCapture={() => {
              pendingChartSelection.current = readChartSelection();
            }}
            onPointerCancel={() => {
              pendingChartSelection.current = undefined;
            }}
            onClick={(event) => {
              const selection =
                readChartSelection() ?? pendingChartSelection.current;
              pendingChartSelection.current = undefined;
              const sources = chartSourceItems ?? items;
              const retained =
                selection && retainedChartSelection(sources, selection.range);
              if (selection && retained?.hex === selection.hex)
                onChartSelection(selection, event.currentTarget);
              else
                toast.info(
                  selection
                    ? labels.chartReceiveUnavailable
                    : labels.chartReceiveSelectionHint,
                );
            }}
          >
            <ChartLine aria-hidden="true" />
          </WorkbenchIconButton>
        ) : null}
        {!showAnsi && mode !== "text" && (
          <Popover
            onOpenChange={(open) => {
              if (!open) {
                setNumberSample(undefined);
                return;
              }
              const selected =
                readStreamHexSelection(viewport.current, hexFormat) ??
                pendingNumberSelection.current;
              pendingNumberSelection.current = undefined;
              setNumberSample(
                selected
                  ? streamNumberSample(
                      visibleLongRecordPages(visibleRows, viewport.current),
                      selected,
                    )
                  : undefined,
              );
            }}
          >
            <PopoverTrigger asChild>
              <WorkbenchIconButton
                label={labels.inspectNumber}
                onPointerDownCapture={() => {
                  pendingNumberSelection.current = readStreamHexSelection(
                    viewport.current,
                    hexFormat,
                  );
                }}
              >
                <Binary aria-hidden="true" />
              </WorkbenchIconButton>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="workbench-display-options w-80"
              aria-label={labels.inspectNumber}
            >
              <PopoverTitle>{labels.inspectNumber}</PopoverTitle>
              {numberSample ? (
                <StreamNumberInspector sample={numberSample} labels={labels} />
              ) : (
                <p className="text-muted-foreground text-xs">
                  {labels.numberSelection}
                </p>
              )}
            </PopoverContent>
          </Popover>
        )}
        <Popover
          open={displayOpen}
          onOpenChange={(open) => {
            setDisplayOpen(open);
            if (!open) return;
            changedHexFormat.current = false;
            previousHexSelection.current =
              readStreamHexSelection(viewport.current, hexFormat) ??
              previousHexSelection.current;
          }}
        >
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              ref={displayTrigger}
              label={displayLabels?.displayOptions ?? labels.encodingHelp}
              onPointerDownCapture={() => {
                previousHexSelection.current = readStreamHexSelection(
                  viewport.current,
                  hexFormat,
                );
              }}
            >
              <Settings2 aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="workbench-display-options"
            aria-label={displayLabels?.displayOptions ?? labels.encodingHelp}
            onCloseAutoFocus={(event) => {
              if (openingHighlights.current) {
                event.preventDefault();
                openingHighlights.current = false;
              }
              const saved = previousHexSelection.current;
              previousHexSelection.current = undefined;
              if (saved && changedHexFormat.current)
                queueMicrotask(() =>
                  restoreStreamHexSelection(viewport.current, saved, hexFormat),
                );
            }}
          >
            <PopoverTitle>
              {displayLabels?.displayOptions ?? labels.encodingHelp}
            </PopoverTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                openingHighlights.current = true;
                setDisplayOpen(false);
                setHighlightEditorOpen(true);
              }}
            >
              {labels.highlightRules}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={!showAnsi && split}
              onClick={() => {
                setShowAnsi(false);
                setSplit(showAnsi || !split);
              }}
            >
              {labels.split}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={showAnsi}
              onClick={() => {
                setShowAnsi(!showAnsi);
                if (!showAnsi) {
                  setSearchOpen(false);
                  searching.current?.abort();
                  setMatch(null);
                }
              }}
            >
              {labels.ansiScreen}
            </Button>
            {receiveIdleMs !== undefined && onReceiveIdleMsChange && (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <label htmlFor={id + "-receive-idle"}>
                    {labels.receiveIdleGap}
                  </label>
                  <Select
                    value={String(receiveIdleMs)}
                    onValueChange={(value) => {
                      const threshold = RECEIVE_IDLE_MS.find(
                        (option) => String(option) === value,
                      );
                      if (threshold !== undefined)
                        onReceiveIdleMsChange(threshold);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      id={id + "-receive-idle"}
                      aria-describedby={id + "-receive-idle-help"}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RECEIVE_IDLE_MS.map((threshold) => (
                        <SelectItem key={threshold} value={String(threshold)}>
                          {threshold} ms
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p
                  id={id + "-receive-idle-help"}
                  className="text-xs text-muted-foreground"
                >
                  {labels.receiveIdleHelp}
                </p>
              </div>
            )}
            {showAnsi && (
              <label className="flex items-center justify-between gap-3 text-sm">
                {labels.ansiConvertLf}
                <Switch
                  checked={ansiConvertEol}
                  onCheckedChange={setAnsiConvertEol}
                />
              </label>
            )}
            <label className="flex items-center justify-between gap-3 text-sm">
              {labels.wrapReceiveText}
              <Switch
                checked={wrapReceiveText}
                onCheckedChange={setWrapReceiveText}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              {labels.showTransmitEcho}
              <Switch
                checked={showTransmitEcho}
                onCheckedChange={setShowTransmitEcho}
              />
            </label>
            <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {labels.hexColumns}
              <Select
                value={hexFormat.columns}
                onValueChange={(value) => {
                  const columns = HEX_COLUMNS.find(
                    (option) => option === value,
                  );
                  if (columns) updateHexFormat({ columns });
                }}
              >
                <SelectTrigger size="sm" aria-label={labels.hexColumns}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HEX_COLUMNS.map((columns) => (
                    <SelectItem
                      key={columns}
                      value={columns}
                      disabled={
                        columns === "0" &&
                        (hexFormat.offsets || hexFormat.ascii)
                      }
                    >
                      {columns === "0" ? labels.automaticColumns : columns}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {mode !== "text" && (
              <>
                <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  {labels.hexGroup}
                  <Select
                    value={hexFormat.group}
                    onValueChange={(value) => {
                      const group = HEX_GROUPS.find(
                        (option) => option === value,
                      );
                      if (group) updateHexFormat({ group });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={labels.hexGroup}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HEX_GROUPS.map((group) => (
                        <SelectItem key={group} value={group}>
                          {group}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  {labels.hexLowerCase}
                  <Switch
                    checked={hexFormat.lowerCase}
                    onCheckedChange={(lowerCase) =>
                      updateHexFormat({ lowerCase })
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  {labels.hexAddresses}
                  <Switch
                    checked={hexFormat.offsets}
                    onCheckedChange={(offsets) => updateHexFormat({ offsets })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  {labels.hexAscii}
                  <Switch
                    checked={hexFormat.ascii}
                    onCheckedChange={(ascii) => updateHexFormat({ ascii })}
                  />
                </label>
              </>
            )}
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
        <StreamHighlightEditor
          open={highlightEditorOpen}
          onOpenChange={setHighlightEditorOpen}
          restoreFocus={() => displayTrigger.current?.focus()}
          rules={highlightRules}
          onRulesChange={setHighlightRules}
          invalid={highlights?.invalid}
          notice={highlightNotice}
          labels={labels}
        />
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
      {visibleChartSelection ? (
        <output
          aria-label={labels.chartReceiveBytes}
          className="workbench-toolbar flex flex-wrap gap-2 text-xs"
        >
          <span>
            {labels.offset} [{String(visibleChartSelection.range.start.offset)},{" "}
            {String(visibleChartSelection.range.end.offset)})
          </span>
          <code ref={chartHexFallback} className="wrap-anywhere select-all">
            {visibleChartSelection.hex}
          </code>
        </output>
      ) : chartRevealResult &&
        chartRevealResult.request === chartReveal &&
        chartRevealResult.unavailable ? (
        <p role="status" className="text-muted-foreground text-xs">
          {labels.chartReceiveUnavailable}
        </p>
      ) : null}
      {searchOpen && (
        <form
          id={`${id}-search`}
          className="workbench-toolbar workbench-stream-search"
          data-surface="popover"
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.nativeEvent.isComposing &&
              event.target instanceof Node &&
              event.currentTarget.contains(event.target)
            ) {
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
                searchError === "timeout" ? (
                  labels.searchTimeout
                ) : searchError === "encoding" ? (
                  labels.searchEncoding
                ) : searchError === "limit" ? (
                  labels.searchLimit
                ) : queryMode === "hex" ? (
                  labels.invalidHex
                ) : (
                  labels.searchInvalid
                )
              ) : currentSearch?.partial ? (
                labels.searchPartial
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
            disabled={!query || matchVisibility === "hide"}
            onClick={() => void find(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </WorkbenchIconButton>
          <WorkbenchIconButton
            label={labels.find}
            disabled={!query || matchVisibility === "hide"}
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
          <StreamFilterControls
            labels={labels}
            direction={searchDirection}
            visibility={matchVisibility}
            hasQuery={!!query}
            onDirection={setSearchDirection}
            onVisibility={setMatchVisibility}
          />
        </form>
      )}
      <div className="workbench-receive-frame app-reading-surface">
        {showAnsi && (
          <Suspense
            fallback={
              <p role="status" className="workbench-ansi-view">
                {labels.ansiScreenLoading}
              </p>
            }
          >
            <AnsiScreen
              items={displayed}
              encoding={receiveCodec}
              sendEncoding={sendCodec}
              keyboard={frozen ? undefined : keyboard}
              convertEol={ansiConvertEol}
              typography={terminalSettings?.typography}
              scrollback={
                settings?.settings.ansiScrollbackLines ??
                DEFAULT_ANSI_SCROLLBACK_LINES
              }
              onScrollbackChange={
                settings
                  ? (ansiScrollbackLines) =>
                      settings.update({ ansiScrollbackLines })
                  : undefined
              }
              rawTrimmed={trimmed}
              labels={labels}
            />
          </Suspense>
        )}
        <StreamContextMenu
          viewport={viewport}
          labels={labels}
          receiveEncoding={receiveCodec}
          sendEncoding={sendCodec}
          sender={replay || error ? undefined : contextSender}
          sourceAvailable={!error}
          read={readContext}
          retained={readContextSample}
          onCopyFeedback={setContextCopyFeedback}
          onBookmark={bookmark}
          onSplit={splitAt}
        >
          <div
            hidden={showAnsi}
            role="log"
            aria-label={labels.terminal}
            aria-live="off"
            tabIndex={0}
            ref={viewport}
            className="workbench-stream-log app-scroll-region"
            data-surface="transparent"
            data-following={following}
            data-locating={locatedItem !== undefined || undefined}
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
                else if (
                  direction === "down" &&
                  !frozen &&
                  atStreamEnd(element)
                )
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
        </StreamContextMenu>
        <div className="workbench-stream-totals" aria-live="off">
          <div className="workbench-stream-status">
            {contextCopyFeedback && (
              <span role="status">{contextCopyFeedback}</span>
            )}
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
