import { useEffect, useId, useRef, useState } from "react";
import type { IBufferRange, Terminal } from "@xterm/xterm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  locateAnsiMatch,
  MAX_ANSI_SEARCH_QUERY,
  readAnsiSearchLines,
  type AnsiSearchMatch,
} from "./ansi-search";
import type { WorkbenchLabels } from "./labels";
import { requestAnsiSearch } from "./stream-search-client";

type Job = {
  terminal: Terminal;
  controller: AbortController;
  lines: NonNullable<ReturnType<typeof readAnsiSearchLines>>;
  matches: AnsiSearchMatch[];
  selection?: IBufferRange;
  truncated?: boolean;
};

type Report = {
  terminal: Terminal;
} & (
  | {
      kind: "searching" | "changed" | "syntax" | "limit" | "timeout" | "failed";
    }
  | { kind: "results"; index: number; count: number; truncated?: boolean }
);

function clearJob(job?: Job) {
  if (!job) return;
  job.controller.abort();
  const current = job.terminal.getSelectionPosition();
  const previous = job.selection;
  if (
    current &&
    previous &&
    current.start.x === previous.start.x &&
    current.start.y === previous.start.y &&
    current.end.x === previous.end.x &&
    current.end.y === previous.end.y
  )
    job.terminal.clearSelection();
}

export function AnsiSearchControls({
  terminal,
  isCurrent,
  labels,
}: {
  terminal?: Terminal;
  isCurrent: (terminal: Terminal) => boolean;
  labels: WorkbenchLabels;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [report, setReport] = useState<Report>();
  const job = useRef<Job | undefined>(undefined);
  const visible: Report | undefined =
    report && terminal
      ? report.terminal === terminal
        ? report
        : { terminal, kind: "changed" }
      : undefined;

  useEffect(() => {
    if (!terminal) return;
    function changed() {
      const current = job.current;
      if (!current || current.terminal !== terminal) return;
      job.current = undefined;
      clearJob(current);
      setReport({ terminal: current.terminal, kind: "changed" });
    }
    const subscriptions = [
      terminal.onWriteParsed(changed),
      terminal.onResize(changed),
      terminal.buffer.onBufferChange(changed),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (job.current?.terminal === terminal) {
        job.current.controller.abort();
        job.current = undefined;
      }
    };
  }, [terminal]);

  function discard() {
    clearJob(job.current);
    job.current = undefined;
    setReport(undefined);
  }

  function showMatch(current: Job, index: number) {
    const { terminal, lines, matches, truncated } = current;
    if (job.current !== current || !isCurrent(terminal)) return;
    const match = matches[index];
    const range = match && locateAnsiMatch(terminal, lines, match);
    if (range) {
      terminal.select(range.column, range.row, range.length);
      terminal.scrollToLine(range.row);
      current.selection = terminal.getSelectionPosition();
    }
    setReport({
      terminal,
      kind: "results",
      index,
      count: matches.length,
      truncated,
    });
  }

  async function search() {
    if (!terminal || !isCurrent(terminal) || !query) return;
    discard();
    const lines = readAnsiSearchLines(terminal);
    if (!lines) {
      setReport({ terminal, kind: "limit" });
      return;
    }
    const controller = new AbortController();
    const current: Job = { terminal, controller, lines, matches: [] };
    job.current = current;
    setReport({ terminal, kind: "searching" });
    try {
      const result = await requestAnsiSearch(
        {
          mode: "ansi",
          lines: lines.map(({ text }) => text),
          query,
          regex,
          caseSensitive,
        },
        controller.signal,
      );
      if (job.current !== current || !isCurrent(terminal)) return;
      if (result.error) {
        job.current = undefined;
        setReport({ terminal, kind: result.error });
        return;
      }
      current.matches = result.matches;
      current.truncated = result.truncated;
      showMatch(current, 0);
    } catch (error) {
      if (job.current !== current || !isCurrent(terminal)) return;
      job.current = undefined;
      const kind =
        error instanceof Error && error.message === "SEARCH_TIMEOUT"
          ? "timeout"
          : "failed";
      setReport({ terminal, kind });
    }
  }

  function step(delta: number) {
    const current = job.current;
    if (!current || visible?.kind !== "results" || !visible.count) return;
    showMatch(current, (visible.index + delta + visible.count) % visible.count);
  }

  const results = visible?.kind === "results" ? visible : undefined;
  const status =
    visible &&
    (visible.kind === "results"
      ? visible.count
        ? `${visible.index + 1}/${visible.count}${visible.truncated ? "+" : ""}`
        : labels.noMatches
      : {
          searching: labels.ansiSearchPending,
          changed: labels.ansiSearchChanged,
          syntax: labels.searchInvalid,
          limit: labels.searchLimit,
          timeout: labels.searchTimeout,
          failed: labels.ansiSearchFailed,
        }[visible.kind]);

  return (
    <details
      className="workbench-ansi-search"
      onToggle={(event) => {
        if (!event.currentTarget.open) discard();
      }}
    >
      <summary>{labels.ansiSearch}</summary>
      <form
        className="workbench-ansi-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Label className="sr-only" htmlFor={id}>
          {labels.ansiSearch}
        </Label>
        <Input
          id={id}
          className="w-48"
          value={query}
          maxLength={MAX_ANSI_SEARCH_QUERY}
          onChange={(event) => {
            setQuery(event.target.value);
            discard();
          }}
        />
        <label className="flex items-center gap-2">
          <Switch
            checked={regex}
            onCheckedChange={(value) => {
              setRegex(value);
              discard();
            }}
          />
          {labels.searchRegex}
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={caseSensitive}
            onCheckedChange={(value) => {
              setCaseSensitive(value);
              discard();
            }}
          />
          {labels.searchCase}
        </label>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!terminal || !query}
        >
          {labels.ansiSearch}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!results?.count}
          onClick={() => step(-1)}
        >
          {labels.searchPrevious}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!results?.count}
          onClick={() => step(1)}
        >
          {labels.ansiSearchNext}
        </Button>
      </form>
      <p aria-live="polite" className="min-h-5">
        {status}
      </p>
    </details>
  );
}
