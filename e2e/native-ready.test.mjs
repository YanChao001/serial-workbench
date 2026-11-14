import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { remote } from "webdriverio";
import { waitForNativeDocument } from "./native-ready.mjs";

async function fixture(t, { timeout = 2000, fail, documents = [] } = {}) {
  const initialTimeouts = { script: 30000, pageLoad: 300000, implicit: 0 };
  const timeouts = { ...initialTimeouts };
  const probes = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    let value = null;
    response.setHeader("content-type", "application/json");
    if (request.url === "/session") {
      value = {
        sessionId: "native-startup-observer",
        capabilities: { browserName: "tauri", platformName: "fixture" },
      };
    } else if (request.url.endsWith("/timeouts")) {
      if (request.method === "POST") Object.assign(timeouts, payload);
      else value = timeouts;
    } else if (
      request.url.endsWith("/execute/sync") ||
      request.url.endsWith("/elements")
    ) {
      probes.push({ ...payload, scriptTimeout: timeouts.script });
      if (fail && probes.length === 1) {
        if (fail === "script timeout")
          await delay(Math.min(timeouts.script, 3000));
        response.statusCode = 500;
        value = { error: fail, message: "Fixture read failed", stacktrace: "" };
      } else if (request.url.endsWith("/elements")) {
        value = [{ "element-6066-11e4-a52e-4f735466cecf": "shell" }];
      } else {
        const state = documents.shift() ?? { label: "secondary", ipc: true };
        value = runInNewContext(
          `(function() { ${payload.script} }).apply(null, arguments)`,
          {
            arguments: payload.args,
            document: {
              querySelector: () => (state.root === false ? null : {}),
            },
            __TAURI_INTERNALS__: state.ipc
              ? {
                  invoke() {},
                  metadata: { currentWindow: { label: state.label } },
                }
              : undefined,
          },
        );
      }
    }
    response.end(JSON.stringify({ value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let client = null;
  t.after(async () => {
    try {
      await client?.deleteSession();
    } finally {
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
  client = await remote({
    hostname: "127.0.0.1",
    port: server.address().port,
    capabilities: {
      browserName: "tauri",
      "wdio:enforceWebDriverClassic": true,
    },
    waitforTimeout: timeout,
    waitforInterval: 20,
    connectionRetryCount: 0,
    logLevel: "silent",
  });
  return { client, probes, timeouts, initialTimeouts };
}

test("native startup can observe again after a lost read within its original deadline", async (t) => {
  const { client, probes, timeouts, initialTimeouts } = await fixture(t, {
    fail: "script timeout",
  });
  const started = performance.now();
  await waitForNativeDocument(client, "secondary");
  assert.ok(performance.now() - started < client.options.waitforTimeout);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((probe) => probe.scriptTimeout <= 1000));
  assert.deepEqual(timeouts, initialTimeouts);
});

test("native startup requires the requested document, shell and initialized IPC", async (t) => {
  const { client, probes, timeouts, initialTimeouts } = await fixture(t, {
    documents: [
      { label: "main", ipc: true },
      { label: "secondary", ipc: false },
      { label: "secondary", ipc: true, root: false },
      { label: "secondary", ipc: true },
    ],
  });
  await waitForNativeDocument(client, "secondary");
  assert.equal(probes.length, 4);
  assert.deepEqual(timeouts, initialTimeouts);
});

test("native startup still fails at the original deadline and restores script timeouts", async (t) => {
  const { client, timeouts, initialTimeouts } = await fixture(t, {
    timeout: 150,
    documents: Array.from({ length: 100 }, () => ({
      label: "main",
      ipc: true,
    })),
  });
  await assert.rejects(
    waitForNativeDocument(client, "secondary"),
    /Native document secondary did not initialize within 150ms/,
  );
  assert.deepEqual(timeouts, initialTimeouts);
});

test("native startup does not replay a read after a non-timeout driver failure", async (t) => {
  const { client, probes, timeouts, initialTimeouts } = await fixture(t, {
    fail: "invalid session id",
  });
  await assert.rejects(
    waitForNativeDocument(client, "secondary"),
    /Fixture read failed/,
  );
  assert.equal(probes.length, 1);
  assert.deepEqual(timeouts, initialTimeouts);
});
