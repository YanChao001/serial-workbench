import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addAbortSignal } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { spawnOwned, stopOwned, waitOwned } from "./process.mjs";

const [hostPath, cliPath, evidencePath] = process.argv.slice(2);
assert.ok(
  hostPath && cliPath && evidencePath,
  "Usage: node e2e/http-control.mjs <Host> <CLI> <new evidence directory>",
);
const host = resolve(hostPath);
const cli = resolve(cliPath);
const evidence = resolve(evidencePath);
assert.equal(
  dirname(host),
  dirname(cli),
  "Use Host and CLI from the same build",
);
await mkdir(evidence);
const temporary = resolve(tmpdir());
const root = await mkdtemp(join(temporary, "swb-http-control-"));
const profile = join(root, "profile");
const instances = [];
const execute = promisify(execFile);

async function operator(...args) {
  const { stdout } = await execute(
    cli,
    ["--profile", profile, ...args, "--json"],
    {
      env: { ...process.env, SWB_DEV_EXPECTED_HOST_EXECUTABLE: host },
      timeout: 15_000,
      windowsHide: true,
    },
  );
  const value = JSON.parse(stdout);
  assert.notEqual(value.ok, false, value.error?.code);
}

async function start() {
  const log = join(evidence, "host-" + (instances.length + 1) + ".log");
  const owned = spawnOwned(
    host,
    ["--profile", profile, "--http-control-stdio"],
    {
      logPath: log,
      privateStdout: true,
    },
  );
  const instance = { owned, log };
  instances.push(instance);
  let received = Buffer.alloc(0);
  for await (const chunk of addAbortSignal(
    AbortSignal.timeout(15_000),
    owned.child.stdout,
  )) {
    received = Buffer.concat([received, chunk]);
    assert.ok(
      received.length <= 2052,
      "HTTP bootstrap exceeded its size limit",
    );
    if (received.length < 4) continue;
    const length = received.readUInt32BE();
    assert.ok(length > 0 && length <= 2048, "Invalid HTTP bootstrap size");
    if (received.length < 4 + length) continue;
    assert.equal(
      received.length,
      4 + length,
      "Unexpected trailing bootstrap data",
    );
    const entry = JSON.parse(received.subarray(4).toString("utf8"));
    const url = new URL(entry.url);
    assert.equal(url.origin, "http://127.0.0.1:" + url.port);
    assert.ok(
      typeof entry.clientId === "string" &&
        typeof entry.credential === "string",
    );
    instance.entry = entry;
    return instance;
  }
  throw new Error("Host exited before returning an HTTP entry");
}

function post(entry, method, params, requestId = randomUUID()) {
  return fetch(entry.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: {
      authorization: "Bearer " + entry.credential,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ requestId, request: { method, params } }),
  });
}

async function rpc(reply, allowPendingGrant = false) {
  assert.equal(reply.status, 200);
  const payload = await reply.json();
  if (
    allowPendingGrant &&
    !payload.ok &&
    payload.error?.code === "PERMISSION_DENIED"
  )
    return null;
  assert.equal(payload.ok, true, payload.error?.message ?? payload.error?.code);
  return payload.result;
}

function attach(entry) {
  return post(entry, "host.attach", {
    supportedProtocolVersions: ["1.0"],
    clientKind: "cli",
    clientId: entry.clientId,
  });
}

async function deviceOpenVisible(
  entry,
  attachment,
  target,
  allowPendingGrant = false,
) {
  const requestId = randomUUID();
  const result = await rpc(
    await post(
      entry,
      "catalog.list",
      {
        protocolVersion: attachment.protocolVersion,
        hostId: attachment.hostId,
        instanceEpoch: attachment.instanceEpoch,
        actorId: attachment.actorId,
        requestId,
        actionId: "catalog.list",
        target,
        params: { pageSize: "100" },
        revealTarget: { pageId: "workbench" },
      },
      requestId,
    ),
    allowPendingGrant,
  );
  return result?.items.some(({ actionId }) => actionId === "device.open");
}

async function waitForDeviceOpen(entry, attachment, target, visible) {
  const deadline = performance.now() + 6_000;
  do {
    if ((await deviceOpenVisible(entry, attachment, target, true)) === visible)
      return;
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail(
    "CLI grant did not settle to the expected HTTP catalog visibility",
  );
}

async function expectListenerClosed(endpoint) {
  const url = new URL(endpoint);
  const socket = createConnection({
    host: url.hostname,
    port: Number(url.port),
  });
  socket.setTimeout(3_000, () =>
    socket.destroy(new Error("HTTP close probe deadline")),
  );
  try {
    await assert.rejects(once(socket, "connect"), { code: "ECONNREFUSED" });
  } finally {
    socket.destroy();
  }
}

async function changeGrant(command, identity, target) {
  const file = join(root, command + ".json");
  await writeFile(
    file,
    JSON.stringify({
      ...identity,
      permissions: ["device.modify"],
      targets: [target],
    }),
    { flag: "wx" },
  );
  await operator(command, "--params-json", file);
}

async function stop(instance) {
  await operator("host", "stop");
  await waitOwned(instance.owned, AbortSignal.timeout(10_000));
  await stopOwned(instance.owned);
  const log = await readFile(instance.log, "utf8");
  assert.ok(
    !log.includes(instance.entry.credential),
    "HTTP bootstrap appeared in a process log",
  );
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

let phase = "initial HTTP bootstrap";
try {
  const old = await start();
  phase = "initial HTTP attach and catalog";
  const before = await rpc(await attach(old.entry));
  assert.equal(before.clientId, old.entry.clientId);
  const target = { hostId: before.hostId, kind: "host", id: before.hostId };
  assert.equal(await deviceOpenVisible(old.entry, before, target), false);
  phase = "accept CLI grant and observe HTTP visibility";
  await changeGrant("authorize", { clientId: before.clientId }, target);
  await waitForDeviceOpen(old.entry, before, target, true);
  phase = "settle original Host and close listener";
  await stop(old);
  await expectListenerClosed(old.entry.url);

  phase = "restarted HTTP bootstrap";
  const current = await start();
  phase = "reject old credential at restarted listener";
  assert.ok(
    current.entry.credential !== old.entry.credential,
    "HTTP credential did not rotate",
  );
  const previousCredential = {
    ...current.entry,
    credential: old.entry.credential,
  };
  const forbidden = await attach(previousCredential);
  assert.equal(forbidden.status, 401);
  await forbidden.body?.cancel();

  phase = "reattach restored actor and confirm existing grant";
  const after = await rpc(await attach(current.entry));
  assert.equal(after.hostId, before.hostId);
  assert.equal(after.actorId, before.actorId);
  assert.equal(after.clientId, before.clientId);
  assert.equal(BigInt(after.instanceEpoch), BigInt(before.instanceEpoch) + 1n);
  assert.equal(await deviceOpenVisible(current.entry, after, target), true);
  phase = "accept CLI revocation and observe HTTP visibility";
  await changeGrant("revoke", { actorId: after.actorId }, target);
  await waitForDeviceOpen(current.entry, after, target, false);
  phase = "settle restarted Host";
  await stop(current);

  await writeFile(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        hostSha256: await digest(host),
        cliSha256: await digest(cli),
        oldEpoch: before.instanceEpoch,
        newEpoch: after.instanceEpoch,
        sameHostAndActor: true,
        credentialRotated: true,
        oldListenerClosed: true,
        approvedGrantSurvivedRestart: true,
        actualCliRevocation: true,
        bothProcessesExited: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  assert.equal(dirname(root), temporary);
  await rm(root, { recursive: true });
  console.log("HTTP control process receipt saved.");
} catch (error) {
  console.error(
    "HTTP control failed during " + phase + ". Profile preserved at " + profile,
  );
  throw error;
} finally {
  await Promise.all(instances.map(({ owned }) => stopOwned(owned)));
}
