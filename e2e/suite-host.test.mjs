import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serveSuiteHostRestarts, waitForSuiteHost } from "./suite-host.mjs";

test("suite restarts are serialized and duplicate requests never start another Host", async (t) => {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, "suite-control-"));
  let calls = 0;
  const service = serveSuiteHostRestarts(directory, async () => {
    calls++;
    await delay(75);
    return { pid: process.pid, instanceEpoch: String(calls) };
  });
  t.after(async () => {
    await service.close();
    assert.equal(dirname(directory), base);
    rmSync(directory, { recursive: true, force: true });
  });
  const id = "00000000-0000-4000-8000-000000000001";
  writeFileSync(
    join(directory, "host-restart-request.json"),
    JSON.stringify({ action: "restart", id }),
  );
  let response;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      response = JSON.parse(
        readFileSync(join(directory, "host-restart-response.json"), "utf8"),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  assert.deepEqual(response, {
    id,
    ok: true,
    pid: process.pid,
    instanceEpoch: "1",
  });
  await delay(125);
  assert.equal(calls, 1);
});

test("suite readiness requires discovery to name the owned Host and refuses early exit", async (t) => {
  const base = realpathSync(tmpdir());
  const profile = mkdtempSync(join(base, "suite-host-"));
  t.after(() => {
    assert.equal(dirname(profile), base);
    rmSync(profile, { recursive: true, force: true });
  });
  mkdirSync(join(profile, "host-v0"));
  const host = {
    state: { done: false, error: null },
    child: { pid: process.pid },
  };
  writeFileSync(
    join(profile, "host-v0/discovery.json"),
    JSON.stringify({ pid: process.pid + 1 }),
  );
  await assert.rejects(waitForSuiteHost(host, profile), /unexpected Host/);
  writeFileSync(
    join(profile, "host-v0/discovery.json"),
    JSON.stringify({ pid: process.pid }),
  );
  await waitForSuiteHost(host, profile);
  host.state.done = true;
  await assert.rejects(waitForSuiteHost(host, profile), /exited before/);
  const controller = new AbortController();
  controller.abort(new Error("suite cancelled"));
  await assert.rejects(
    waitForSuiteHost(host, profile, controller.signal),
    /suite cancelled/,
  );
});
