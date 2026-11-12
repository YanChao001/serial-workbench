import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import test from "node:test";
import { stopHost } from "./host-stop.mjs";

test("explicit stop preserves profile selection but accepts an old authenticated Host runtime", async () => {
  const root = resolve("/project");
  const profile = resolve("/user data/profile");
  const child = new EventEmitter();
  const pending = stopHost(root, ["--profile", profile, "--json"], {
    env: {
      PATH: process.env.PATH,
      SWB_PROFILE: profile,
      SWB_DEV_EXPECTED_HOST_EXECUTABLE: "old-version-gate",
    },
    start(command, args, options) {
      assert.equal(command, "cargo");
      assert.deepEqual(args.slice(-5), [
        "host",
        "stop",
        "--profile",
        profile,
        "--json",
      ]);
      assert.equal(options.cwd, join(root, "src-tauri"));
      assert.equal(options.env.SWB_PROFILE, profile);
      assert.equal(options.env.SWB_DEV_EXPECTED_HOST_EXECUTABLE, undefined);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false, "stop must await the actual CLI outcome");
  child.emit("close", 0, null);
  assert.equal(await pending, 0);
});

test("failed cooperative stop is returned without retries or a force-kill fallback", async () => {
  const child = new EventEmitter();
  let launches = 0;
  const pending = stopHost(resolve("/project"), [], {
    start() {
      launches++;
      return child;
    },
  });
  child.emit("close", 5, null);
  assert.equal(await pending, 5);
  assert.equal(launches, 1);
});

test("interrupt and failed process creation remain explicit failures", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const child = new EventEmitter();
    const pending = stopHost(resolve("/project"), [], { start: () => child });
    child.emit("close", null, signal);
    assert.equal(await pending, signal === "SIGINT" ? 130 : 1);
  }
  const child = new EventEmitter();
  const pending = stopHost(resolve("/project"), [], { start: () => child });
  const reason = new Error("fixture startup failed");
  child.emit("error", reason);
  await assert.rejects(pending, (error) => error === reason);
});
