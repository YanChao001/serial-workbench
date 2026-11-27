import { createServer } from "node:net";

const examples = new Map([
  [
    "arduino",
    {
      request: Buffer.from("READ", "ascii"),
      response: Buffer.from("3.250\r\n", "ascii"),
    },
  ],
  [
    "at",
    {
      request: Buffer.from("AT+CREG?", "ascii"),
      response: Buffer.from("AT+CREG?\r\n+CREG: 0,1\r\nOK\r\n", "ascii"),
    },
  ],
  [
    "modbus",
    {
      request: Buffer.from("010300000002c40b", "hex"),
      response: Buffer.from("0103041234002a3f5a", "hex"),
      binary: true,
    },
  ],
]);

function accept(socket, { request, response, binary = false }) {
  let pending = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const last = binary ? request.length - 1 : pending.indexOf(0x0a);
      if (last < 0 || last >= pending.length) break;
      const payloadEnd = binary
        ? last + 1
        : pending[last - 1] === 0x0d
          ? last - 1
          : last;
      if (pending.subarray(0, payloadEnd).equals(request))
        socket.write(response);
      pending = pending.subarray(last + 1);
    }
    if (pending.length > 64) socket.destroy();
  });
}

const [mode, portText = "7411", ...rest] = process.argv.slice(2);
const example = examples.get(mode);
const port = Number(portText);
if (!example || !/^\d{1,5}$/.test(portText) || port > 65535 || rest.length) {
  console.error("Usage: node swb-example-peer.mjs <arduino|at|modbus> [port]");
  process.exitCode = 2;
} else {
  const server = createServer((socket) => accept(socket, example));
  server.maxConnections = 1;
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`${address.address}:${address.port}`);
  });
}
