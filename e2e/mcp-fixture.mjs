import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

export async function startMcpFixture({ binary, profile, clientId, host }) {
  const child = spawn(binary, ["--profile", profile, "--client-id", clientId], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, SWB_DEV_EXPECTED_HOST_EXECUTABLE: host },
  });
  const exit = once(child, "close");
  void exit.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = lines[Symbol.asyncIterator]();
  let id = 0;
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  async function stop() {
    child.stdin.end();
    const stopped = await Promise.race([
      exit.then(
        () => true,
        () => true,
      ),
      setTimeout(5000, false, { ref: false }),
    ]);
    if (!stopped) {
      child.kill();
      await exit;
    }
    lines.close();
  }

  async function request(method, params) {
    const current = ++id;
    send({ method, params, id: current });
    for (;;) {
      const response = await Promise.race([
        responses.next(),
        setTimeout(15_000, undefined, { ref: false }).then(() => {
          throw new Error(`MCP timed out on ${method}`);
        }),
      ]);
      assert.ok(!response.done, `MCP exited during ${method}`);
      const message = JSON.parse(response.value);
      if (message.id !== current) continue;
      if (message.error)
        throw Object.assign(
          new Error(`MCP ${method} failed: ${message.error.message}`),
          { code: message.error.code },
        );
      assert.ok(message.result, `MCP ${method} returned no result`);
      return message.result;
    }
  }

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "serial-workbench-e2e", version: "1.0.0" },
    });
    send({ method: "notifications/initialized" });
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    stop,
    async call(name, target, params = {}, requestId = randomUUID()) {
      const reply = await request("tools/call", {
        name,
        arguments: { target, params, requestId },
      });
      if (reply.isError === true) {
        const { code } = JSON.parse(reply.content?.[0]?.text ?? "{}");
        throw Object.assign(
          new Error(`MCP tool ${name} failed: ${code ?? "unknown error"}`),
          { code },
        );
      }
      return reply.structuredContent;
    },
  };
}
