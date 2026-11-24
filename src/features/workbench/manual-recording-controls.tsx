import { useRef, useState } from "react";
import { CircleDotIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { useManualSendRecording } from "./use-manual-send-recording";

export type ManualRecordingLabels = {
  title: string;
  description: string;
  referenceBytes: string;
  start: string;
  stop: string;
  review: string;
  discard: string;
  progress: (count: number) => string;
  settling: string;
  reasons: { scope: string; gap: string; unconfirmed: string; limit: string };
};

export function ManualRecordingControls({
  labels,
  recording,
  available,
  onReview,
}: {
  labels: ManualRecordingLabels;
  recording: ReturnType<typeof useManualSendRecording>;
  available: boolean;
  onReview: (definition: string, trigger: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [referenceBytes, setReferenceBytes] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { snapshot } = recording;
  const reason = snapshot?.reason;
  const notice =
    snapshot?.phase === "ready" && reason && reason !== "user"
      ? labels.reasons[reason]
      : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          ref={trigger}
          label={labels.title}
          variant={snapshot?.phase === "recording" ? "destructive" : "ghost"}
          disabled={!available && !snapshot}
        >
          <CircleDotIcon aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={labels.title}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <PopoverTitle>{labels.title}</PopoverTitle>
        {!snapshot && (
          <div className="grid gap-2 text-sm">
            <p>{labels.description}</p>
            <label className="flex items-center gap-2 wrap-anywhere">
              <Checkbox
                checked={referenceBytes}
                onCheckedChange={(value) => setReferenceBytes(value === true)}
              />
              {labels.referenceBytes}
            </label>
          </div>
        )}
        {snapshot && (
          <p role="status" className="text-sm">
            {labels.progress(snapshot.confirmed)}
            {snapshot.phase === "settling" && <span> {labels.settling}</span>}
            {notice && <span> {notice}</span>}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!snapshot && (
            <Button
              type="button"
              size="sm"
              disabled={!available}
              onClick={() => {
                recording.start(referenceBytes);
                setOpen(false);
              }}
            >
              {labels.start}
            </Button>
          )}
          {snapshot?.phase === "recording" && (
            <Button type="button" size="sm" onClick={recording.stop}>
              {labels.stop}
            </Button>
          )}
          {snapshot?.definition && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!snapshot.definition) return;
                setOpen(false);
                onReview(snapshot.definition, trigger.current);
              }}
            >
              {labels.review}
            </Button>
          )}
          {snapshot?.phase === "ready" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={recording.discard}
            >
              {labels.discard}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
