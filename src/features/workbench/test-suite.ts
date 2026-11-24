import {
  CommandSequenceError,
  commandSequenceMaxBytes,
  compileCommandSequence,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { isRecord } from "@/lib/settings-model";

export const testSuiteMaxBytes = commandSequenceMaxBytes;
const maxCases = 16;

type SuiteCase = { name: string; definition: string; skip: boolean };
type Suite = { name: string; cases: SuiteCase[] };
type CaseOutcome = {
  status: "passed" | "failed" | "cancelled" | "unverified";
  reason?: string;
  unresolvedReplies?: boolean;
};
type CaseResult = {
  name: string;
  status: CaseOutcome["status"] | "skipped";
  reason?: string;
  operationId?: string;
  elapsedMs: number;
};
export type TestSuiteReport = {
  name: string;
  startedAt: string;
  cases: CaseResult[];
};
type AcceptedCase = { operationId: string };
type SuiteAccess<Operation extends AcceptedCase> = {
  prepare: (definition: string, signal: AbortSignal) => Promise<string>;
  invoke: (
    definition: string,
    startEventSeq: string,
    signal: AbortSignal,
  ) => Promise<Operation>;
  observe: (accepted: Operation, signal: AbortSignal) => Promise<CaseOutcome>;
  cancel: (accepted: Operation, signal: AbortSignal) => Promise<void>;
};

function fail(path: string, reason: string): never {
  throw new CommandSequenceError(path, reason);
}

function name(value: unknown, path: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value ||
    value.length > 96
  )
    fail(path, "Use a title of 1 to 96 characters");
  return value;
}

export function compileTestSuite(definition: string): Suite {
  if (
    definition.length > testSuiteMaxBytes ||
    new TextEncoder().encode(definition).length > testSuiteMaxBytes
  )
    fail("$", "Expected a bounded UTF-8 JSON definition");
  let value: unknown;
  try {
    value = JSON.parse(definition);
  } catch {
    fail("$", "Invalid JSON definition");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "name", "cases"].includes(key),
    )
  )
    fail("$", "Expected a version 1 suite");
  const suiteName = name(value.name, "$.name");
  if (
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > maxCases
  )
    fail("$.cases", "Configure 1 to 16 cases");
  const names = new Set<string>();
  const cases = value.cases.map((item: unknown, index) => {
    const path = "$.cases[" + index + "]";
    if (
      !isRecord(item) ||
      Object.keys(item).some(
        (key) => !["name", "sequence", "skip"].includes(key),
      ) ||
      !isRecord(item.sequence) ||
      (item.skip !== undefined && typeof item.skip !== "boolean")
    )
      fail(path, "Expected a named sequence with an optional skip flag");
    const caseName = name(item.name, path + ".name");
    if (names.has(caseName)) fail(path + ".name", "Case names must be unique");
    names.add(caseName);
    const definition = JSON.stringify(item.sequence);
    try {
      compileCommandSequence(definition);
    } catch (error) {
      if (!(error instanceof CommandSequenceError)) throw error;
      throw new CommandSequenceError(
        path + ".sequence" + error.path.slice(1),
        error.message,
      );
    }
    return { name: caseName, definition, skip: item.skip === true };
  });
  return { name: suiteName, cases };
}

export function runTestSuite<Operation extends AcceptedCase>(
  suite: Suite,
  access: SuiteAccess<Operation>,
  signal: AbortSignal,
  onProgress: (report: TestSuiteReport) => void,
  onCancellationError: (error: unknown) => void,
) {
  const startedAt = new Date().toISOString();
  const cases: CaseResult[] = [];
  let requested = false;
  let active: Operation | undefined;
  let preparation: AbortController | undefined;
  let cancellation: Promise<void> | undefined;

  function cancelActive() {
    if (!active || cancellation) return cancellation;
    cancellation = access.cancel(active, signal).catch((error: unknown) => {
      cancellation = undefined;
      if (!signal.aborted) onCancellationError(error);
    });
    return cancellation;
  }

  function stop() {
    requested = true;
    preparation?.abort();
    return cancelActive();
  }

  const finished = (async () => {
    const snapshot = () => ({ name: suite.name, startedAt, cases: [...cases] });
    let stopReason: string | undefined;
    for (const entry of suite.cases) {
      signal.throwIfAborted();
      const skipped = entry.skip
        ? "configured_skip"
        : (stopReason ?? (requested ? "stop_requested" : undefined));
      if (skipped) {
        cases.push({
          name: entry.name,
          status: "skipped",
          reason: skipped,
          elapsedMs: 0,
        });
        onProgress(snapshot());
        continue;
      }
      const start = performance.now();
      let startEventSeq: string | undefined;
      preparation = new AbortController();
      try {
        startEventSeq = await access.prepare(
          entry.definition,
          AbortSignal.any([signal, preparation.signal]),
        );
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw error;
      } finally {
        preparation = undefined;
      }
      if (requested || startEventSeq === undefined) {
        cases.push({
          name: entry.name,
          status: requested ? "skipped" : "unverified",
          reason: requested ? "stop_requested" : "scope_unverified",
          elapsedMs: Math.max(0, Math.round(performance.now() - start)),
        });
        stopReason = requested ? "stop_requested" : "previous_case_incomplete";
        onProgress(snapshot());
        continue;
      }
      let outcome: CaseOutcome;
      try {
        active = await access.invoke(entry.definition, startEventSeq, signal);
        signal.throwIfAborted();
        if (requested) void cancelActive();
        outcome = await access.observe(active, signal);
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw error;
        outcome = {
          status: "unverified",
          reason: active ? "result_unverified" : "admission_unverified",
        };
      }
      cases.push({
        name: entry.name,
        status: outcome.status,
        reason: outcome.reason,
        operationId: active?.operationId,
        elapsedMs: Math.max(0, Math.round(performance.now() - start)),
      });
      active = undefined;
      if (outcome.status !== "passed") stopReason = "previous_case_incomplete";
      else if (outcome.unresolvedReplies)
        stopReason = "previous_case_unresolved_replies";
      onProgress(snapshot());
    }
    return snapshot();
  })();
  return { finished, stop };
}

const statuses = [
  "passed",
  "failed",
  "cancelled",
  "skipped",
  "unverified",
] as const;
export function suiteCounts(report: TestSuiteReport) {
  const counts = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    unverified: 0,
  };
  let elapsedMs = 0;
  for (const item of report.cases) {
    counts[item.status]++;
    elapsedMs += item.elapsedMs;
  }
  return { ...counts, elapsedMs };
}

function escape(value: string) {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 9 ||
      point === 10 ||
      point === 13 ||
      (point >= 32 && point <= 0xd7ff) ||
      (point >= 0xe000 && point <= 0xfffd) ||
      point >= 0x10000
      ? character
      : "\ufffd";
  })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function suiteJUnit(report: TestSuiteReport) {
  const counts = suiteCounts(report);
  const entries = report.cases.map((entry) => {
    const reason = escape(entry.reason ?? entry.status);
    let details = "";
    switch (entry.status) {
      case "failed":
        details = '<failure message="' + reason + '"/>';
        break;
      case "unverified":
        details = '<error message="' + reason + '"/>';
        break;
      case "skipped":
      case "cancelled":
        details =
          '<skipped message="' + escape(entry.status) + ": " + reason + '"/>';
        break;
    }
    if (entry.operationId)
      details += "<system-out>" + escape(entry.operationId) + "</system-out>";
    return (
      '  <testcase classname="' +
      escape(report.name) +
      '" name="' +
      escape(entry.name) +
      '" time="' +
      (entry.elapsedMs / 1000).toFixed(3) +
      '">' +
      details +
      "</testcase>"
    );
  });
  const attributes =
    ' name="' +
    escape(report.name) +
    '" timestamp="' +
    escape(report.startedAt) +
    '" tests="' +
    report.cases.length +
    '" failures="' +
    counts.failed +
    '" errors="' +
    counts.unverified +
    '" skipped="' +
    (counts.skipped + counts.cancelled) +
    '" time="' +
    (counts.elapsedMs / 1000).toFixed(3) +
    '"';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite' +
    attributes +
    '>\n  <properties><property name="cancelled" value="' +
    counts.cancelled +
    '"/></properties>\n' +
    entries.join("\n") +
    "\n</testsuite>\n"
  );
}

export function suiteHtml(
  report: TestSuiteReport,
  history: readonly TestSuiteReport[],
) {
  const row = (cells: readonly string[]) =>
    "<tr>" +
    cells.map((cell) => "<td>" + escape(cell) + "</td>").join("") +
    "</tr>";
  const header = (cells: readonly string[]) =>
    "<thead><tr>" +
    cells.map((cell) => '<th scope="col">' + escape(cell) + "</th>").join("") +
    "</tr></thead>";
  const results = report.cases.map((entry) =>
    row([
      entry.name,
      entry.status,
      entry.reason ?? "",
      entry.operationId ?? "",
      String(entry.elapsedMs),
    ]),
  );
  const trends = history.map((sample) => {
    const counts = suiteCounts(sample);
    return row([
      sample.startedAt,
      ...statuses.map((status) => String(counts[status])),
      String(counts.elapsedMs),
    ]);
  });
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>' +
    escape(report.name) +
    "</title><h1>" +
    escape(report.name) +
    "</h1><p>" +
    escape(report.startedAt) +
    "</p>" +
    '<table id="cases"><caption>Cases</caption>' +
    header(["Case", "Status", "Reason", "Operation ID", "Milliseconds"]) +
    "<tbody>" +
    results.join("") +
    '</tbody></table><table id="history"><caption>Run history</caption>' +
    header(["Started (UTC)", ...statuses, "Milliseconds"]) +
    "<tbody>" +
    trends.join("") +
    "</tbody></table></html>"
  );
}
