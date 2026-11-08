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
  TerminalSettings,
  TerminalMode,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
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
  type StreamMatch,
} from "./stream-model";
import {
  presentStreamTimes,
  terminalTypographyStyle,
  type StreamPresentationLabels,
} from "./stream-presentation";
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
  const times = useMemo(() => presentStreamTimes(displayed), [displayed]);
  const rows = useMemo(() => {
    let decoder = new TextDecoder();
    let previousEnd: string | undefined;
    let previousSource: string | undefined;
    return displayed.map((item) => {
      if (item.kind === "reader_gap") {
        decoder = new TextDecoder();
        previousEnd = undefined;
        return {
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
        previousEnd = undefined;
      }
      if (event.kind === "gap") {
        decoder = new TextDecoder();
        previousEnd = undefined;
        const range = event.payload.missingByteRange;
        return {
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
          kind: "rx",
          text: decoder.decode(bytes, { stream: true }),
          hex: formatHex(bytes),
          offset: event.payload.byteStart,
        };
      }
      if (event.kind === "tx")
        return {
          kind: "tx",
          text: `${event.payload.outcome} [${event.payload.byteStart}, ${event.payload.byteEnd})`,
          offset: event.payload.byteStart,
        };
      return { kind: event.kind, text: event.eventSeq };
    });
  }, [displayed]);
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
        <Button
          ref={searchTrigger}
          size="icon-sm"
          variant="ghost"
          aria-label={labels.search}
          title={labels.search}
          aria-expanded={searchOpen}
          aria-controls={`${id}-search`}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={frozen ? labels.resume : labels.freeze}
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
          <span className="workbench-tool-label">
            {frozen ? labels.resume : labels.freeze}
          </span>
        </Button>
        {onOpenCapture && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={labels.capture}
            aria-pressed={captureActive}
            onClick={onOpenCapture}
          >
            <Circle aria-hidden="true" />
            <span className="workbench-tool-label">{labels.capture}</span>
          </Button>
        )}
        {onOpenActivity && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={labels.activity}
            onClick={onOpenActivity}
          >
            <FileText aria-hidden="true" />
            <span className="workbench-tool-label">{labels.activity}</span>
          </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={displayLabels?.displayOptions ?? labels.encodingHelp}
              title={displayLabels?.displayOptions ?? labels.encodingHelp}
            >
              <Settings2 aria-hidden="true" />
            </Button>
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
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={displayLabels?.clearView ?? labels.terminal}
            disabled={!items.length}
            onClick={() => {
              setFrozen(null);
              setMatch(null);
              onClearView();
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
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
        {!rows.length && (
          <p className="text-muted-foreground">{labels.emptyStream}</p>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            ref={(element) => {
              if (element) rowRefs.current.set(index, element);
              else rowRefs.current.delete(index);
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
              <details className="workbench-stream-time text-muted-foreground text-xs">
                <summary title={presentationLabels.timeDetails}>
                  {timeMode === "absolute"
                    ? (times[index]!.absolute ?? presentationLabels.missingTime)
                    : (timeMode === "relative"
                          ? times[index]!.relativeNs
                          : times[index]!.intervalNs) === null
                      ? presentationLabels.missingTime
                      : `${timeMode === "relative" ? times[index]!.relativeNs : times[index]!.intervalNs} ns`}
                </summary>
                {times[index]!.time ? (
                  <>
                    <p>
                      {presentationLabels.clock}: {times[index]!.time!.clockId}
                    </p>
                    <p>
                      {presentationLabels.timeSource}:{" "}
                      {times[index]!.time!.precision.source}
                    </p>
                    <p>
                      {presentationLabels.resolution}:{" "}
                      {times[index]!.time!.precision.resolutionNs} ns
                    </p>
                    <p>
                      {times[index]!.absoluteSource === "source"
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
              {row.kind === "rx" ? (
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
        ))}
      </div>
      {(trimmed || rows.some((row) => row.kind === "gap")) && (
        <p className="text-muted-foreground">{labels.gapHelp}</p>
      )}
      {error && <p role="alert">{error.message}</p>}
    </section>
  );
}
