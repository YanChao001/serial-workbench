import { useRef, useState } from "react";
import { Copy } from "lucide-react";
import type { TextEncoding } from "@serial-workbench/contracts";
import { copyText } from "@/lib/clipboard";
import { saveTextExport } from "@/lib/tauri";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TextEncodingSelect } from "./text-encoding-select";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { WorkbenchLabels } from "./labels";
import type { StreamHexSelection } from "./stream-hex-selection";
import {
  formatStreamCopy,
  STREAM_COPY_FORMATS,
  type StreamCopyFormat,
  type StreamCopySample,
} from "./stream-copy";
import {
  formatStreamExport,
  streamExportColors,
  streamExportPage,
  streamExportPageCount,
  type StreamExportFormat,
  type StreamExportTheme,
} from "./stream-selection-export";

const selectionFormats = [...STREAM_COPY_FORMATS, "html", "svg"] as const;

export function StreamCopyPopover({
  readSelection,
  readSample,
  receiveEncoding,
  sendEncoding,
  labels,
}: {
  readSelection: () => StreamHexSelection | undefined;
  readSample: (selection: StreamHexSelection) => StreamCopySample | undefined;
  receiveEncoding: TextEncoding;
  sendEncoding: TextEncoding;
  labels: WorkbenchLabels;
}) {
  const [sample, setSample] = useState<StreamCopySample>();
  const [format, setFormat] = useState<StreamCopyFormat | StreamExportFormat>(
    "text",
  );
  const [theme, setTheme] = useState<StreamExportTheme>("light");
  const [page, setPage] = useState(0);
  const [encoding, setEncoding] = useState(receiveEncoding);
  const [time, setTime] = useState<"source" | "received">("source");
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<"done" | "failed" | "unavailable">();
  const pendingSelection = useRef<StreamHexSelection | undefined>(undefined);
  const capturedSelection = useRef<StreamHexSelection | undefined>(undefined);
  const pendingWrite = useRef(false);
  const generation = useRef(0);
  const textFormat = format === "text" || format === "timed";
  const exporting = format === "html" || format === "svg";
  const pages = sample && exporting ? streamExportPageCount(sample) : 0;
  const preview =
    sample && exporting
      ? streamExportPage(sample, format === "svg" ? page : 0)
      : undefined;
  const outputStatus = {
    working: exporting ? labels.selectionWorking : labels.copyWorking,
    done: exporting ? labels.selectionSaved : labels.copyDone,
    failed: exporting ? labels.selectionSaveFailed : labels.copyFailed,
    unavailable: labels.selectionUnavailable,
  };
  const formats = {
    text: labels.copyFormatText,
    hex: "HEX",
    timed: labels.copyFormatTimed,
    c: labels.copyFormatC,
    python: "Python bytes",
    base64: "Base64",
    html: "HTML",
    svg: "SVG",
  };

  async function writeSelection() {
    if (!sample || pendingWrite.current) return;
    pendingWrite.current = true;
    const current = generation.current;
    setWriting(true);
    setResult(undefined);
    try {
      if (exporting) {
        const selected = capturedSelection.current;
        const live = selected ? readSample(selected) : undefined;
        if (
          !live ||
          live.offset !== sample.offset ||
          live.direction !== sample.direction ||
          live.bytes.length !== sample.bytes.length ||
          !live.bytes.every((value, index) => value === sample.bytes[index])
        ) {
          setResult("unavailable");
          return;
        }
        const { name, content } = formatStreamExport(live, format, theme, page);
        if ((await saveTextExport(name, content)) === null) return;
      } else {
        await copyText(formatStreamCopy(sample, format, encoding, time));
      }
      if (generation.current === current) setResult("done");
    } catch {
      if (generation.current === current) setResult("failed");
    } finally {
      pendingWrite.current = false;
      setWriting(false);
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        generation.current++;
        setResult(undefined);
        if (!open) {
          capturedSelection.current = undefined;
          setSample(undefined);
          return;
        }
        const selection = readSelection() ?? pendingSelection.current;
        pendingSelection.current = undefined;
        const next = selection ? readSample(selection) : undefined;
        capturedSelection.current = next ? selection : undefined;
        setSample(next);
        setPage(0);
        setTheme(
          document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        );
        setEncoding(next?.direction === "TX" ? sendEncoding : receiveEncoding);
      }}
    >
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={labels.copySelection}
          onPointerDownCapture={() => {
            pendingSelection.current = readSelection();
          }}
        >
          <Copy aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        className="workbench-display-options @container/selection w-80"
        align="end"
        aria-label={labels.copySelection}
      >
        <PopoverTitle>{labels.copySelection}</PopoverTitle>
        {sample ? (
          <>
            <p className="wrap-anywhere text-xs text-muted-foreground tabular-nums">
              {sample.direction} · {sample.bytes.length} B · {labels.offset} [
              {sample.offset.toString()},{" "}
              {(sample.offset + BigInt(sample.bytes.length)).toString()})
            </p>
            <div className="grid min-w-0 gap-1.5 @min-[17rem]/selection:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] @min-[17rem]/selection:items-center">
              <span>{labels.copyFormat}</span>
              <OptionsSelect
                label={labels.copyFormat}
                value={format}
                disabled={writing}
                onValueChange={(value) => {
                  setFormat(value);
                  setResult(undefined);
                }}
                options={selectionFormats.map((value) => ({
                  value,
                  label: formats[value],
                }))}
              />
            </div>
            {textFormat && (
              <label className="flex items-center justify-between gap-2">
                {labels.copyEncoding}
                <TextEncodingSelect
                  value={encoding}
                  label={labels.copyEncoding}
                  disabled={writing}
                  onChange={(value) => {
                    if (value) setEncoding(value);
                    setResult(undefined);
                  }}
                />
              </label>
            )}
            {format === "timed" && (
              <label className="flex items-center justify-between gap-2">
                {labels.copyTimestamp}
                <Select
                  value={time}
                  disabled={writing}
                  onValueChange={(value) => {
                    if (value === "source" || value === "received")
                      setTime(value);
                    setResult(undefined);
                  }}
                >
                  <SelectTrigger aria-label={labels.copyTimestamp} size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="source">
                      {labels.copySourceTime}
                    </SelectItem>
                    <SelectItem value="received">
                      {labels.copyReceivedTime}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}
            {preview ? (
              <>
                <div className="grid min-w-0 gap-1.5 @min-[17rem]/selection:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] @min-[17rem]/selection:items-center">
                  <span>{labels.selectionTheme}</span>
                  <OptionsSelect
                    label={labels.selectionTheme}
                    value={theme}
                    disabled={writing}
                    onValueChange={(value) => {
                      setTheme(value);
                      setResult(undefined);
                    }}
                    options={[
                      { value: "light", label: labels.selectionLight },
                      { value: "dark", label: labels.selectionDark },
                    ]}
                  />
                </div>
                {format === "svg" && pages > 1 ? (
                  <div className="grid min-w-0 gap-1.5 @min-[17rem]/selection:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] @min-[17rem]/selection:items-center">
                    <span>{labels.selectionPage}</span>
                    <OptionsSelect
                      label={labels.selectionPage}
                      value={String(page)}
                      disabled={writing}
                      onValueChange={(value) => {
                        setPage(Number(value));
                        setResult(undefined);
                      }}
                      options={Array.from({ length: pages }, (_, index) => ({
                        value: String(index),
                        label: `${index + 1}/${pages}`,
                      }))}
                    />
                  </div>
                ) : null}
                {format === "svg" && pages > 1 ? (
                  <p className="wrap-anywhere text-xs text-muted-foreground tabular-nums">
                    {preview.range}
                  </p>
                ) : null}
                <pre
                  aria-label={labels.selectionPreview}
                  className="min-w-0 overflow-x-auto rounded-md p-2 text-xs"
                  tabIndex={0}
                  style={{
                    background: streamExportColors[theme].background,
                    color: streamExportColors[theme].foreground,
                  }}
                >
                  {preview.rows
                    .slice(0, 3)
                    .map(({ hex, ascii }) => `${hex}\n|${ascii}|`)
                    .join("\n\n")}
                </pre>
              </>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={writing}
                onClick={() => void writeSelection()}
              >
                {exporting ? labels.selectionSave : labels.copyButton}
              </Button>
              <span role="status" className="text-xs">
                {writing
                  ? outputStatus.working
                  : result
                    ? outputStatus[result]
                    : ""}
              </span>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            {labels.copySelectionHint}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
