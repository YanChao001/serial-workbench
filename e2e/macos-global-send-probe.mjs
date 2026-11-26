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
  routes: [],
};

for (const [route, stimulus] of [
  ["hid", "press-control"],
  ["session", "press-control-session"],
]) {
  const observation = { route, delivered: false };
  receipt.routes.push(observation);
  try {
    // 每条路径使用新进程和独立的注册，上一条路径的回调不能计入下一条。
    await withGlobalSendPeer(
      helper,
      join(output, `${route}.log`),
      async (ready, command) => {
        observation.ready = ready;
        assert.equal(
          ready.canPost,
          true,
          "The runner cannot post keyboard events",
        );
        await command("focus");
        const focusDeadline = performance.now() + 5000;
        do {
          observation.foreground = await command("foreground");
          if (observation.foreground.foreground) break;
          await delay(80);
        } while (performance.now() < focusDeadline);
        assert.equal(
          observation.foreground.foreground,
          true,
          "Calculator did not acquire foreground",
        );

        observation.baseline = await command("observe-session");
        assert.equal(observation.baseline.controlPresses, 0);
        assert.equal(observation.baseline.controlReleases, 0);
        observation.posted = await command(stimulus);
        assert.equal(observation.posted.foreground, true);
        const deliveryDeadline = performance.now() + 1500;
        do {
          observation.observed = await command("foreground");
          if (
            observation.observed.controlPresses &&
            observation.observed.controlReleases
          )
            break;
          await delay(80);
        } while (performance.now() < deliveryDeadline);
        assert.equal(
          observation.observed.foreground,
          true,
          "Calculator lost foreground",
        );
        assert.equal(
          observation.observed.controlPresses,
          1,
          "Expected one Carbon F10 press",
        );
        assert.equal(
          observation.observed.controlReleases,
          1,
          "Expected one Carbon F10 release",
        );
      },
    );
    observation.delivered = true;
  } catch (error) {
    observation.failure =
      error instanceof Error ? error.message : String(error);
  }
}

writeFileSync(
  join(output, "input.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
for (const { route, failure } of receipt.routes) {
  console.log(
    `${route}: ${failure ?? "Carbon F10 press and release received"}`,
  );
}
if (!receipt.routes.some(({ delivered }) => delivered)) process.exitCode = 1;
