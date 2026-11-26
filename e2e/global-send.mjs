import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnOwned, stopOwned, waitOwned } from "./process.mjs";
import { sessionScopes } from "./session-scopes.mjs";
import { hostQuery, nativeValue } from "./settings.mjs";

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

export async function globalSendRawReader() {
  const { attachment, generation } = await nativeValue("host_attachment");
  const scopes = await hostQuery("state.scopes", "host");
  assert.equal(scopes.kind, "scopes");
  const open = [];
  for (const { target } of sessionScopes(scopes.value.scopes)) {
    const result = await query(
      "host_request",
      "action.query",
      "session.get",
      target,
      {},
    );
    assert.equal(result.kind, "session");
    if (
      result.value.deviceId === "virtual:echo" &&
      result.value.state === "open"
    )
      open.push({ target, session: result.value });
  }
  assert.equal(open.length, 1, "Expected one open Virtual Echo session");
  const [{ target: scope, session }] = open;
  const target = {
    ...scope,
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
  };
  const read = async (startEventSeq) => {
    const result = await query(
      "host_raw_request",
      "stream.read",
      "stream.read",
      target,
      {
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        startEventSeq,
        maxEvents: "100",
        maxBytes: "262144",
      },
    );
    assert.equal(result.kind, "stream_read");
    assert.equal(result.value.hasMore, false, "Unexpected extra Raw history");
    assert.ok(
      result.value.events.every(
        (event) =>
          event.hostId === attachment.hostId &&
          event.instanceEpoch === attachment.instanceEpoch &&
          event.sessionId === session.sessionId &&
          event.sessionEpoch === session.sessionEpoch,
      ),
    );
    return result.value;
  };
  const before = await query(
    "host_raw_request",
    "action.query",
    "stream.cursor",
    target,
    {},
  );
  assert.equal(before.kind, "stream_cursor");
  assert.equal(before.value.target.sessionId, session.sessionId);
  assert.equal(before.value.target.sessionEpoch, session.sessionEpoch);
  assert.equal(before.value.cursor.hostId, attachment.hostId);
  assert.equal(before.value.cursor.instanceEpoch, attachment.instanceEpoch);
  const firstEventSeq = (BigInt(before.value.cursor.position) + 1n).toString();
  return () => read(firstEventSeq);

  async function query(command, method, actionId, target, params) {
    const reply = await nativeValue(command, {
      generation,
      request: {
        method,
        params: {
          protocolVersion: attachment.protocolVersion,
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          actorId: attachment.actorId,
          requestId: randomUUID(),
          actionId,
          target,
          params,
          revealTarget: { pageId: "workbench" },
        },
      },
    });
    assert.equal(reply.ok, true, `${actionId}: ${reply.error?.code}`);
    return reply.result;
  }
}
