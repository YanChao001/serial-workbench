import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkNativeRequestDiagnostics } from "./native-log-evidence.mjs";

function fixture(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), "swb-native-log-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "native.log");
  const evidence = join(directory, "request-conflicts.json");
  if (contents !== undefined) writeFileSync(log, contents);
  return {
    log,
    evidence,
    read: () => JSON.parse(readFileSync(evidence, "utf8")),
  };
}

test("planned restart and permission diagnostics do not masquerade as request conflicts", (t) => {
  const f = fixture(
    t,
    "[INFO] Startup ready\n[ERROR][frontend] Host connection closed\n[ERROR][frontend] PERMISSION_DENIED\n",
  );
  const result = checkNativeRequestDiagnostics(f.log, f.evidence);
  assert.equal(result.passed, true);
  assert.equal(result.conflictWarnings, 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.read(), result);
});

test("a successful test reporter cannot hide conflicting Native deliveries", (t) => {
  const f = fixture(
    t,
    '[WARN][serial_workbench_client] RPC_REQUEST_CONFLICT {"channel":"control"}\n[ERROR][frontend] This request is already pending on the connection\n14 passing\n',
  );
  assert.throws(
    () => checkNativeRequestDiagnostics(f.log, f.evidence),
    /unexpected in-flight request conflict/,
  );
  assert.equal(f.read().passed, false);
  assert.equal(f.read().conflictWarnings, 1);
  assert.equal(f.read().frontendConflicts, 1);
  assert.equal("log" in f.read(), false);
});

test("missing and empty Native logs remain unobserved failures", (t) => {
  for (const contents of [undefined, ""]) {
    const f = fixture(t, contents);
    assert.throws(() => checkNativeRequestDiagnostics(f.log, f.evidence));
    assert.equal(f.read().passed, false);
    assert.equal(f.read().observed, false);
  }
});

test("a successful reporter cannot hide a Native subscription setup conflict", (t) => {
  const f = fixture(
    t,
    "[ERROR][frontend] Subscription request is already pending\n25 passing\n",
  );
  assert.throws(
    () => checkNativeRequestDiagnostics(f.log, f.evidence),
    /unexpected in-flight request conflict/,
  );
  assert.equal(f.read().passed, false);
  assert.equal(f.read().subscriptionConflicts, 1);
  assert.equal(f.read().conflictWarnings, 0);
  assert.equal(f.read().frontendConflicts, 0);
});

test("a cancelled caller cannot hide a Native subscription conflict warning", (t) => {
  const f = fixture(
    t,
    "[WARN] NATIVE_SUBSCRIPTION_CONFLICT first_data=42 second_data=42\n25 passing\n",
  );
  assert.throws(() => checkNativeRequestDiagnostics(f.log, f.evidence));
  assert.equal(f.read().subscriptionWarnings, 1);
  assert.equal(f.read().subscriptionConflicts, 0);
});
