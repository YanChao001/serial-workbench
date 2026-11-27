import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { queryArgs } from "./cli-query.mjs";
import { startMcpFixture } from "./mcp-fixture.mjs";
import { spawnOwned, stopOwned, waitOwned } from "./process.mjs";

const [hostPath, cliPath, mcpPath, outputPath, mode, ...extra] =
  process.argv.slice(2);
assert.ok(
  hostPath &&
    cliPath &&
    mcpPath &&
    outputPath &&
    (mode === undefined || mode === "--loopback-roles") &&
    extra.length === 0,
  "Usage: node e2e/lan-route.mjs <Host> <CLI> <MCP> <new evidence directory> [--loopback-roles]",
);
const host = resolve(hostPath);
const cli = resolve(cliPath);
const mcp = resolve(mcpPath);
const output = resolve(outputPath);
await mkdir(output);
const temporary = await realpath(tmpdir());
const root = await mkdtemp(join(temporary, "swb-lan-route-"));
const profiles = { caller: join(root, "caller"), owner: join(root, "owner") };
const evidence = {
  environment: { platform: process.platform, arch: process.arch },
};
const commands = [];
const failures = [];
const ownedHosts = {};
let assistant;

async function runCli(role, args) {
  let response;
  try {
    response = await promisify(execFile)(
      cli,
      ["--profile", profiles[role], ...args, "--json"],
      {
        env: { ...process.env, SWB_DEV_EXPECTED_HOST_EXECUTABLE: host },
        timeout: 45_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    response = error;
  }
  const { stdout, stderr, code } = response;
  const value = JSON.parse(stdout || "null");
  commands.push({
    role,
    action: args[0],
    exit: code ?? 0,
    error: value?.error?.code,
    stderr,
  });
  return { value, code, stderr };
}

async function run(role, args, expectedError, expectedExit = 3) {
  const { value, code, stderr } = await runCli(role, args);
  if (expectedError) {
    assert.equal(code, expectedExit, stderr);
    assert.equal(value?.error?.code, expectedError, stderr);
  } else {
    assert.equal(code, undefined, stderr);
    assert.notEqual(value?.ok, false, value?.error?.code);
  }
  return value;
}

async function fixture(value) {
  const file = join(root, randomUUID() + ".json");
  await writeFile(file, JSON.stringify(value), { flag: "wx" });
  return file;
}

function grant(role, clientId, permissions, target) {
  return changeAuthorization(role, "authorize", {
    clientId,
    permissions,
    targets: [target],
  });
}

async function changeAuthorization(role, action, params) {
  const {
    result: { operation: accepted },
  } = await run(role, [action, "--params-json", await fixture(params)]);
  assert.equal(accepted.actionId, `auth.${action}`);
  const operation = await settled(role, accepted.operationId, [], {
    authorizationChanging: true,
  });
  assert.equal(operation.actionId, accepted.actionId);
  assert.equal(operation.result.kind, "authorization_changed");
}

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, label);
    await setTimeout(100);
  }
}

async function settled(
  role,
  operationId,
  route = [],
  { authorizationChanging = false } = {},
) {
  return until(async () => {
    const { value, code, stderr } = await runCli(role, [
      "operation",
      "get",
      operationId,
      ...route,
    ]);
    // 授权变更与查询响应并发时，Host 可能丢弃旧授权修订下的读取结果。
    if (
      authorizationChanging &&
      code === 3 &&
      value?.error?.code === "PERMISSION_DENIED"
    )
      return;
    assert.equal(code, undefined, stderr);
    assert.notEqual(value?.ok, false, value?.error?.code);
    const {
      result: { operation },
    } = value;
    assert.equal(operation.operationId, operationId);
    if (operation.state === "succeeded") return operation;
    assert.ok(
      ["queued", "running"].includes(operation.state),
      JSON.stringify(operation),
    );
  }, `Wait for ${role} operation ${operationId} to reach its terminal state`);
}

async function query(role, action, target, params, route = []) {
  return (
    await run(role, [
      ...queryArgs(action, await fixture(target), await fixture(params)),
      ...route,
    ])
  ).result.value;
}

async function invoke(
  role,
  action,
  target,
  params,
  context,
  requestId,
  route = [],
) {
  return (
    await run(role, [
      "invoke",
      action,
      "--target-json",
      await fixture(target),
      "--params-json",
      await fixture(params),
      "--request-context-json",
      context,
      "--request-id",
      requestId,
      ...route,
    ])
  ).result.operation;
}

const hostTarget = (hostId) => ({ hostId, kind: "host", id: hostId });
const cliId = "serial-workbench-cli";
const assistantName = "lan-verification-assistant";

async function discovery(role) {
  return JSON.parse(
    await readFile(join(profiles[role], "host-v0", "discovery.json"), "utf8"),
  );
}

async function openVirtualSession(role, peer) {
  const host = hostTarget(peer.hostId);
  await grant(
    role,
    cliId,
    ["metadata.read", "content.read", "device.modify"],
    host,
  );
  const context = join(root, role + "-context.json");
  const attachment = await run(role, ["context", "--out", context]);
  const device = { ...host, kind: "device", id: "virtual:echo" };
  const { serialConfiguration } = JSON.parse(
    await readFile(
      new URL(
        "../packages/contracts/src/generated/defaults.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const open = await invoke(
    role,
    "device.open",
    device,
    { configuration: serialConfiguration },
    context,
    randomUUID(),
  );
  const { sessionId, sessionEpoch } = (await settled(role, open.operationId))
    .result.value;
  return {
    attachment,
    session: {
      ...host,
      kind: "session",
      id: sessionId,
      sessionId,
      sessionEpoch,
    },
  };
}

function rawPage({ sessionId, sessionEpoch }, startEventSeq = "1") {
  return {
    sessionId,
    sessionEpoch,
    startEventSeq,
    maxEvents: "100",
    maxBytes: "262144",
  };
}

async function verifyRawTransfer({
  caller,
  owner,
  session,
  route,
  instanceEpoch,
  read,
  receipt,
  bytes,
}) {
  const complete = await until(async () => {
    const page = await query(caller, "stream.read", session, read, route);
    const tx = page.events.find(
      ({ kind, payload }) =>
        kind === "tx" && payload.operationId === receipt.operationId,
    );
    const rx = Buffer.concat(
      page.events
        .filter(({ kind }) => kind === "rx")
        .map(({ payload }) => Buffer.from(payload.bytesBase64, "base64")),
    );
    if (tx && rx.length >= bytes.length) {
      assert.deepEqual(tx.payload, receipt);
      assert.deepEqual(rx, bytes);
      return page;
    }
  }, "Wait for the actual TX receipt and Virtual Echo RX");

  assert.equal(complete.hasMore, false);
  assert.ok(complete.events.length > 1);
  assert.ok(
    complete.events.every(
      (event) =>
        event.hostId === session.hostId &&
        event.instanceEpoch === instanceEpoch &&
        event.sessionId === session.sessionId &&
        event.sessionEpoch === session.sessionEpoch,
    ),
  );
  assert.deepEqual(complete, await query(owner, "stream.read", session, read));

  const firstRead = { ...read, maxEvents: "1" };
  const first = await query(caller, "stream.read", session, firstRead, route);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.events, complete.events.slice(0, 1));
  assert.equal(first.nextEventSeq, complete.events[1].eventSeq);
  assert.deepEqual(
    first,
    await query(owner, "stream.read", session, firstRead),
  );

  const continuation = { ...read, startEventSeq: first.nextEventSeq };
  const rest = await query(caller, "stream.read", session, continuation, route);
  assert.deepEqual(rest, {
    events: complete.events.slice(1),
    nextEventSeq: complete.nextEventSeq,
    hasMore: false,
  });
  assert.deepEqual(
    rest,
    await query(owner, "stream.read", session, continuation),
  );
  return {
    rawSource: complete,
    rawPagination: {
      startEventSeq: read.startEventSeq,
      continuationEventSeq: first.nextEventSeq,
      nextEventSeq: rest.nextEventSeq,
      eventCount: complete.events.length,
    },
  };
}

async function checkListenerClosed(address) {
  const endpoint = new URL("tcp://" + address);
  const socket = createConnection({
    host: endpoint.hostname.replace(/^\[|\]$/g, ""),
    port: Number(endpoint.port),
  });
  try {
    await assert.rejects(
      once(socket, "connect", { signal: AbortSignal.timeout(5_000) }),
      { code: "ECONNREFUSED" },
    );
  } finally {
    socket.destroy();
  }
}

async function verifyLoopbackRoles() {
  evidence.mode = "virtual-echo-loopback-roles";
  evidence.hosts = {};
  evidence.cases = [];
  const hosts = {};
  for (const role of Object.keys(profiles)) {
    const owned = spawnOwned(host, ["--profile", profiles[role]], {
      logPath: join(output, role + "-host.log"),
    });
    ownedHosts[role] = owned;
    const ready = await until(
      async () => {
        assert.equal(
          owned.state.done,
          false,
          role + " Host exited before readiness",
        );
        try {
          return await discovery(role);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      },
      "Wait for " + role + " discovery",
    );
    assert.equal(ready.pid, owned.child.pid);
    const peer = (await run(role, ["lan", "status"])).result.localPeer;
    const { attachment, session } = await openVirtualSession(role, peer);
    assert.equal(peer.hostId, ready.hostId);
    assert.equal(attachment.instanceEpoch, ready.instanceEpoch);
    hosts[role] = { peer, attachment, session };
    evidence.hosts[role] = {
      pid: ready.pid,
      ...session,
      instanceEpoch: ready.instanceEpoch,
    };
  }
  assert.notEqual(evidence.hosts.caller.pid, evidence.hosts.owner.pid);
  assert.notEqual(hosts.caller.peer.hostId, hosts.owner.peer.hostId);

  const directions = [
    ["caller", "owner"],
    ["owner", "caller"],
  ];
  for (const [caller, owner] of directions) {
    await run(owner, [
      "lan",
      "--params-json",
      await fixture({
        kind: "setShares",
        peer: hosts[caller].peer,
        shares: [{ target: hosts[owner].session, access: "operate" }],
      }),
    ]);
    await grant(caller, cliId, ["lan.connect"], {
      hostId: hosts[caller].peer.hostId,
      kind: "swb:lan-peer",
      id: hosts[owner].peer.hostId,
    });
  }

  for (const [caller, owner] of directions) {
    const peer = ["--lan-peer", hosts[owner].peer.hostId];
    for (const missing of ["[fe80::1]:8022", "[fe80::1%0]:8022"]) {
      await run(owner, ["lan", "enable", missing], "LAN_SCOPE_REQUIRED", 2);
      await run(
        caller,
        [
          "context",
          "--out",
          join(root, "unexpected-unscoped-context.json"),
          ...peer,
          "--lan-address",
          missing,
        ],
        "LAN_SCOPE_REQUIRED",
        2,
      );
    }
  }

  for (const [family, bind] of [
    ["IPv4", "127.0.0.1:0"],
    ["IPv6", "[::1]:0"],
  ]) {
    for (const [caller, owner] of directions) {
      const { peer, session } = hosts[owner];
      const { address } = (await run(owner, ["lan", "enable", bind])).result
        .listener;
      assert.ok(address.startsWith(bind.slice(0, -1)), address);
      const route = ["--lan-peer", peer.hostId, "--lan-address", address];
      const attach = async (phase) => {
        const context = join(
          root,
          [family, caller, phase, "context.json"].join("-"),
        );
        const routed = await run(caller, [
          "context",
          "--out",
          context,
          ...route,
        ]);
        assert.equal(routed.hostId, peer.hostId);
        assert.equal(
          routed.instanceEpoch,
          hosts[owner].attachment.instanceEpoch,
        );
        assert.notEqual(routed.actorId, hosts[caller].attachment.actorId);
        return { routed, context };
      };
      const stopListener = async () => {
        assert.equal(
          (await run(owner, ["lan", "disable"])).result.listener.kind,
          "disabled",
        );
        await checkListenerClosed(address);
      };
      const transfer = async ({ context, routed }, read, phase) => {
        const bytes = Buffer.concat([
          Buffer.from([family, caller, phase].join(":")),
          Buffer.from([0, 13, 10, 255]),
        ]);
        const bytesBase64 = bytes.toString("base64");
        const operation = await invoke(
          caller,
          "session.tx",
          session,
          { bytesBase64, writeWaitMs: "1000" },
          context,
          randomUUID(),
          route,
        );
        const terminal = await settled(caller, operation.operationId, route);
        assert.equal(terminal.actorId, routed.actorId);
        assert.equal(terminal.executionHostId, peer.hostId);
        assert.deepEqual(terminal.target, session);
        assert.equal(terminal.result.kind, "tx");
        const receipt = terminal.result.value;
        assert.equal(receipt.outcome, "accepted");
        assert.equal(receipt.operationId, operation.operationId);
        assert.equal(receipt.sessionId, session.sessionId);
        assert.equal(receipt.sessionEpoch, session.sessionEpoch);
        assert.equal(receipt.bytesBase64, bytesBase64);
        assert.deepEqual(receipt.unknownRanges, []);
        const raw = await verifyRawTransfer({
          caller,
          owner,
          session,
          route,
          instanceEpoch: routed.instanceEpoch,
          read,
          receipt,
          bytes,
        });
        return { receipt, ...raw };
      };

      const initial = await attach("initial");
      const previous = evidence.cases.find((entry) => entry.caller === caller);
      if (previous) assert.equal(initial.routed.actorId, previous.actorId);
      const atTail = await query(
        owner,
        "stream.read",
        session,
        rawPage(session),
      );
      assert.equal(atTail.hasMore, false);
      const first = await transfer(
        initial,
        rawPage(session, atTail.nextEventSeq),
        "initial",
      );

      await stopListener();
      await run(
        caller,
        ["context", "--out", join(root, "stopped-context.json"), ...route],
        "LAN_CONNECTION_UNAVAILABLE",
        5,
      );
      const reopened = (await run(owner, ["lan", "enable", address])).result
        .listener;
      assert.deepEqual(reopened, { kind: "listening", address });
      const restored = await attach("restored");
      assert.equal(restored.routed.actorId, initial.routed.actorId);
      const retained = await settled(caller, first.receipt.operationId, route);
      assert.deepEqual(retained.result.value, first.receipt);
      const continuation = rawPage(session, first.rawPagination.nextEventSeq);
      assert.deepEqual(
        await query(caller, "stream.read", session, continuation, route),
        {
          events: [],
          nextEventSeq: continuation.startEventSeq,
          hasMore: false,
        },
      );
      const recovery = await transfer(restored, continuation, "restored");
      await stopListener();
      evidence.cases.push({
        family,
        caller,
        owner,
        address,
        actorId: initial.routed.actorId,
        ...first,
        remoteMatchesLocal: true,
        listenerClosed: true,
        recovery: {
          ...recovery,
          sameActor: true,
          sameSession: true,
          noUnexpectedWrites: true,
        },
      });
    }
  }
  for (const role of Object.keys(profiles)) {
    const ready = await discovery(role);
    assert.equal(ready.pid, evidence.hosts[role].pid);
    assert.equal(ready.instanceEpoch, evidence.hosts[role].instanceEpoch);
  }
}

async function verifyApplicationRoute() {
  const owner = (await run("owner", ["lan", "status"])).result.localPeer;
  const caller = (await run("caller", ["lan", "status"])).result.localPeer;
  evidence.pids = {
    caller: (await discovery("caller")).pid,
    owner: (await discovery("owner")).pid,
  };
  assert.notEqual(evidence.pids.caller, evidence.pids.owner);
  assert.notEqual(caller.hostId, owner.hostId);
  const ownerHost = hostTarget(owner.hostId);
  const { session } = await openVirtualSession("owner", owner);
  const { sessionId, sessionEpoch } = session;
  const read = rawPage(session);
  const { address } = (await run("owner", ["lan", "enable", "127.0.0.1:0"]))
    .result.listener;
  await run("owner", [
    "lan",
    "--params-json",
    await fixture({
      kind: "setShares",
      peer: caller,
      shares: [{ target: session, access: "operate" }],
    }),
  ]);
  await run("caller", [
    "lan",
    "--params-json",
    await fixture({
      kind: "setShares",
      peer: owner,
      shares: [],
    }),
  ]);
  const route = ["--lan-peer", owner.hostId, "--lan-address", address];
  await run(
    "caller",
    ["context", "--out", join(root, "denied.json"), ...route],
    "PERMISSION_DENIED",
  );
  const callerContext = await run("caller", [
    "context",
    "--out",
    join(root, "caller-local.json"),
  ]);
  const scope = {
    hostId: caller.hostId,
    kind: "swb:lan-peer",
    id: owner.hostId,
  };
  await grant("caller", cliId, ["lan.connect"], scope);
  const routedFile = join(root, "routed-context.json");
  const routed = await run("caller", [
    "context",
    "--out",
    routedFile,
    ...route,
  ]);
  assert.equal(routed.hostId, owner.hostId);
  assert.equal(routed.instanceEpoch, (await discovery("owner")).instanceEpoch);
  const payload = Buffer.from([0, 65, 13, 10, 255]);
  const serial = {
    bytesBase64: payload.toString("base64"),
    writeWaitMs: "1000",
  };
  const requestId = randomUUID();
  const tx = await invoke(
    "caller",
    "session.tx",
    session,
    serial,
    routedFile,
    requestId,
    route,
  );
  const cliTerminal = await settled("caller", tx.operationId, route);
  assert.equal(cliTerminal.actorId, routed.actorId);
  const retry = await invoke(
    "caller",
    "session.tx",
    session,
    serial,
    routedFile,
    requestId,
    route,
  );
  assert.equal(retry.operationId, tx.operationId);
  assert.equal(cliTerminal.result.kind, "tx");
  assert.equal(cliTerminal.result.value.operationId, tx.operationId);
  const { rawPagination } = await verifyRawTransfer({
    caller: "caller",
    owner: "owner",
    session,
    route,
    instanceEpoch: routed.instanceEpoch,
    read,
    receipt: cliTerminal.result.value,
    bytes: payload,
  });

  const mcpFixture = {
    binary: mcp,
    profile: profiles.caller,
    clientId: assistantName,
    host,
  };
  assistant = await startMcpFixture(mcpFixture);
  await assistant.stop();
  assistant = undefined;
  await grant("caller", assistantName, ["lan.connect"], scope);
  assistant = await startMcpFixture({
    ...mcpFixture,
    route: { hostId: owner.hostId, address },
  });
  const mcpTx = await assistant.call(
    "swb_session_x2E_tx",
    session,
    { bytesBase64: "Wg==", writeWaitMs: "1000" },
    { requestId },
  );
  assert.notEqual(mcpTx.actorId, tx.actorId);
  assert.notEqual(mcpTx.operationId, tx.operationId);
  const mcpTerminal = await settled("owner", mcpTx.operationId);
  assert.equal(mcpTerminal.requestId, requestId);
  const activity = await until(async () => {
    const snapshot = await query("owner", "state.snapshot", ownerHost, {
      scopeId: "host.activity",
    });
    return snapshot.state.items.find(
      ({ operationId, mcpClientId }) =>
        operationId === mcpTx.operationId && mcpClientId === assistantName,
    );
  }, "B observes named MCP operation");
  assert.equal(activity.actorId, mcpTx.actorId);
  const activityScope = "session-activity:" + sessionId;
  const available = await query("caller", "state.scopes", ownerHost, {}, route);
  assert.ok(
    available.scopes.some(
      ({ scopeId, target }) =>
        scopeId === activityScope && target.sessionEpoch === sessionEpoch,
    ),
  );
  assert.ok(available.scopes.every(({ target }) => target.id === sessionId));
  const remoteActivity = await query(
    "caller",
    "state.snapshot",
    session,
    { scopeId: activityScope },
    route,
  );
  assert.deepEqual(remoteActivity.state.items, [activity]);
  assert.equal(remoteActivity.state.pendingTakeover, undefined);
  await run(
    "caller",
    [
      "query",
      "state.snapshot",
      "--target-json",
      await fixture(ownerHost),
      "--params-json",
      await fixture({ scopeId: "host.activity" }),
      ...route,
    ],
    "PERMISSION_DENIED",
  );
  const beforeConfigure = await assistant.call("swb_session_x2E_get", session);
  const baudRate = "19200";
  const configuration = await assistant.call(
    "swb_session_x2E_configure",
    session,
    { requested: { ...beforeConfigure.configuration, baudRate } },
    { expectedRevision: beforeConfigure.revision },
  );
  await settled("owner", configuration.operationId);
  assert.equal(
    (await assistant.call("swb_session_x2E_get", session)).configuration
      .baudRate,
    baudRate,
  );
  assert.equal(
    (await query("owner", "session.get", session, {})).configuration.baudRate,
    baudRate,
  );
  await changeAuthorization("caller", "revoke", {
    actorId: callerContext.actorId,
    permissions: ["lan.connect"],
    targets: [scope],
  });
  await run(
    "caller",
    ["context", "--out", join(root, "revoked.json"), ...route],
    "PERMISSION_DENIED",
  );
  assert.equal(
    (await assistant.call("swb_session_x2E_get", session)).sessionId,
    sessionId,
  );
  await run("caller", [
    "lan",
    "--params-json",
    await fixture({ kind: "unpair", peer: owner }),
  ]);
  await until(async () => {
    try {
      await assistant.call("swb_session_x2E_get", session);
    } catch (error) {
      return [
        "UNAUTHENTICATED",
        "PERMISSION_DENIED",
        "LAN_AUTHENTICATION_FAILED",
      ].includes(error.code);
    }
  }, "A unpair closes the existing MCP route");
  assert.equal(
    (await query("owner", "session.get", session, {})).sessionId,
    sessionId,
  );
  Object.assign(evidence, {
    connection: {
      caller: caller.hostId,
      owner: owner.hostId,
      address,
      instanceEpoch: routed.instanceEpoch,
    },
    session,
    cli: {
      operationId: tx.operationId,
      actorId: tx.actorId,
      duplicateKeptOriginal: true,
      rxBytes: payload.length,
      rawPagination,
    },
    mcp: {
      operationId: mcpTx.operationId,
      actorId: mcpTx.actorId,
      activity: assistantName,
      observedOverSharedSession: true,
      hostWideActivityDenied: true,
      configuredBaudRate: baudRate,
      configurationOperationId: configuration.operationId,
    },
    deniedBeforeGrant: true,
    callerScopeRevoked: true,
    callerUnpairClosedMcp: true,
    ownerSessionPreserved: true,
  });
}
try {
  if (mode === "--loopback-roles") await verifyLoopbackRoles();
  else await verifyApplicationRoute();
} catch (error) {
  failures.push(error);
} finally {
  if (assistant) {
    try {
      await assistant.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  evidence.stopped = {};
  for (const role of Object.keys(profiles)) {
    const owned = ownedHosts[role];
    if (mode === "--loopback-roles" && !owned) continue;
    try {
      evidence.stopped[role] = (await run(role, ["host", "stop"])).stopped;
      assert.equal(evidence.stopped[role], true);
      if (owned) await waitOwned(owned, AbortSignal.timeout(10_000));
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await stopOwned(owned);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  evidence.binaries = Object.fromEntries(
    await Promise.all(
      [host, cli, mcp].map(async (binary) => [
        binary,
        createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
      ]),
    ),
  );
  if (failures.length === 0) {
    assert.equal(dirname(root), temporary);
    await rm(root, { recursive: true, force: true });
  } else {
    evidence.fixture = root;
  }
  evidence.errors = failures.map(String);
  evidence.passed = failures.length === 0;
  await writeFile(
    join(output, "commands.json"),
    JSON.stringify(commands, null, 2) + "\n",
  );
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
if (failures.length)
  throw new AggregateError(
    failures,
    "LAN application route verification failed",
  );
