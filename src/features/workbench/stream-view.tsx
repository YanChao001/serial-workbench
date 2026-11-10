import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Circle,
  FileText,
  Pause,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import type {
  StreamItem,
  TxReceipt,
  TerminalSettings,
  TerminalMode,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchNotice } from "./workbench-notice";
import { useStreamGapNotices } from "./stream-gap-notices";
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
  findStreamMatches,
  projectStreamItems,
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
export type StreamViewProps = {
  mode?: TerminalMode;
  onReceiveModeChange?: (mode: TerminalMode) => void;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
  replay?: boolean;
  initialMode?: "text" | "hex";
  items: readonly StreamItem[];
  labels: WorkbenchLabels;
  error?: Error | null;
  trimmed?: boolean;
  onOpenCapture?: () => void;
  onOpenActivity?: () => void;
  onClearView?: () => void;
  captureActive?: boolean;
  displayLabels?: {
    displayOptions: string;
    newData: string;
    clearView: string;
  };
};
export function StreamView({
  items,
  labels,
  error,
  trimmed,
  initialMode = "text",
  mode: controlledMode,
  onReceiveModeChange,
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
  const [frozen, setFrozen] = useState<readonly StreamItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [queryMode, setQueryMode] = useState<"text" | "hex">("text");
  const [match, setMatch] = useState<StreamMatch | null>(null);
  const [searched, setSearched] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const displayed = frozen ?? items;
  useStreamGapNotices(items, labels.gapHelp);
  const pendingCount = useMemo(() => {
    if (!frozen) return 0;
    const key = (item: StreamItem) =>
      item.kind === "source"
        ? JSON.stringify([
            item.event.hostId,
            item.event.instanceEpoch,
            item.event.sessionId,
            item.event.sessionEpoch,
            item.event.eventSeq,
          ])
        : JSON.stringify(item.gap);
    const shown = new Set(frozen.map(key));
    return items.filter((item) => !shown.has(key(item))).length;
  }, [frozen, items]);
  const projected = useMemo(() => projectStreamItems(displayed), [displayed]);
  const times = useMemo(
    () =>
      presentStreamTimes(
        projected.map(({ itemIndex }) => displayed[itemIndex]!),
      ),
    [displayed, projected],
  );
  const rows = useMemo(() => {
    let decoder = new TextDecoder();
    let txDecoder = new TextDecoder();
    let previousEnd: string | undefined;
    let previousSource: string | undefined;
    let previousTxEnd: string | undefined;
    let previousTxSource: string | undefined;
    return projected.map(({ item, itemIndex }, displayIndex) => {
      if (item.kind === "reader_gap") {
        decoder = new TextDecoder();
        txDecoder = new TextDecoder();
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
        decoder = new TextDecoder();
        txDecoder = new TextDecoder();
        previousEnd = undefined;
        previousTxEnd = undefined;
      }
      if (event.kind === "gap") {
        decoder = new TextDecoder();
        txDecoder = new TextDecoder();
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
        const source = JSON.stringify([
          event.hostId,
          event.instanceEpoch,
          event.sessionId,
          event.sessionEpoch,
        ]);
        if (
          previousEnd !== event.payload.byteStart ||
          previousSource !== source
        )
          decoder = new TextDecoder();
        previousEnd = event.payload.byteEnd;
        previousSource = source;
        const bytes = decodeBytes(event.payload.bytesBase64);
        return {
          itemIndex,
          displayIndex,
          kind: "rx",
          text: decoder.decode(bytes, { stream: true }),
          hex: formatHex(bytes),
          offset: event.payload.byteStart,
        };
      }
      if (event.kind === "tx" || event.kind === "tx_intent") {
        const source = JSON.stringify([
          event.hostId,
          event.instanceEpoch,
          event.sessionId,
          event.sessionEpoch,
        ]);
        if (
          previousTxEnd !== event.payload.byteStart ||
          previousTxSource !== source
        )
          txDecoder = new TextDecoder();
        previousTxEnd = event.payload.byteEnd;
        previousTxSource = source;
        const bytes = decodeBytes(event.payload.bytesBase64);
        return {
          itemIndex,
          displayIndex,
          kind: "tx",
          text: txDecoder.decode(bytes, { stream: true }),
          hex: formatHex(bytes),
          offset: event.payload.byteStart,
          byteEnd: event.payload.byteEnd,
          receipt: event.kind === "tx" ? event.payload : undefined,
        };
      }
      return {
        itemIndex,
        displayIndex,
        kind: event.kind,
        text: event.eventSeq,
      };
    });
  }, [projected]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!frozen && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [displayed, frozen]);
  useEffect(() => {
    if (match) {
      const row = rowRefs.current.get(match.itemIndex);
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    }
  }, [match]);
  function find() {
    setSearched(true);
    try {
      const matches = findStreamMatches(displayed, query, queryMode);
      const next =
        matches.find(
          (candidate) =>
            !match || BigInt(candidate.offset) > BigInt(match.offset),
        ) ??
        matches[0] ??
        null;
      setInvalid(false);
      setMatch(next);
      if (next && !frozen) setFrozen([...items]);
    } catch {
      setInvalid(true);
      setMatch(null);
    }
  }
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
        {frozen && pendingCount > 0 && (
          <span
            role="status"
            aria-label={displayLabels?.newData ?? labels.resume}
            className="workbench-pending-count text-muted-foreground"
          >
            +{pendingCount}
          </span>
        )}
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
            setFrozen(frozen ? null : [...items]);
            setMatch(null);
          }}
        >
          {frozen ? (
            <ArrowDownToLine aria-hidden="true" />
          ) : (
            <Pause aria-hidden="true" />
          )}
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
              {labels.encodingHelp} · UTF-8
            </p>
          </PopoverContent>
        </Popover>
        {onClearView && (
          <WorkbenchIconButton
            label={displayLabels?.clearView ?? labels.terminal}
            disabled={!items.length}
            onClick={() => {
              setFrozen(null);
              setMatch(null);
              onClearView();
            }}
          >
            <Trash2 aria-hidden="true" />
          </WorkbenchIconButton>
        )}
      </div>
      {searchOpen && (
        <form
          id={`${id}-search`}
          className="workbench-toolbar workbench-stream-search"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              setSearchOpen(false);
              searchTrigger.current?.focus();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            find();
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
          <Button size="sm" variant="outline" type="submit" disabled={!query}>
            {labels.find}
          </Button>
          {searched && (
            <span role="status">
              {invalid
                ? labels.invalidHex
                : match
                  ? `${labels.offset} ${match.offset}`
                  : labels.noMatches}
            </span>
          )}
        </form>
      )}
      <div
        role="log"
        aria-label={labels.terminal}
        aria-live="off"
        tabIndex={0}
        ref={viewport}
        className="workbench-stream-log app-reading-surface app-scroll-region"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            !frozen &&
            element.scrollHeight - element.scrollTop - element.clientHeight > 24
          )
            setFrozen([...items]);
        }}
      >
        {rows.map((row) => (
          <div
            key={row.itemIndex}
            ref={(element) => {
              if (element) rowRefs.current.set(row.itemIndex, element);
              else rowRefs.current.delete(row.itemIndex);
            }}
            tabIndex={-1}
            data-offset={row.offset}
            data-direction={row.kind}
            className={`workbench-stream-row ${row.kind === "gap" ? "workbench-gap" : ""}`}
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
              {row.kind === "rx" && <ArrowDown aria-hidden="true" />}
              {row.kind === "tx" && <ArrowUp aria-hidden="true" />}
              {row.kind === "gap" ? labels.gap : row.kind.toUpperCase()}
            </span>
            {presentationLabels && (
              <details
                data-surface="transparent"
                className="workbench-stream-time text-muted-foreground text-xs"
              >
                <summary
                  data-surface="transparent"
                  title={presentationLabels.timeDetails}
                >
                  {timeMode === "absolute"
                    ? times[row.displayIndex]!.absolute
                      ? compactStreamTime(times[row.displayIndex]!.absolute!)
                      : presentationLabels.missingTime
                    : (timeMode === "relative"
                          ? times[row.displayIndex]!.relativeNs
                          : times[row.displayIndex]!.intervalNs) === null
                      ? presentationLabels.missingTime
                      : `${timeMode === "relative" ? times[row.displayIndex]!.relativeNs : times[row.displayIndex]!.intervalNs} ns`}
                </summary>
                {times[row.displayIndex]!.time ? (
                  <>
                    <p>
                      <time
                        dateTime={
                          times[row.displayIndex]!.absolute ?? undefined
                        }
                      >
                        {times[row.displayIndex]!.absolute ??
                          presentationLabels.missingTime}
                      </time>
                    </p>
                    <p>
                      {presentationLabels.clock}:{" "}
                      {times[row.displayIndex]!.time!.clockId}
                    </p>
                    <p>
                      {presentationLabels.timeSource}:{" "}
                      {times[row.displayIndex]!.time!.precision.source}
                    </p>
                    <p>
                      {presentationLabels.resolution}:{" "}
                      {times[row.displayIndex]!.time!.precision.resolutionNs} ns
                    </p>
                    <p>
                      {times[row.displayIndex]!.absoluteSource === "source"
                        ? presentationLabels.sourceTime
                        : presentationLabels.receivedTime}
                    </p>
                  </>
                ) : (
                  <p>{presentationLabels.missingTime}</p>
                )}
              </details>
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
                  {row.kind === "tx" && (
                    <div className="workbench-tx-receipt text-muted-foreground text-xs">
                      <TxStreamReceipt
                        receipt={row.receipt}
                        byteStart={row.offset!}
                        byteEnd={row.byteEnd!}
                        labels={labels}
                      />
                    </div>
                  )}
                </>
              ) : (
                <span className="workbench-payload">{row.text}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <WorkbenchNotice
        noticeKey={`gap:${trimmed ?? false}:${labels.gapHelp}`}
        log={{ module: "display", level: "warning", message: labels.gapHelp }}
      >
        {trimmed && <p className="text-muted-foreground">{labels.gapHelp}</p>}
      </WorkbenchNotice>
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
            <details>
              <summary>{labels.errorDetails}</summary>
              <code>{error.message}</code>
            </details>
          </div>
        )}
      </WorkbenchNotice>
    </section>
  );
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
  if (!receipt)
    return (
      <details data-surface="transparent">
        <summary data-surface="transparent">{labels.awaitingReceipt}</summary>
        <p>
          {labels.requestedBytes}: [{byteStart}, {byteEnd})
        </p>
      </details>
    );
  return (
    <details data-surface="transparent" data-outcome={receipt.outcome}>
      <summary data-surface="transparent">
        {workbenchStatus(receipt.outcome, labels)}
      </summary>
      <TxReceiptFacts receipt={receipt} labels={labels} />
    </details>
  );
}
