import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function implementation() {
  assert.ok(
    existsSync(new URL("./test-host-offline.mjs", import.meta.url)),
    "offline helper has not been implemented",
  );
  return import("./test-host-offline.mjs");
}

function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), "swb-offline-test-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, "network"));
  mkdirSync(join(output, "tmp"));
  const parent = {
    namespace: { target: "net:[100]", dev: 4, ino: 100 },
    uid: 1001,
    euid: 1001,
    gid: 1001,
    egid: 1001,
    groups: [1001, 121],
  };
  const snapshot = {
    ...structuredClone(parent),
    namespace: { target: "net:[200]", dev: 4, ino: 200 },
    capabilities: {
      CapInh: "0000",
      CapPrm: "0000",
      CapEff: "0000",
      CapAmb: "0000",
    },
    commands: Object.fromEntries(
      Object.entries({
        link: [{ ifname: "lo", flags: ["LOOPBACK"] }],
        address: [{ ifname: "lo", addr_info: [] }],
        ipv4: [],
        ipv6: [],
      }).map(([name, value]) => [
        name,
        { status: 0, signal: null, stdout: JSON.stringify(value), stderr: "" },
      ]),
    ),
  };
  return { output, parent, snapshot };
}

test("network gate rejects the parent's namespace and wrong restored identity", async (t) => {
  const { validateOfflineSnapshot } = await implementation();
  const { parent, snapshot } = fixture(t);
  assert.doesNotThrow(() => validateOfflineSnapshot(snapshot, parent));
  for (const change of [
    { namespace: parent.namespace },
    { uid: 0 },
    { euid: 0 },
    { gid: 0 },
    { egid: 0 },
    { groups: [1001] },
    { capabilities: { ...snapshot.capabilities, CapEff: "0001" } },
  ]) {
    assert.throws(
      () => validateOfflineSnapshot({ ...snapshot, ...change }, parent),
      /namespace|identity|capabilit/i,
    );
  }
});

test("network gate rejects enabled links, addresses, either route family and failed probes", async (t) => {
  const { validateOfflineSnapshot } = await implementation();
  const { parent, snapshot } = fixture(t);
  for (const [name, value] of [
    ["link", [{ ifname: "lo", flags: ["LOOPBACK", "UP"] }]],
    ["link", [{ ifname: "eth0", flags: ["UP"] }]],
    [
      "address",
      [{ ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1" }] }],
    ],
    ["ipv4", [{ dst: "default", gateway: "10.0.0.1" }]],
    ["ipv6", [{ dst: "default", gateway: "fe80::1" }]],
  ]) {
    const invalid = structuredClone(snapshot);
    invalid.commands[name].stdout = JSON.stringify(value);
    assert.throws(
      () => validateOfflineSnapshot(invalid, parent),
      /link|address|route/i,
    );
  }
  for (const result of [
    { status: 1, stdout: "[]", stderr: "permission denied" },
    { status: null, stdout: "[]", error: "ENOENT" },
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: "{}", stderr: "" },
  ]) {
    const invalid = structuredClone(snapshot);
    invalid.commands.ipv6 = result;
    assert.throws(
      () => validateOfflineSnapshot(invalid, parent),
      /probe|route|JSON|array/i,
    );
  }
});

test("namespace launcher uses literal argv and restores the recorded user without fork or shell", async () => {
  const { namespaceCommand } = await implementation();
  const command = namespaceCommand({
    tools: {
      sudo: "/usr/bin/sudo",
      unshare: "/usr/bin/unshare",
      setpriv: "/usr/bin/setpriv",
      env: "/usr/bin/env",
      node: "/opt/node 26/node",
    },
    parent: {
      uid: 1001,
      gid: 1001,
      user: "runner",
      path: "/opt/node 26:/usr/bin",
    },
    output: "/work/evidence;literal",
    helper: "/work/helper space.mjs",
  });
  assert.equal(command.command, "/usr/bin/sudo");
  assert.deepEqual(command.args, [
    "-n",
    "/usr/bin/unshare",
    "--net",
    "/usr/bin/setpriv",
    "--reuid=1001",
    "--regid=1001",
    "--init-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "/usr/bin/env",
    "-i",
    "PATH=/opt/node 26:/usr/bin",
    "HOME=/work/evidence;literal/home",
    "USER=runner",
    "LOGNAME=runner",
    "LC_ALL=C",
    "TMPDIR=/work/evidence;literal/tmp",
    "/opt/node 26/node",
    "/work/helper space.mjs",
    "--inside",
    "/work/evidence;literal",
  ]);
});

test("launcher preserves real child nonzero and spawn errors", async () => {
  const { waitForNamespace } = await implementation();
  const result = await waitForNamespace(
    process.execPath,
    ["-e", "process.exit(23)"],
    { stdio: "ignore" },
  );
  assert.equal(result.code, 23);
  assert.equal(result.signal, null);
  await assert.rejects(
    waitForNamespace(join(tmpdir(), "swb-absent-executable"), [], {
      stdio: "ignore",
    }),
    { code: "ENOENT" },
  );
});

test("launcher forwards an interrupt only to its held child and waits for close", async () => {
  const { waitForNamespace } = await implementation();
  const child = new EventEmitter();
  const signals = new EventEmitter();
  const sent = [];
  child.kill = (signal) => {
    sent.push(signal);
    return true;
  };
  const pending = waitForNamespace("held", [], {
    spawnChild: () => child,
    signals,
  });
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  signals.emit("SIGTERM");
  await Promise.resolve();
  assert.deepEqual(sent, ["SIGTERM"]);
  assert.equal(settled, false);
  child.emit("close", 143, null);
  assert.deepEqual(await pending, {
    code: 143,
    signal: null,
    interrupted: "SIGTERM",
  });
  signals.emit("SIGINT");
  assert.deepEqual(sent, ["SIGTERM"]);
});

test("child gate records failed isolation and never starts the wrapper", async (t) => {
  const { runIsolated } = await implementation();
  const { output, parent, snapshot } = fixture(t);
  snapshot.namespace = parent.namespace;
  let calls = 0;
  await assert.rejects(
    runIsolated(
      { output, parent, tools: {}, options: {} },
      {
        capture: () => snapshot,
        run: async () => {
          calls++;
        },
      },
    ),
    /namespace/i,
  );
  assert.equal(calls, 0);
  assert.equal(
    JSON.parse(readFileSync(join(output, "network/child-before.json")))
      .namespace.target,
    "net:[100]",
  );
});

test("child uses the real wrapper harness gate and preserves evidence on failure", async (t) => {
  const { runIsolated } = await implementation();
  const { output, parent, snapshot } = fixture(t);
  await assert.rejects(
    runIsolated(
      {
        output,
        parent,
        tools: {},
        options: {
          harness: join(output, "missing"),
          durationSeconds: 600,
          output: join(output, "scenarios"),
        },
      },
      { capture: () => snapshot },
    ),
    /harness/i,
  );
  assert.ok(existsSync(join(output, "network/child-after.json")));
  assert.equal(existsSync(join(output, "scenarios/summary.json")), false);
});

test("offline CLI preserves wrapper duration/options gates and refuses this Windows host", async (t) => {
  const { runOffline, parseOfflineOptions } = await implementation();
  const { output } = fixture(t);
  assert.throws(
    () => parseOfflineOptions(["--output", output, "--duration-seconds", "1"]),
    /600|duration/i,
  );
  assert.throws(
    () => parseOfflineOptions(["--output", output, "--skip", "T06"]),
    /unknown/i,
  );
  assert.throws(() => parseOfflineOptions(["--output", output]), /harness/i);
  if (process.platform !== "linux") {
    await assert.rejects(
      runOffline({ output, harness: "/abs/harness", durationSeconds: 600 }),
      /Linux.*CI/i,
    );
  }
});
