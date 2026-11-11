#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { format } from "prettier";
import { buildEnvironment } from "./build-lib.mjs";
import { poolContractSchemas } from "./contract-schema-pool.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const EXPORTED_FILES = [
  "types.ts",
  "schemas.json",
  "catalog.json",
  "defaults.json",
  "fixtures.json",
];
const GENERATED_HEADER = "// Generated from Rust core DTOs. Do not edit.\n";

function parseArtifact(files, name) {
  const source = files.get(name);
  if (typeof source !== "string")
    throw new Error(`Missing Rust artifact: ${name}`);
  return JSON.parse(source);
}

/** Rust 导出 schema，Ajv 只在生成时编译；浏览器消费无外部依赖的 ESM。 */
export async function buildArtifacts(files) {
  const schemas = parseArtifact(files, "schemas.json");
  const fixtures = parseArtifact(files, "fixtures.json");
  const catalog = parseArtifact(files, "catalog.json");
  if (
    schemas.schemaVersion !== 1 ||
    schemas.protocolVersion !== "0.1" ||
    catalog.schemaVersion !== 1 ||
    catalog.protocolVersion !== "0.1" ||
    fixtures.schemaVersion !== 1
  )
    throw new Error("Unsupported Rust contract artifact version");
  const ajv = new Ajv({
    allErrors: true,
    inlineRefs: false,
    allowUnionTypes: true,
    ownProperties: true,
    code: { source: true, esm: true },
  });
  const names = Object.keys(schemas.schemas).sort();
  if (!names.includes("RpcReply")) throw new Error("Missing RpcReply schema");
  const pooled = poolContractSchemas(schemas.schemas);
  if (pooled) ajv.addSchema(pooled.schema);
  const entry = (name) => pooled?.entries[name] ?? name;
  for (const name of names) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
      throw new Error(`Invalid schema name: ${name}`);
    if (!pooled) ajv.addSchema(schemas.schemas[name], name);
  }
  for (const [group, expected] of [
    ["valid", true],
    ["invalid", false],
  ]) {
    for (const fixture of fixtures[group]) {
      const validate = ajv.getSchema(entry(fixture.schema));
      if (!validate)
        throw new Error(`Unknown fixture schema: ${fixture.schema}`);
      if (validate(fixture.value) !== expected) {
        throw new Error(
          `Rust fixture ${fixture.name} (${fixture.schema}) failed ${group} validation: ${ajv.errorsText(validate.errors)}`,
        );
      }
    }
  }
  const standalone = standaloneCode(
    ajv,
    Object.fromEntries(names.map((name) => [`validate${name}`, entry(name)])),
  );
  const bundled = await build({
    stdin: {
      contents: standalone,
      resolveDir: ROOT,
      sourcefile: "host-validators.mjs",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  if (
    Object.values(bundled.metafile.outputs).some(
      (output) => output.imports.length > 0,
    )
  ) {
    throw new Error(
      "Generated validators must not import runtime dependencies",
    );
  }
  const artifacts = new Map();
  for (const name of EXPORTED_FILES) {
    const source = files.get(name);
    if (typeof source !== "string")
      throw new Error(`Missing Rust artifact: ${name}`);
    artifacts.set(name, await format(source, { filepath: join(ROOT, name) }));
  }
  artifacts.set(
    "validators.mjs",
    await format(GENERATED_HEADER + bundled.outputFiles[0].text, {
      parser: "babel",
    }),
  );
  const declarations =
    GENERATED_HEADER +
    `import type { ${names.join(", ")} } from "./types.ts";\n` +
    names
      .map(
        (name) =>
          `export declare function validate${name}(value: unknown): value is ${name};`,
      )
      .join("\n");
  artifacts.set(
    "validators.d.mts",
    await format(declarations, { parser: "typescript" }),
  );
  return artifacts;
}

function exportRustContracts(directory, root) {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "-p",
      "serial-workbench-core",
      "--bin",
      "export-contracts",
      "--",
      "--out",
      directory,
    ],
    { cwd: root, env: buildEnvironment(), stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Rust contract export failed (${result.status ?? "signal"})`,
    );
}

async function entriesOrEmpty(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** check 模式仅在系统临时目录导出和编译，不创建或更新工作树文件。 */
export async function generateHostContracts({
  root = ROOT,
  check = false,
  exporter = exportRustContracts,
} = {}) {
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, "host-contracts-"));
  if (dirname(temporary) !== temporaryRoot) {
    throw new Error("Invalid contracts temporary directory");
  }
  try {
    await exporter(temporary, root);
    const exported = new Map(
      await Promise.all(
        EXPORTED_FILES.map(async (name) => [
          name,
          await readFile(join(temporary, name), "utf8"),
        ]),
      ),
    );
    const artifacts = await buildArtifacts(exported);
    const target = join(root, "packages/contracts/src/generated");
    const existing = await entriesOrEmpty(target);
    const changed = [];
    for (const [name, contents] of artifacts) {
      if (
        !existing.includes(name) ||
        (await readFile(join(target, name), "utf8")) !== contents
      )
        changed.push(name);
    }
    const obsolete = existing.filter((name) => !artifacts.has(name));
    if (check) return [...changed, ...obsolete].sort();
    await mkdir(target, { recursive: true });
    for (const [name, contents] of artifacts)
      await writeFile(join(target, name), contents, "utf8");
    for (const name of obsolete) await rm(join(target, name));
    return [];
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== "--check")) {
    throw new Error(
      "Usage: node scripts/generate-host-contracts.mjs [--check]",
    );
  }
  const changed = await generateHostContracts({
    check: args.includes("--check"),
  });
  if (changed.length > 0) {
    console.error(
      `Host contracts changed: ${changed.join(", ")}. Run pnpm contracts:generate and commit the result.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      args.includes("--check")
        ? "Host contracts are current."
        : "Generated Host contracts from Rust core DTOs.",
    );
}
