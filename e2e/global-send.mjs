import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sessionScopes } from "./session-scopes.mjs";
import { hostQuery, nativeValue } from "./settings.mjs";

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
    const page = await query(
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
    // 专用 stream.read 方法的结果直接返回页。action.query 才使用 kind/value。
    assert.ok(Array.isArray(page.events), "Expected a Raw stream page");
    assert.equal(page.hasMore, false, "Unexpected extra Raw history");
    assert.ok(
      page.events.every(
        (event) =>
          event.hostId === attachment.hostId &&
          event.instanceEpoch === attachment.instanceEpoch &&
          event.sessionId === session.sessionId &&
          event.sessionEpoch === session.sessionEpoch,
      ),
    );
    return page;
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
