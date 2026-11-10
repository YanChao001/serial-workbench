import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { remote } from "webdriverio";

test(
  "native WebDriver does not replay an accepted script after a script timeout",
  { timeout: 15000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "swb-webdriver-transport-"));
    t.after(() => rmSync(directory, { recursive: true }));
    const env = {
      ...process.env,
      STARTER_E2E_BINARY: join(directory, "unused.exe"),
      STARTER_E2E_DATA_ROOT: directory,
      STARTER_E2E_PORT: "1234",
      STARTER_E2E_PHASE: "fresh",
    };
    delete env.NODE_TEST_CONTEXT;
    const configuration = new URL("../wdio.conf.mjs", import.meta.url).href;
    const config = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const {config} = await import(${JSON.stringify(configuration)}); console.log(JSON.stringify(config));`,
        ],
        {
          cwd: directory,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
        },
      ),
    );
    let executions = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // 排空真实请求体，保证错误回复在命令被接纳之后发送。
      }
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/session") {
        response.end(
          JSON.stringify({
            value: {
              sessionId: "accepted-script-fixture",
              capabilities: {
                browserName: "tauri",
                browserVersion: "1",
                platformName: "fixture",
              },
            },
          }),
        );
      } else if (
        request.method === "POST" &&
        request.url.endsWith("/execute/sync")
      ) {
        executions++;
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            value: {
              error: "script timeout",
              message: "Fixture accepted the effect before timing out",
              stacktrace: "",
            },
          }),
        );
      } else response.end(JSON.stringify({ value: null }));
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
      ...config,
      hostname: "127.0.0.1",
      port: server.address().port,
      capabilities: config.capabilities[0],
      logLevel: "silent",
    });
    await assert.rejects(
      client.execute(() => "accepted effect"),
      /Fixture accepted the effect before timing out/,
    );
    assert.equal(
      executions,
      1,
      "A timed-out script may already have performed a Native effect and must not be replayed",
    );
  },
);
