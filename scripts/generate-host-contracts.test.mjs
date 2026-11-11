import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildArtifacts,
  generateHostContracts,
} from "./generate-host-contracts.mjs";

// 此处仅测试生成管线；真实 Rust fixture 另由 contracts 包的测试消费。
function exportedFiles() {
  return new Map([
    ["types.ts", "export type RpcReply = { value: string };\n"],
    [
      "defaults.json",
      JSON.stringify({ settings: {}, workspace: {}, serialConfiguration: {} }),
    ],
    [
      "schemas.json",
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: "0.1",
        schemas: {
          RpcReply: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { value: { type: "string", minLength: 2 } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      }),
    ],
    [
      "catalog.json",
      JSON.stringify({ schemaVersion: 1, protocolVersion: "0.1", actions: [] }),
    ],
    [
      "fixtures.json",
      JSON.stringify({
        schemaVersion: 1,
        valid: [{ name: "reply", schema: "RpcReply", value: { value: "😀x" } }],
        invalid: [
          { name: "short", schema: "RpcReply", value: { value: "😀" } },
        ],
      }),
    ],
  ]);
}

test("standalone validators run as browser ESM without Ajv runtime imports", async () => {
  const artifacts = await buildArtifacts(exportedFiles());
  assert.deepEqual([...artifacts.keys()].sort(), [
    "catalog.json",
    "defaults.json",
    "fixtures.json",
    "schemas.json",
    "types.ts",
    "validators.d.mts",
    "validators.mjs",
  ]);
  const directory = await mkdtemp(join(tmpdir(), "host-validators-test-"));
  const originalFunction = globalThis.Function;
  const originalEval = globalThis.eval;
  try {
    const output = join(directory, "validators.mjs");
    await writeFile(output, artifacts.get("validators.mjs"));
    globalThis.Function = () => {
      throw new Error("Runtime code generation is disabled");
    };
    globalThis.eval = () => {
      throw new Error("Runtime eval is disabled");
    };
    const { validateRpcReply } = await import(pathToFileURL(output).href);
    assert.equal(validateRpcReply({ value: "😀x" }), true);
    assert.equal(validateRpcReply({ value: "😀" }), false);
    assert.equal(validateRpcReply({ value: "ok", extra: true }), false);
    assert.match(artifacts.get("validators.d.mts"), /value is RpcReply/);
  } finally {
    globalThis.Function = originalFunction;
    globalThis.eval = originalEval;
    await rm(directory, { recursive: true, force: true });
  }
});

test("exported positive and negative fixtures are checked during generation", async () => {
  const files = exportedFiles();
  files.set(
    "fixtures.json",
    JSON.stringify({
      schemaVersion: 1,
      valid: [
        { name: "invalid-positive", schema: "RpcReply", value: { value: "x" } },
      ],
      invalid: [],
    }),
  );
  await assert.rejects(buildArtifacts(files), /invalid-positive/);
});

test("shared Rust definitions stay within the browser validator code budget", async () => {
  const files = exportedFiles();
  const properties = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z]+$" },
    ]),
  );
  const shared = {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  const root = {
    type: "object",
    properties: { value: { $ref: "#/definitions/Payload" } },
    required: ["value"],
    additionalProperties: false,
    definitions: { Payload: shared },
  };
  files.set(
    "schemas.json",
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: "0.1",
      schemas: Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [
          index ? `Reply${index}` : "RpcReply",
          root,
        ]),
      ),
    }),
  );
  files.set(
    "fixtures.json",
    JSON.stringify({ schemaVersion: 1, valid: [], invalid: [] }),
  );
  const artifacts = await buildArtifacts(files);
  const bytes = Buffer.byteLength(artifacts.get("validators.mjs"));
  assert.ok(
    bytes < 160_000,
    `Repeated schemas must not multiply startup parsing and source-map payloads (actual ${bytes} bytes)`,
  );
});

test("pooling preserves conflicting local definitions, recursion and literal $ref data", async () => {
  const files = exportedFiles();
  const root = (value) => ({
    type: "object",
    properties: {
      value: { $ref: "#/definitions/Wrapper" },
      literal: { const: { $ref: "#/definitions/Name" } },
      node: { $ref: "#/definitions/Node" },
    },
    required: ["value", "literal", "node"],
    additionalProperties: false,
    definitions: {
      Name: { const: value },
      Wrapper: { $ref: "#/definitions/Name" },
      Node: {
        type: "object",
        properties: { next: { $ref: "#/definitions/Node" } },
        additionalProperties: false,
      },
    },
  });
  files.set(
    "schemas.json",
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: "0.1",
      schemas: { RpcReply: root("one"), Other: root("two") },
    }),
  );
  files.set(
    "fixtures.json",
    JSON.stringify({ schemaVersion: 1, valid: [], invalid: [] }),
  );
  const artifacts = await buildArtifacts(files);
  const directory = await mkdtemp(join(tmpdir(), "host-validator-pool-test-"));
  try {
    const output = join(directory, "validators.mjs");
    await writeFile(output, artifacts.get("validators.mjs"));
    const { validateRpcReply, validateOther } = await import(
      pathToFileURL(output).href
    );
    const data = {
      value: "one",
      literal: { $ref: "#/definitions/Name" },
      node: { next: { next: {} } },
    };
    assert.equal(validateRpcReply(data), true);
    assert.equal(validateOther(data), false);
    assert.equal(validateOther({ ...data, value: "two" }), true);
    assert.equal(validateRpcReply({ ...data, value: "two" }), false);
    assert.equal(
      validateRpcReply({ ...data, node: { next: { unknown: true } } }),
      false,
    );
    assert.equal(
      validateRpcReply({
        ...data,
        literal: {
          $ref: "urn:serial-workbench:shared-contracts#/definitions/Name",
        },
      }),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the generator refuses fixture schema names absent from Rust schemas", async () => {
  const files = exportedFiles();
  files.set(
    "fixtures.json",
    JSON.stringify({
      schemaVersion: 1,
      valid: [{ name: "missing-schema", schema: "Missing", value: {} }],
      invalid: [],
    }),
  );
  await assert.rejects(buildArtifacts(files), /Missing/);
});

async function exportFixture(directory) {
  for (const [name, source] of exportedFiles()) {
    await writeFile(join(directory, name), source);
  }
}

test("check reports missing output without creating a generated directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-check-test-"));
  try {
    const changed = await generateHostContracts({
      root,
      check: true,
      exporter: exportFixture,
    });
    assert.deepEqual(changed, [
      "catalog.json",
      "defaults.json",
      "fixtures.json",
      "schemas.json",
      "types.ts",
      "validators.d.mts",
      "validators.mjs",
    ]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check compares every artifact and extra output without changing existing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-check-test-"));
  const target = join(root, "packages/contracts/src/generated");
  try {
    await mkdir(target, { recursive: true });
    await generateHostContracts({ root, exporter: exportFixture });
    assert.deepEqual(
      await generateHostContracts({
        root,
        check: true,
        exporter: exportFixture,
      }),
      [],
    );
    for (const name of await readdir(target)) {
      const original = await readFile(join(target, name), "utf8");
      await writeFile(join(target, name), "stale artifact\n");
      assert.deepEqual(
        await generateHostContracts({
          root,
          check: true,
          exporter: exportFixture,
        }),
        [name],
      );
      assert.equal(
        await readFile(join(target, name), "utf8"),
        "stale artifact\n",
      );
      await writeFile(join(target, name), original);
    }
    await writeFile(join(target, "catalog.json"), "stale catalog\n");
    await writeFile(join(target, "obsolete.ts"), "stale file\n");
    const before = await Promise.all(
      (await readdir(target)).map(async (name) => [
        name,
        await readFile(join(target, name), "utf8"),
      ]),
    );
    assert.deepEqual(
      await generateHostContracts({
        root,
        check: true,
        exporter: exportFixture,
      }),
      ["catalog.json", "obsolete.ts"],
    );
    const after = await Promise.all(
      (await readdir(target)).map(async (name) => [
        name,
        await readFile(join(target, name), "utf8"),
      ]),
    );
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
