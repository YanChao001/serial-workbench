import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const SERVER_NAME = "serial-workbench";
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

function sendMessage(response, model, call, index) {
  const block = call
    ? { type: "tool_use", name: call.name, id: `toolu_swb_${index}`, input: {} }
    : { type: "text", text: "" };
  const delta = call
    ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
    : { type: "text_delta", text: "Local acceptance fixture completed." };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, fields = {}) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
    );
  };
  event("message_start", {
    message: {
      type: "message",
      role: "assistant",
      id: `msg_swb_${index}`,
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  event("content_block_start", { index: 0, content_block: block });
  event("content_block_delta", { index: 0, delta });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event("message_stop");
  response.end();
}

// 网关只给出预设工具请求；目录和结果从产品自己的 stdio 连接及事件流取得。
function scriptedGateway(calls, rounds, failures) {
  return createServer(async (request, response) => {
    try {
      const endpoint = new URL(request.url, "http://localhost").pathname;
      if (endpoint === "/v1/messages/count_tokens") {
        request.resume();
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"input_tokens":123}');
        return;
      }
      if (endpoint !== "/v1/messages") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      const names = (message.tools ?? []).map((tool) => tool.name);
      const returned = new Set(
        message.messages
          .flatMap(({ content }) => content)
          .filter((part) => part?.type === "tool_result")
          .map((part) => part.tool_use_id),
      );
      const index = returned.size;
      const next = calls[index];
      const name = next && `${TOOL_PREFIX}${next.name}`;
      rounds.push({ index, names, returned: [...returned] });
      sendMessage(
        response,
        message.model,
        name && names.includes(name) ? { ...next, name } : null,
        index,
      );
    } catch (error) {
      failures.push(String(error));
      response.end();
    }
  });
}

async function run(inputPath) {
  const { claude, mcp, profile, calls } = JSON.parse(
    readFileSync(inputPath, "utf8"),
  );
  assert.ok([claude, mcp, profile].every(isAbsolute));
  const isolated = mkdtempDisposableSync(
    join(realpathSync.native(tmpdir()), "swb-terminal-product-"),
  );
  const rounds = [];
  const failures = [];
  const server = scriptedGateway(calls, rounds, failures);
  try {
    const configuration = join(isolated.path, "mcp.json");
    writeFileSync(
      configuration,
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: { command: mcp, args: ["--profile", profile] },
        },
      }),
    );
    const settings = join(isolated.path, "claude");
    mkdirSync(settings);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(ANTHROPIC_|CLAUDE|.*PROXY)|^SWB_TEST_/i.test(key),
      ),
    );
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: settings,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_TOOL_SEARCH: "false",
      ...(process.env.CLAUDE_CODE_GIT_BASH_PATH && {
        CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
      }),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_AUTH_TOKEN: "isolated-test-fixture",
    });
    const running = promisify(execFile)(
      claude,
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--model",
        "claude-sonnet-4-6",
        "--strict-mcp-config",
        "--mcp-config",
        configuration,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        `mcp__${SERVER_NAME}`,
        "--",
        "Run the Serial Workbench terminal acceptance fixture.",
      ],
      {
        cwd: isolated.path,
        env,
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    running.child.stdin.end();
    const { stdout, stderr } = await running;
    writeFileSync(`${inputPath}.stdout`, stdout, { flag: "wx" });
    writeFileSync(`${inputPath}.stderr`, stderr, { flag: "wx" });
    assert.deepEqual(failures, []);
    assert.ok(rounds.length > 0, "Claude Code never reached the local gateway");
    const events = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const init = events.find(
      ({ type, subtype }) => type === "system" && subtype === "init",
    );
    assert.equal(
      init?.mcp_servers.find(({ name }) => name === SERVER_NAME)?.status,
      "connected",
      "Claude Code did not connect to the actual MCP program",
    );
    const catalog = init.tools
      .filter((name) => name.startsWith(TOOL_PREFIX))
      .map((name) => name.slice(TOOL_PREFIX.length));
    const results = calls.map((_, index) => {
      const id = `toolu_swb_${index}`;
      const event = events.find(
        ({ message }) =>
          Array.isArray(message?.content) &&
          message.content.some(
            (part) => part.type === "tool_result" && part.tool_use_id === id,
          ),
      );
      assert.ok(
        event,
        `Missing product tool result ${id}: ${JSON.stringify(catalog)}`,
      );
      const result = event.message.content.find(
        (part) => part.tool_use_id === id,
      );
      return {
        error: result.is_error ?? false,
        text:
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
        value: event.tool_use_result?.structuredContent ?? null,
      };
    });
    return { catalog, results };
  } catch (error) {
    if (error.stdout)
      writeFileSync(`${inputPath}.stdout`, error.stdout, { flag: "wx" });
    if (error.stderr)
      writeFileSync(`${inputPath}.stderr`, error.stderr, { flag: "wx" });
    throw error;
  } finally {
    server.closeAllConnections();
    server.close();
    writeFileSync(
      `${inputPath}.gateway.json`,
      JSON.stringify({ rounds, failures }, null, 2),
      { flag: "wx" },
    );
    isolated.remove();
  }
}

console.log(JSON.stringify(await run(process.argv[2])));
