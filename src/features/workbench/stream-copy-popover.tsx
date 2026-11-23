import { useRef, useState } from "react";
import { Copy } from "lucide-react";
import type { TextEncoding } from "@serial-workbench/contracts";
import { copyText } from "@/lib/clipboard";
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
  const [format, setFormat] = useState<StreamCopyFormat>("text");
  const [encoding, setEncoding] = useState(receiveEncoding);
  const [time, setTime] = useState<"source" | "received">("source");
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<"done" | "failed">();
  const pendingSelection = useRef<StreamHexSelection | undefined>(undefined);
  const pendingWrite = useRef(false);
  const generation = useRef(0);
  const textFormat = format === "text" || format === "timed";
  const formats = {
    text: labels.copyFormatText,
    hex: "HEX",
    timed: labels.copyFormatTimed,
    c: labels.copyFormatC,
    python: "Python bytes",
    base64: "Base64",
  };

  async function copy() {
    if (!sample || pendingWrite.current) return;
    pendingWrite.current = true;
    const current = generation.current;
    setCopying(true);
    setResult(undefined);
    try {
      await copyText(formatStreamCopy(sample, format, encoding, time));
      if (generation.current === current) setResult("done");
    } catch {
      if (generation.current === current) setResult("failed");
    } finally {
      pendingWrite.current = false;
      setCopying(false);
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        generation.current++;
        setResult(undefined);
        if (!open) {
          setSample(undefined);
          return;
        }
        const selection = readSelection() ?? pendingSelection.current;
        pendingSelection.current = undefined;
        const next = selection ? readSample(selection) : undefined;
        setSample(next);
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
        className="workbench-display-options w-80"
        align="end"
        aria-label={labels.copySelection}
      >
        <PopoverTitle>{labels.copySelection}</PopoverTitle>
        {sample ? (
          <>
            <p className="text-muted-foreground text-xs">
              {sample.direction} · {sample.bytes.length} B · {labels.offset}{" "}
              {sample.offset.toString()}
            </p>
            <label className="flex items-center justify-between gap-2">
              {labels.copyFormat}
              <Select
                value={format}
                disabled={copying}
                onValueChange={(value) => {
                  const chosen = STREAM_COPY_FORMATS.find(
                    (option) => option === value,
                  );
                  if (chosen) setFormat(chosen);
                  setResult(undefined);
                }}
              >
                <SelectTrigger aria-label={labels.copyFormat} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STREAM_COPY_FORMATS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {formats[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {textFormat && (
              <label className="flex items-center justify-between gap-2">
                {labels.copyEncoding}
                <TextEncodingSelect
                  value={encoding}
                  label={labels.copyEncoding}
                  disabled={copying}
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
                  disabled={copying}
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
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={copying} onClick={() => void copy()}>
                {labels.copyButton}
              </Button>
              <span role="status" className="text-xs">
                {copying
                  ? labels.copyWorking
                  : result === "done"
                    ? labels.copyDone
                    : result === "failed"
                      ? labels.copyFailed
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
