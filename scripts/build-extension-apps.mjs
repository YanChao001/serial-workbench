import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileFixture,
  extensionAppsSource as source,
  extensionAppsReferenceHost as referenceHost,
} from "./extension-apps-recipe.mjs";

export {
  extensionAppsEnvironment,
  extensionAppsRemapRules,
} from "./extension-apps-recipe.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inside(root, path) {
  const offset = relative(root, path);
  return (
    offset !== "" &&
    offset !== ".." &&
    !offset.startsWith(`..${sep}`) &&
    !isAbsolute(offset)
  );
}

async function sourceEntry(root, path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !inside(root, await realpath(path)))
    throw new Error(`SDK 测试扩展源码不得经过目录或文件链接：${path}`);
  return metadata;
}

async function sourceHashes(root) {
  root = await realpath(root);
  let directory = root;
  for (const part of source.split("/").filter(Boolean)) {
    directory = join(directory, part);
    if (!(await sourceEntry(root, directory)).isDirectory())
      throw new Error(`SDK 测试扩展源码需要普通目录：${directory}`);
  }
  const files = ["Cargo.toml", "Cargo.lock", "extension.json"].map((file) => [
    file,
    join(root, source, file),
  ]);
  files.push(["rust-toolchain.toml", join(root, "rust-toolchain.toml")]);
  if (!(await sourceEntry(root, join(root, "scripts"))).isDirectory())
    throw new Error("SDK 测试扩展构建规则需要普通目录");
  files.push([
    "extension-apps-recipe.mjs",
    join(root, "scripts/extension-apps-recipe.mjs"),
  ]);
  const uiDirectory = join(directory, "ui");
  if (!(await sourceEntry(root, uiDirectory)).isDirectory())
    throw new Error(`SDK 测试扩展界面需要普通目录：${uiDirectory}`);
  // The SDK fixture manifest declares this single document.
  files.push(["ui/main.html", join(uiDirectory, "main.html")]);

  async function rustSources(path, name) {
    const metadata = await sourceEntry(root, path);
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        await rustSources(join(path, entry), `${name}/${entry}`);
    } else if (name.endsWith(".rs")) {
      if (!metadata.isFile())
        throw new Error(`SDK 测试扩展源码需要普通文件：${path}`);
      files.push([name, path]);
    }
  }
  const rustDirectory = join(directory, "src");
  if (!(await sourceEntry(root, rustDirectory)).isDirectory())
    throw new Error(`SDK 测试扩展源码需要普通目录：${rustDirectory}`);
  await rustSources(rustDirectory, "src");
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(
    await Promise.all(
      files.map(async ([name, path]) => {
        if (!(await sourceEntry(root, path)).isFile())
          throw new Error(`SDK 测试扩展构建输入需要普通文件：${path}`);
        return [
          name,
          hash((await readFile(path, "utf8")).replace(/\r\n/g, "\n")),
        ];
      }),
    ),
  );
}

function sameSources(expected, sources) {
  return (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    Object.keys(expected).length === Object.keys(sources).length &&
    Object.entries(sources).every(([name, value]) => expected[name] === value)
  );
}

export async function buildExtensionApps(
  root,
  { check = false, rebuild = false, compileCheck = false } = {},
  { compile = compileFixture } = {},
) {
  if ((rebuild || compileCheck) && !check)
    throw new Error("--rebuild / --compile 需要与 --check 一起使用");
  if (rebuild && compileCheck)
    throw new Error("--rebuild 与 --compile 不能同时使用");
  const sources = await sourceHashes(root);
  const output = join(root, "resources/extensions/demo-apps.wasm");
  const receipt = join(root, "resources/extensions/demo-apps.json");
  if (check) {
    const expected = JSON.parse(await readFile(receipt, "utf8"));
    const committed = await readFile(output);
    if (
      !sameSources(expected.sources, sources) ||
      expected.referenceHost !== referenceHost ||
      expected.sha256 !== hash(committed)
    )
      throw new Error(
        "SDK 测试扩展源码、工具链、参考平台或模块变化，请运行 pnpm extension:fixtures:build 并提交测试资源",
      );
    if (rebuild || compileCheck) {
      const rebuilt = await compile(root, { referenceOnly: rebuild });
      if (!sameSources(sources, await sourceHashes(root)))
        throw new Error("构建期间 SDK 测试扩展源码发生变化，请重新构建");
      if (rebuild && !committed.equals(rebuilt))
        throw new Error(
          "重建的 SDK 测试扩展与提交的 Wasm 不一致，请重建并提交测试资源",
        );
    }
    if (rebuild)
      return "SDK 测试扩展在参考构建平台重建，与提交测试资源逐字节一致。";
    return compileCheck
      ? "SDK 测试扩展已真实编译并核对源码回执；此模式不作跨构建平台逐字节一致断言。"
      : "SDK 测试扩展源码与测试资源一致。";
  }
  const wasm = await compile(root, { referenceOnly: true });
  // Do not associate a successful build with sources edited while Cargo was running.
  if (!sameSources(sources, await sourceHashes(root)))
    throw new Error("构建期间 SDK 测试扩展源码发生变化，请重新构建");
  await mkdir(join(root, "resources/extensions"), { recursive: true });
  await writeFile(output, wasm);
  await writeFile(
    receipt,
    JSON.stringify({ referenceHost, sources, sha256: hash(wasm) }, null, 2) +
      "\n",
  );
  return `已生成 SDK 测试扩展：${wasm.length} 字节。`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--check", "--rebuild", "--compile"].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error(
      "用法：pnpm extension:fixtures:build | pnpm extension:fixtures:check [--rebuild | --compile]",
    );
  console.log(
    await buildExtensionApps(resolve(import.meta.dirname, ".."), {
      check: args.includes("--check"),
      rebuild: args.includes("--rebuild"),
      compileCheck: args.includes("--compile"),
    }),
  );
}
