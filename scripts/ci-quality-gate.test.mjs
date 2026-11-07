import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { qualityGateFailures } from "./ci-quality-gate.mjs";

function results() {
  return Object.fromEntries(
    ["frontend", "browser-smoke", "rust", "bindings", "desktop-e2e"].map(
      (job) => [job, { result: "success" }],
    ),
  );
}

test("a complete milestone passes and only an explicitly disabled desktop job may skip", () => {
  assert.deepEqual(qualityGateFailures(results()), []);
  const needs = results();
  needs["desktop-e2e"].result = "skipped";
  assert.equal(qualityGateFailures(needs).length, 1);
  assert.deepEqual(qualityGateFailures(needs, { desktopE2E: false }), []);
});

test("every required job rejects failure, cancellation, unexpected skip and absence", () => {
  for (const job of Object.keys(results())) {
    for (const result of ["failure", "cancelled", "timed_out", "skipped"]) {
      const needs = results();
      needs[job].result = result;
      assert.equal(qualityGateFailures(needs).length, 1, `${job}: ${result}`);
    }
    const missing = results();
    delete missing[job];
    assert.equal(qualityGateFailures(missing).length, 1, job);
  }
});

test("disabling desktop does not hide desktop failure, a missing job or skipped native checks", () => {
  for (const result of ["failure", "cancelled", "timed_out", undefined]) {
    const needs = results();
    needs["desktop-e2e"].result = result;
    assert.equal(qualityGateFailures(needs, { desktopE2E: false }).length, 1);
  }
  for (const job of ["frontend", "browser-smoke", "rust", "bindings"]) {
    const needs = results();
    needs[job].result = "skipped";
    needs.changes = {
      result: "success",
      outputs: { docs_only: "true", rust_required: "false", reused_run: "123" },
    };
    assert.equal(qualityGateFailures(needs, { desktopE2E: false }).length, 1);
  }
  assert.throws(() => qualityGateFailures(results(), { desktopE2E: "false" }));
});

test("the CLI accepts boolean strings and fails on malformed input or failed needs", () => {
  const run = (env) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./ci-quality-gate.mjs", import.meta.url))],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, CI_NEEDS: JSON.stringify(results()), ...env },
      },
    );
  assert.equal(run({ CI_DESKTOP_E2E: "true" }).status, 0);
  const needs = results();
  needs["desktop-e2e"].result = "skipped";
  assert.equal(
    run({ CI_DESKTOP_E2E: "false", CI_NEEDS: JSON.stringify(needs) }).status,
    0,
  );
  for (const value of ["", "False", "0", "not-a-boolean"]) {
    assert.equal(run({ CI_DESKTOP_E2E: value }).status, 1);
  }
  assert.equal(run({ CI_DESKTOP_E2E: "true", CI_NEEDS: "invalid" }).status, 1);
  needs.rust.result = "failure";
  const result = run({
    CI_DESKTOP_E2E: "false",
    CI_NEEDS: JSON.stringify(needs),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required check rust did not pass: failure/);
});
