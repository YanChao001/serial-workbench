import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_ANSI_SCROLLBACK_LINES } from "@/lib/client-settings";
import type { AnsiHistorySnapshot } from "./ansi-history";
import type { WorkbenchLabels } from "./labels";

function wholeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return;
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number;
}

export function AnsiHistoryControls({
  labels,
  limit,
  onLimitChange,
  snapshot,
  rawTrimmed,
  onJump,
}: {
  labels: WorkbenchLabels;
  limit: number;
  onLimitChange?: (value: number) => void;
  snapshot?: AnsiHistorySnapshot;
  rawTrimmed?: boolean;
  onJump: (line: number | "latest") => void;
}) {
  const id = useId();
  const [lineInput, setLineInput] = useState("");
  const [limitInput, setLimitInput] = useState<string>();
  const line = wholeNumber(lineInput);
  const proposedLimit = wholeNumber(limitInput ?? String(limit));
  const canJump =
    snapshot && line !== undefined && line >= 1 && line <= snapshot.retained;
  const canSave =
    proposedLimit !== undefined &&
    proposedLimit <= MAX_ANSI_SCROLLBACK_LINES &&
    proposedLimit !== limit;

  return (
    <details className="workbench-ansi-history">
      <summary>
        {labels.ansiScrollback} · {labels.ansiScrollbackLimit}{" "}
        {limit.toLocaleString()}
        {snapshot?.lostEarlierLines && ` · ${labels.ansiScrollbackTrimmed}`}
      </summary>
      {snapshot && (
        <>
          <p>
            {labels.ansiScrollbackRange
              .replace("{first}", snapshot.first.toLocaleString())
              .replace("{last}", snapshot.last.toLocaleString())
              .replace("{count}", snapshot.retained.toLocaleString())}
            {snapshot.alternate && ` · ${labels.ansiScrollbackAlternate}`}
          </p>
          <form
            className="workbench-ansi-controls"
            onSubmit={(event) => {
              event.preventDefault();
              if (canJump) onJump(line);
            }}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={snapshot.first === 1}
              onClick={() => onJump(1)}
            >
              {labels.ansiScrollbackFirst}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={snapshot.atLatest}
              onClick={() => onJump("latest")}
            >
              {labels.ansiScrollbackLatest}
            </Button>
            <Label htmlFor={`${id}-line`}>{labels.ansiScrollbackLine}</Label>
            <Input
              className="w-24"
              id={`${id}-line`}
              type="number"
              min={1}
              max={snapshot.retained}
              step={1}
              value={lineInput}
              onChange={(event) => setLineInput(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!canJump}
            >
              {labels.ansiScrollbackJump}
            </Button>
          </form>
        </>
      )}
      {onLimitChange && (
        <form
          className="workbench-ansi-controls"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            onLimitChange(proposedLimit);
            setLimitInput(undefined);
          }}
        >
          <Label htmlFor={`${id}-limit`}>{labels.ansiScrollbackLimit}</Label>
          <Input
            className="w-24"
            id={`${id}-limit`}
            type="number"
            min={0}
            max={MAX_ANSI_SCROLLBACK_LINES}
            step={1}
            value={limitInput ?? String(limit)}
            onChange={(event) => setLimitInput(event.target.value)}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!canSave}>
            {labels.ansiScrollbackApply}
          </Button>
        </form>
      )}
      {rawTrimmed && <p>{labels.historyTrimmed}</p>}
      <p>{labels.ansiScrollbackHelp}</p>
    </details>
  );
}
