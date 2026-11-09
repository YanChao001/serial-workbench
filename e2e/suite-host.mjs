import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitOwned } from "./process.mjs";

/** discovery 只用于核对本轮持有的 PID；就绪还必须通过 CLI 的正常认证。 */
export async function waitForSuiteHost(host, profile, signal, retiredPid) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (host.state.done || host.state.error)
      throw new Error("Owned Host exited before readiness");
    let record;
    try {
      record = JSON.parse(
        readFileSync(join(profile, "host-v0", "discovery.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    if (record) {
      if (record.pid !== host.child.pid && record.pid !== retiredPid)
        throw new Error("Suite profile belongs to an unexpected Host process");
      if (record.pid === host.child.pid) return;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error("Owned Host discovery did not become ready");
}

export async function waitForSuiteHostExit(host, signal) {
  await waitOwned(
    host,
    AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
  );
}

/** 只在本轮临时目录接受固定重启动作，进程所有权始终留在 runner。 */
export function serveSuiteHostRestarts(directory, restart) {
  let lastId;
  let pending;
  let failure;
  const timer = setInterval(() => {
    if (pending || failure) return;
    let request;
    try {
      request = JSON.parse(
        readFileSync(join(directory, "host-restart-request.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") failure = error;
      return;
    }
    if (request.id === lastId) return;
    if (
      request.action !== "restart" ||
      typeof request.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(request.id)
    ) {
      failure = new Error("Invalid suite Host restart request");
      return;
    }
    lastId = request.id;
    pending = (async () => {
      let response;
      try {
        response = { id: request.id, ok: true, ...(await restart()) };
      } catch (error) {
        failure = error;
        response = {
          id: request.id,
          ok: false,
          error: "Owned Host restart failed",
        };
      }
      writeFileSync(
        join(directory, "host-restart-response.json"),
        JSON.stringify(response),
      );
    })()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        pending = undefined;
      });
  }, 50);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      await pending;
      if (failure) throw failure;
    },
  };
}
