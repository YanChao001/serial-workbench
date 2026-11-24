import { expect, it, vi } from "vitest";
import {
  compileTestSuite,
  runTestSuite,
  suiteHtml,
  suiteJUnit,
} from "./test-suite";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

const sequence = { version: 1, steps: [{ kind: "send", hex: "53" }] };
const plan = () =>
  compileTestSuite(
    JSON.stringify({
      version: 1,
      name: "<Bench&>",
      cases: [
        { name: "First", sequence },
        { name: "Second", sequence },
        { name: "Third", sequence },
      ],
    }),
  );

it("runs the ordered suite through real case results and exports observed failure and skip", async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ operationId: "op-1" })
    .mockResolvedValueOnce({ operationId: "op-2" });
  const observe = vi
    .fn()
    .mockResolvedValueOnce({ status: "passed" })
    .mockResolvedValueOnce({ status: "failed", reason: "response_timeout" });
  const run = runTestSuite(
    plan(),
    {
      prepare: async () => "1",
      invoke,
      observe,
      cancel: vi.fn(),
    },
    AbortSignal.timeout(5000),
    vi.fn(),
    vi.fn(),
  );
  const report = await run.finished;
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(
    report.cases.map(({ status, operationId }) => [status, operationId]),
  ).toEqual([
    ["passed", "op-1"],
    ["failed", "op-2"],
    ["skipped", undefined],
  ]);
  const xml = new DOMParser().parseFromString(
    suiteJUnit(report),
    "application/xml",
  );
  expect(xml.querySelector("parsererror")).toBeNull();
  expect(xml.documentElement.getAttribute("name")).toBe("<Bench&>");
  expect(xml.documentElement.getAttribute("tests")).toBe("3");
  expect(xml.querySelector("testcase > failure")?.getAttribute("message")).toBe(
    "response_timeout",
  );
  expect(xml.querySelectorAll("testcase > skipped")).toHaveLength(1);
  const html = new DOMParser().parseFromString(
    suiteHtml(report, [report]),
    "text/html",
  );
  expect(html.querySelector("script")).toBeNull();
  expect(html.querySelector("h1")?.textContent).toBe("<Bench&>");
  expect(html.querySelectorAll("#history tbody tr")).toHaveLength(1);
});

it("cancels only the admitted operation and labels cancellation from its observed terminal state", async () => {
  const admission = deferred<{ operationId: string }>();
  const terminal = deferred<{ status: "cancelled" }>();
  const invoke = vi.fn(() => admission.promise);
  const cancel = vi.fn(async () => {});
  const run = runTestSuite(
    plan(),
    {
      prepare: async () => "1",
      invoke,
      observe: () => terminal.promise,
      cancel,
    },
    AbortSignal.timeout(5000),
    vi.fn(),
    vi.fn(),
  );
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  await run.stop();
  expect(cancel).not.toHaveBeenCalled();
  admission.resolve({ operationId: "op-1" });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  await run.stop();
  terminal.resolve({ status: "cancelled" });
  const report = await run.finished;
  expect(report.cases.map(({ status }) => status)).toEqual([
    "cancelled",
    "skipped",
    "skipped",
  ]);
  expect(invoke).toHaveBeenCalledTimes(1);
  const xml = new DOMParser().parseFromString(
    suiteJUnit(report),
    "application/xml",
  );
  expect(
    xml.querySelector('property[name="cancelled"]')?.getAttribute("value"),
  ).toBe("1");
});

it("stops future cases when an accepted result is unverified or still has an unresolved reply", async () => {
  for (const observe of [
    vi.fn().mockRejectedValue(new Error("Connection dropped")),
    vi.fn().mockResolvedValue({ status: "passed", unresolvedReplies: true }),
  ]) {
    const invoke = vi.fn().mockResolvedValue({ operationId: "op-1" });
    const run = runTestSuite(
      plan(),
      { prepare: async () => "1", invoke, observe, cancel: vi.fn() },
      AbortSignal.timeout(5000),
      vi.fn(),
      vi.fn(),
    );
    const report = await run.finished;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report.cases[0]?.operationId).toBe("op-1");
    expect(report.cases.slice(1).map(({ status }) => status)).toEqual([
      "skipped",
      "skipped",
    ]);
  }
});

it("validates every case before a suite can be handed to the Host", () => {
  const value = JSON.stringify({
    version: 1,
    name: "Bench",
    cases: [
      { name: "First", sequence },
      {
        name: "Invalid",
        sequence: { version: 1, steps: [{ kind: "send", hex: "broken" }] },
      },
    ],
  });
  expect(() => compileTestSuite(value)).toThrow(
    /\$\.cases\[1\]\.sequence\.steps\[0\]\.hex/,
  );
});

it("stops during read-only preparation without admitting a case", async () => {
  const preflight = deferred<string>();
  const prepare = vi.fn(() => preflight.promise);
  const invoke = vi.fn();
  const run = runTestSuite(
    plan(),
    { prepare, invoke, observe: vi.fn(), cancel: vi.fn() },
    AbortSignal.timeout(5000),
    vi.fn(),
    vi.fn(),
  );
  await run.stop();
  preflight.resolve("23");
  const report = await run.finished;
  expect(invoke).not.toHaveBeenCalled();
  expect(report.cases.map(({ status }) => status)).toEqual([
    "skipped",
    "skipped",
    "skipped",
  ]);
});

const rowTemplate = {
  version: 1,
  variables: { prefix: "AA", id: "00" },
  steps: [
    {
      kind: "send",
      hex: "${prefix} ${id} ${payload}",
      expect: { hex: "${reply}" },
    },
  ],
};
function dataSuite(data: unknown, skip = false) {
  return JSON.stringify({
    version: 1,
    name: "Input rows",
    cases: [{ name: "Echo", sequence: rowTemplate, data, skip }],
  });
}

it("runs CSV rows in input order and reports physical source lines for every real outcome", async () => {
  const plan = compileTestSuite(
    dataSuite({
      csv: '\ufeffID,Payload,Reply\r\n1,"A,\r\n""B""",AA\r\n255,C,BB\r\n2,D,CC\r\n',
      bindings: {
        id: { column: "ID", type: "u8" },
        payload: { column: "Payload", type: "utf8" },
        reply: { column: "Reply", type: "hex" },
      },
    }),
  );
  expect(plan.cases.map(({ source }) => source)).toEqual([
    { kind: "csv", row: 2 },
    { kind: "csv", row: 4 },
    { kind: "csv", row: 5 },
  ]);
  const definitions: string[] = [];
  const run = runTestSuite(
    plan,
    {
      prepare: async () => "1",
      invoke: async (definition) => {
        definitions.push(definition);
        return { operationId: "row-" + definitions.length };
      },
      observe: async (op) =>
        op.operationId === "row-1"
          ? { status: "passed" }
          : { status: "failed" },
      cancel: async () => {},
    },
    new AbortController().signal,
    vi.fn(),
    vi.fn(),
  );
  const report = await run.finished;
  expect(
    definitions.map((definition) => JSON.parse(definition).variables),
  ).toEqual([
    { prefix: "AA", id: "01", payload: "41 2C 0D 0A 22 42 22", reply: "AA" },
    { prefix: "AA", id: "FF", payload: "43", reply: "BB" },
  ]);
  expect(
    report.cases.map(({ status, source }) => [status, source?.row]),
  ).toEqual([
    ["passed", 2],
    ["failed", 4],
    ["skipped", 5],
  ]);
  expect(suiteJUnit(report)).toContain("CSV line 4");
  expect(suiteHtml(report, [report])).toContain("CSV line 5");
  expect(suiteHtml(report, [report])).not.toContain("41 2C 0D 0A");
});

it("uses typed inline table values and rejects a malformed later row before handoff", () => {
  const data = {
    table: {
      columns: ["ID", "PAYLOAD", "ACK"],
      rows: [
        [128, "0A", "A0"],
        [2, "0B", "B0"],
      ],
    },
    bindings: {
      id: { column: "ID", type: "u8" },
      payload: { column: "PAYLOAD", type: "hex" },
      reply: { column: "ACK", type: "text" },
    },
  };
  expect(
    compileTestSuite(dataSuite(data)).cases.map(({ source }) => source),
  ).toEqual([
    { kind: "table", row: 1 },
    { kind: "table", row: 2 },
  ]);
  data.table.rows[1] = [256, "0B", "B0"];
  expect(() => compileTestSuite(dataSuite(data))).toThrow(
    /\.data\.table\[2\]\.id/,
  );
});

it("rejects duplicate CSV headers, missing bindings, unfinished quotes and excessive rounds", () => {
  const bindings = { id: { column: "ID", type: "u8" } };
  for (const csv of [
    "ID,ID\n1,2",
    "OTHER\n1",
    'ID\n"1',
    "ID\n" + Array(17).fill("1").join("\n"),
  ])
    expect(() => compileTestSuite(dataSuite({ csv, bindings }))).toThrow(
      /\.data/,
    );
});
