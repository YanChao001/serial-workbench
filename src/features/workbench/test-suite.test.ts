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
