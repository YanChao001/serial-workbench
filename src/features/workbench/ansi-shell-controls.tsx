import { useId, useState } from "react";
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
import {
  isAnsiWindowDimension,
  MAX_ANSI_WINDOW_DIMENSION,
} from "./ansi-keyboard";
import {
  ansiShellCommand,
  ANSI_SHELL_TERMS,
  validShellTerm,
  type ShellColorCapability,
} from "./ansi-shell-profile";
import type { WorkbenchLabels } from "./labels";

const COLORS = ["mono", "basic", "indexed", "truecolor"] as const;

export function AnsiShellControls({
  disabled,
  labels,
  size,
  insert,
}: {
  disabled: boolean;
  labels: WorkbenchLabels;
  size: () => { rows: number; cols: number } | undefined;
  insert: (command: string) => boolean;
}) {
  const id = useId();
  const [color, setColor] = useState<ShellColorCapability>("indexed");
  const [term, setTerm] = useState<string>(ANSI_SHELL_TERMS.indexed);
  const [rows, setRows] = useState("");
  const [cols, setCols] = useState("");
  const [queued, setQueued] = useState<string>();
  const colors = {
    mono: labels.ansiShellMono,
    basic: labels.ansiShellBasic,
    indexed: labels.ansiShellIndexed,
    truecolor: labels.ansiShellTruecolor,
  };
  const validTerm = validShellTerm(term);
  const validSize = [rows, cols].every(
    (value) => value === "" || isAnsiWindowDimension(Number(value)),
  );

  return (
    <details className="workbench-ansi-shell">
      <summary>{labels.ansiShell}</summary>
      <p>{labels.ansiShellHint}</p>
      <form
        className="workbench-ansi-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !validTerm || !validSize) return;
          const current = size();
          if (!current) return;
          const command = ansiShellCommand(
            term,
            color,
            rows === "" ? current.rows : Number(rows),
            cols === "" ? current.cols : Number(cols),
          );
          if (command && insert(command)) setQueued(command);
        }}
      >
        <Label htmlFor={`${id}-color`}>{labels.ansiShellColor}</Label>
        <Select
          value={color}
          onValueChange={(next) => {
            const choice = COLORS.find((candidate) => candidate === next);
            if (!choice) return;
            setColor(choice);
            setTerm(ANSI_SHELL_TERMS[choice]);
          }}
        >
          <SelectTrigger id={`${id}-color`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLORS.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {colors[choice]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor={`${id}-term`}>TERM</Label>
        <Input
          className="w-40"
          id={`${id}-term`}
          maxLength={64}
          value={term}
          aria-invalid={!validTerm}
          onChange={(event) => setTerm(event.target.value)}
        />
        <Label htmlFor={`${id}-rows`}>{labels.ansiShellRows}</Label>
        <Input
          className="w-24"
          id={`${id}-rows`}
          type="number"
          min={1}
          max={MAX_ANSI_WINDOW_DIMENSION}
          step={1}
          value={rows}
          onChange={(event) => setRows(event.target.value)}
        />
        <Label htmlFor={`${id}-cols`}>{labels.ansiShellColumns}</Label>
        <Input
          className="w-24"
          id={`${id}-cols`}
          type="number"
          min={1}
          max={MAX_ANSI_WINDOW_DIMENSION}
          step={1}
          value={cols}
          onChange={(event) => setCols(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || !validTerm || !validSize}
        >
          {labels.ansiShellInsert}
        </Button>
      </form>
      {queued && (
        <p role="status">
          {labels.ansiShellQueued} <code>{queued}</code>
        </p>
      )}
    </details>
  );
}
