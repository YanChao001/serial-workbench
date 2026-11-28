import { createHash } from "node:crypto";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 16 * 1024;
const MAX_LOG_ENTRIES = 128;
const MAX_RESULT_BYTES = 32 * 1024;

class ScriptFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function confirmedSource({ language, source, sourceSha256 }) {
  if (
    (language !== "js" && language !== "ts") ||
    typeof source !== "string" ||
    source.trim().length === 0 ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
  ) {
    throw new ScriptFailure(
      "INVALID_SCRIPT_SOURCE",
      "Script source must be nonempty JS or TS within the source budget",
    );
  }
  const digest = createHash("sha256")
    .update("serial-workbench-script-v1\0")
    .update(language)
    .update("\0")
    .update(source, "utf8")
    .digest("hex");
  if (sourceSha256 !== digest) {
    throw new ScriptFailure(
      "SCRIPT_SOURCE_CHANGED",
      "Script source differs from the confirmed snapshot",
    );
  }
  return language === "ts" ? stripTypeScriptTypes(source) : source;
}

function taskSerial() {
  let nextId = 1;
  let pending;
  let accepting = true;

  parentPort.on("message", (reply) => {
    if (
      reply?.kind !== "serial-result" ||
      !pending ||
      reply.id !== pending.id
    ) {
      return;
    }
    const request = pending;
    pending = undefined;
    if (reply.ok === true) {
      request.resolve(reply.value);
    } else {
      request.reject(
        new ScriptFailure(
          "SCRIPT_SERIAL_FAILED",
          typeof reply.message === "string"
            ? reply.message
            : "Serial operation failed",
        ),
      );
    }
  });

  function request(message) {
    if (!accepting || pending) {
      throw new ScriptFailure(
        "SCRIPT_SERIAL_UNAVAILABLE",
        "Wait for the current serial request to finish",
      );
    }
    const id = nextId++;
    const result = new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
    });
    pending.result = result;
    // A script that returns early still owns its in-flight request.
    result.catch(() => {});
    parentPort.postMessage({ ...message, id });
    return result;
  }

  const serial = Object.freeze({
    read(startEventSeq) {
      if (
        typeof startEventSeq !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
        BigInt(startEventSeq) > 18_446_744_073_709_551_615n
      ) {
        throw new ScriptFailure(
          "INVALID_SCRIPT_CURSOR",
          "Serial reads require a positive event sequence",
        );
      }
      return request({ kind: "serial-read", startEventSeq });
    },
    send(bytes) {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length === 0 ||
        bytes.length > 65_536
      ) {
        throw new ScriptFailure(
          "INVALID_SCRIPT_BYTES",
          "Serial writes require 1 to 65536 bytes",
        );
      }
      return request({
        kind: "serial-send",
        bytesBase64: Buffer.from(bytes).toString("base64"),
      });
    },
  });

  return {
    serial,
    finish() {
      accepting = false;
      return pending?.result;
    },
  };
}

async function execute(logs) {
  const { debugSourceUrl } = workerData;
  if (debugSourceUrl) {
    const [message] = await once(parentPort, "message");
    if (message?.kind !== "script-debug-start")
      throw new ScriptFailure(
        "SCRIPT_DEBUG_UNAVAILABLE",
        "Script debug startup was interrupted",
      );
  }
  const source =
    confirmedSource(workerData) +
    (debugSourceUrl ? "\n//# sourceURL=" + debugSourceUrl : "");
  const moduleUrl =
    "data:text/javascript;base64," +
    Buffer.from(source, "utf8").toString("base64");
  const module = await import(moduleUrl);
  if (typeof module.default !== "function") {
    throw new ScriptFailure(
      "INVALID_SCRIPT_ENTRY",
      "Script must export a default function",
    );
  }

  const task = taskSerial();
  let logBytes = 0;
  const api = Object.freeze({
    serial: task.serial,
    log(text) {
      if (typeof text !== "string") {
        throw new ScriptFailure(
          "INVALID_SCRIPT_LOG",
          "Script log entries must be text",
        );
      }
      logBytes += Buffer.byteLength(text, "utf8");
      if (logs.length >= MAX_LOG_ENTRIES || logBytes > MAX_LOG_BYTES) {
        throw new ScriptFailure(
          "SCRIPT_OUTPUT_LIMIT",
          "Script log budget exceeded",
        );
      }
      logs.push(text);
    },
    delay(ms) {
      if (!Number.isInteger(ms) || ms < 0 || ms > 2_147_483_647) {
        throw new ScriptFailure(
          "INVALID_SCRIPT_DELAY",
          "Script delay must be a valid millisecond timer interval",
        );
      }
      return setTimeout(ms);
    },
  });

  const result = await module.default(api);
  await task.finish();
  const json = JSON.stringify(result === undefined ? null : result);
  if (
    json === undefined ||
    Buffer.byteLength(json, "utf8") > MAX_RESULT_BYTES
  ) {
    throw new ScriptFailure(
      "SCRIPT_OUTPUT_LIMIT",
      "Script result exceeds the JSON result budget",
    );
  }
  return { kind: "completed", logs, value: JSON.parse(json) };
}

const logs = [];
try {
  parentPort.postMessage(await execute(logs));
} catch (error) {
  parentPort.postMessage({
    kind: "failed",
    ...(logs.length ? { logs } : {}),
    code:
      error instanceof ScriptFailure ? error.code : "SCRIPT_EXECUTION_FAILED",
    message:
      typeof error?.message === "string"
        ? error.message.slice(0, 512)
        : "Script execution failed",
  });
} finally {
  parentPort.close();
}
