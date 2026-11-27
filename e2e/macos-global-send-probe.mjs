import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withGlobalSendPeer } from "./global-send-peer.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_OS, "macOS");
const [helper, output] = process.argv.slice(2);
assert.ok(helper && output, "Expected the helper path and receipt directory");
const candidate = process.env.GITHUB_SHA ?? "";
assert.match(candidate, /^[0-9a-f]{40}$/i, "Expected a GitHub candidate SHA");
mkdirSync(output, { recursive: true });

const receipt = {
  candidate,
  architecture: process.arch,
  osRelease: osRelease(),
};

async function observe(command, timeout, reached) {
  const deadline = performance.now() + timeout;
  let state;
  do {
    state = await command("foreground");
    if (reached(state)) break;
    await delay(80);
  } while (performance.now() < deadline);
  return state;
}

try {
  await withGlobalSendPeer(
    helper,
    join(output, "input.log"),
    async (ready, command) => {
      receipt.ready = ready;
      assert.equal(
        ready.canPost,
        true,
        "The runner cannot post keyboard events",
      );
      await command("focus");
      receipt.foreground = await observe(
        command,
        5000,
        (state) => state.foreground,
      );
      assert.equal(
        receipt.foreground.foreground,
        true,
        "Calculator did not acquire foreground",
      );

      receipt.baseline = await command("observe-session");
      assert.equal(receipt.baseline.controlPresses, 0);
      assert.equal(receipt.baseline.controlReleases, 0);
      receipt.posted = await command("press-control");
      assert.equal(receipt.posted.foreground, true);
      receipt.observed = await observe(
        command,
        2000,
        (state) => state.controlPresses > 0 && state.controlReleases > 0,
      );
      assert.equal(
        receipt.observed.foreground,
        true,
        "Calculator lost foreground",
      );
      assert.equal(
        receipt.observed.controlPresses,
        1,
        "Expected one Carbon F10 press",
      );
      assert.equal(
        receipt.observed.controlReleases,
        1,
        "Expected one Carbon F10 release",
      );
    },
  );
  console.log("Carbon F10 press and release received");
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : String(error);
  console.error(receipt.failure);
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(output, "input.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
}
