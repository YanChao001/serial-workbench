import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseAtResponse } from "../packages/plugin-sdk/examples/reference-protocol-fields/at-response.ts";
import { decodeModbusFrame } from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame.ts";

const examples = JSON.parse(
  readFileSync(
    new URL("../resources/examples/workbench/vectors.json", import.meta.url),
    "utf8",
  ),
);
const peer = fileURLToPath(
  new URL(
    "../resources/examples/workbench/swb-example-peer.mjs",
    import.meta.url,
  ),
);

function wire(format, value) {
  return format === "hex"
    ? Buffer.from(value.replaceAll(" ", ""), "hex")
    : Buffer.from(value + "\r\n", "ascii");
}

async function startPeer(t, mode) {
  const processHandle = spawn(process.execPath, [peer, mode, "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(processHandle, "exit");
  let errorText = "";
  processHandle.stderr.setEncoding("utf8").on("data", (chunk) => {
    errorText += chunk;
  });
  t.after(async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.kill();
    await exited;
  });
  const output = createInterface({ input: processHandle.stdout });
  const [description] = await Promise.race([
    once(output, "line"),
    exited.then(([exitCode]) => {
      throw new Error(
        `Peer exited before listening (${exitCode}): ${errorText}`,
      );
    }),
  ]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(description);
  assert.ok(match, description);
  return Number(match[1]);
}

async function transact(t, port, request, ignored) {
  const connection = createConnection({ host: "127.0.0.1", port });
  t.after(() => connection.destroy());
  const closed = once(connection, "close");
  const parts = [];
  connection.on("data", (chunk) => parts.push(chunk));
  await once(connection, "connect");
  connection.write(Buffer.concat([ignored, request.subarray(0, 2)]));
  await delay(30);
  assert.equal(parts.length, 0, "partial and unrelated input is silent");
  connection.end(Buffer.concat([request.subarray(2), request]));
  await closed;
  return Buffer.concat(parts);
}

for (const [mode, example] of Object.entries(examples)) {
  test(
    `${mode} project exchanges the displayed bytes over an independent peer`,
    {
      timeout: 8_000,
    },
    async (t) => {
      const port = await startPeer(t, mode);
      const request = wire(example.format, example.request);
      const response = wire(example.format, example.response);
      const ignored =
        example.format === "hex"
          ? Buffer.from("010300000002c40a", "hex")
          : wire("text", `NOT-${example.request}`);
      const expected = Buffer.concat([response, response]);
      assert.deepEqual(await transact(t, port, request, ignored), expected);
      assert.deepEqual(await transact(t, port, request, ignored), expected);
    },
  );
}

test("the production protocol decoders accept the AT and Modbus project samples", () => {
  const at = parseAtResponse(
    wire("text", examples.at.response).toString("ascii"),
    examples.at.request,
  );
  assert.equal(at.state, "complete");
  assert.deepEqual(
    at.lines.map(({ kind }) => kind),
    ["echo", "response", "result"],
  );

  const request = decodeModbusFrame(
    "rtu",
    "request",
    wire("hex", examples.modbus.request),
  );
  const response = decodeModbusFrame(
    "rtu",
    "response",
    wire("hex", examples.modbus.response),
  );
  assert.equal(request.packet.unitId, 1);
  assert.deepEqual(request.packet.pdu, {
    functionCode: 3,
    address: 0,
    quantity: 2,
  });
  assert.deepEqual(response.packet.pdu, {
    functionCode: 3,
    values: [4660, 42],
  });
});
