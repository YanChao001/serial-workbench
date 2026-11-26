import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnOwned, stopOwned, waitOwned } from "./process.mjs";

export async function withGlobalSendPeer(helper, logPath, work) {
  assert.ok(isAbsolute(helper), "Expected an absolute native helper path");
  const owned = spawnOwned(
    helper,
    process.platform === "win32" ? ["--global-send"] : [],
    { logPath, privateStdout: true, pipeStdin: true },
  );
  // 写入失败由回调交给当前请求，避免异步 EPIPE 漏出测试生命周期。
  owned.child.stdin.on("error", () => {});
  const reader = createInterface({ input: owned.child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  async function reply() {
    const timeout = new AbortController();
    try {
      const result = await Promise.race([
        lines.next(),
        delay(8000, null, { signal: timeout.signal, ref: false }).then(() => {
          throw new Error("Timed out waiting for the independent hotkey peer");
        }),
      ]);
      assert.equal(result.done, false, "The independent hotkey peer exited");
      return JSON.parse(result.value);
    } finally {
      timeout.abort();
    }
  }
  let failure;
  try {
    const ready = await reply();
    assert.equal(ready.ready, true);
    assert.equal(ready.pid, owned.child.pid);
    assert.equal(typeof ready.canPost, "boolean");
    await work(ready, async (command) => {
      await new Promise((complete, reject) => {
        owned.child.stdin.write(command + "\n", (error) =>
          error ? reject(error) : complete(),
        );
      });
      const response = await reply();
      assert.equal(response.ok, true, response.error);
      return response;
    });
  } catch (error) {
    failure = { error };
  }
  try {
    owned.child.stdin.end();
    try {
      await waitOwned(owned, AbortSignal.timeout(3000));
    } finally {
      reader.close();
      await stopOwned(owned);
    }
  } catch (error) {
    if (!failure) throw error;
    console.warn("Global shortcut peer cleanup failed", error);
  }
  if (failure) throw failure.error;
}
