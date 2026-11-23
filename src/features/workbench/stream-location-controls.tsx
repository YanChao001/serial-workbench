import { useState } from "react";
import { Copy, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Switch } from "@/components/ui/switch";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { WorkbenchLabels } from "./labels";
import {
  STREAM_LOCATION_KINDS,
  streamLocationReference,
  type findStreamLocation,
  type NumberedStreamRow,
  type StreamLocationKind,
} from "./stream-location";

export function StreamRecordNumbers({
  row,
  labels,
  onCopy,
}: {
  row: NumberedStreamRow | undefined;
  labels: WorkbenchLabels;
  onCopy: (reference: string) => void;
}) {
  if (!row) return null;
  const first = row.events[0];
  const firstPacket = row.events.find(
    (event) => event.packet !== undefined,
  )?.packet;
  const lastPacket = row.events.at(-1)?.packet;
  return (
    <div className="workbench-stream-location">
      <span>
        {labels.locationLine} {row.line}
      </span>
      {firstPacket !== undefined && (
        <span>
          {labels.locationPacket} {firstPacket}
          {lastPacket !== undefined && lastPacket !== firstPacket
            ? "–" + lastPacket
            : ""}
        </span>
      )}
      {first && (
        <>
          <span>
            {labels.locationEvent} {first.locator[4]}
            {row.events.length > 1 ? " (+" + (row.events.length - 1) + ")" : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={labels.locationCopy}
            title={labels.locationCopy}
            onClick={() => onCopy(streamLocationReference(first.locator))}
          >
            <Copy aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
}

export function StreamLocationPopover({
  labels,
  showNumbers,
  onShowNumbers,
  onOpenChange,
  onLocate,
  onCopy,
}: {
  labels: WorkbenchLabels;
  showNumbers: boolean;
  onShowNumbers: (show: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onLocate: (
    kind: StreamLocationKind,
    input: string,
  ) => ReturnType<typeof findStreamLocation>;
  onCopy: (reference: string) => void;
}) {
  const [kind, setKind] = useState<StreamLocationKind>("reference");
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ReturnType<typeof findStreamLocation>>();
  const choices = {
    reference: labels.locationReference,
    event: labels.locationEvent,
    packet: labels.locationPacket,
    line: labels.locationLine,
  };
  const event = result?.kind === "found" ? result.event : undefined;

  return (
    <Popover
      onOpenChange={(open) => {
        onOpenChange(open);
        setResult(undefined);
      }}
    >
      <PopoverTrigger asChild>
        <WorkbenchIconButton label={labels.streamLocation}>
          <LocateFixed aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label={labels.streamLocation}
        className="workbench-display-options w-80"
        align="end"
      >
        <PopoverTitle>{labels.streamLocation}</PopoverTitle>
        <label className="flex items-center justify-between gap-2">
          {labels.locationShowNumbers}
          <Switch checked={showNumbers} onCheckedChange={onShowNumbers} />
        </label>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setResult(onLocate(kind, input));
          }}
        >
          <label className="flex items-center justify-between gap-2">
            {labels.locationType}
            <Select
              value={kind}
              onValueChange={(value) => {
                const next = STREAM_LOCATION_KINDS.find(
                  (choice) => choice === value,
                );
                if (next) setKind(next);
                setInput("");
                setResult(undefined);
              }}
            >
              <SelectTrigger aria-label={labels.locationType} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STREAM_LOCATION_KINDS.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {choices[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Input
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setResult(undefined);
            }}
            aria-label={choices[kind]}
            inputMode={kind === "reference" ? "text" : "numeric"}
            placeholder={choices[kind]}
            maxLength={4096}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="submit" disabled={!input.trim()}>
              {labels.locationJump}
            </Button>
            {event && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => onCopy(streamLocationReference(event.locator))}
              >
                {labels.locationCopy}
              </Button>
            )}
          </div>
          {result && (
            <p role="status" className="text-muted-foreground text-xs">
              {result.kind === "found" ? (
                <>
                  {labels.locationFound} {result.row.line}
                  {event
                    ? " · " + labels.locationEvent + " " + event.locator[4]
                    : ""}
                </>
              ) : (
                {
                  invalid: labels.locationInvalid,
                  unavailable: labels.locationUnavailable,
                  ambiguous: labels.locationAmbiguous,
                }[result.kind]
              )}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}
