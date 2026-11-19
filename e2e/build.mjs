import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildEnvironment,
  effectiveConfig,
  mainCargoBinary,
  parseBuildArgs,
  safeBinaryName,
} from "../scripts/build-lib.mjs";
import { fileSha256 } from "../scripts/artifact-lib.mjs";
import { COMPONENTS } from "../scripts/components-build.mjs";
import { buildNodeRuntime } from "../scripts/node-runtime-build.mjs";
import {
  inspectNodeRuntimeLayout,
  stageNodeRuntime,
} from "../scripts/node-runtime-layout.mjs";

const require = createRequire(import.meta.url);
export const root = resolve(import.meta.dirname, "..");
const targetDirectory = join(root, "src-tauri", "target", "e2e");
const receiptPath = join(targetDirectory, "build.json");
const TERMINAL_TOOLS = ["sign_reference_terminal", "terminal_capture_check"];

function binaryPath(output, target, name) {
  return join(output, `${name}${target.includes("-windows-") ? ".exe" : ""}`);
}

function binaryReceipts(names, output, target) {
  return names.map((name) => {
    const path = binaryPath(output, target, name);
    return { name, path, sha256: fileSha256(path) };
  });
}

function binariesMatch(receipts, names, output, target) {
  return (
    Array.isArray(receipts) &&
    receipts.length === names.length &&
    names.every((name) => {
      const entry = receipts.find((item) => item?.name === name);
      const path = binaryPath(output, target, name);
      return (
        entry?.path === path &&
        existsSync(path) &&
        fileSha256(path) === entry.sha256
      );
    })
  );
}

export function e2eSourceIdentity(projectRoot = root) {
  const gitlinks = new Map(
    execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    })
      .split("\0")
      .flatMap((entry) => {
        const match = entry.match(/^160000 ([a-f\d]+) 0\t([\s\S]+)$/);
        return match ? [[match[2], match[1]]] : [];
      }),
  );
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, encoding: "utf8", windowsHide: true },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolute = join(projectRoot, path);
    const present = existsSync(absolute);
    const directory = present && lstatSync(absolute).isDirectory();
    const gitlink = gitlinks.get(path);
    let identity = null;
    if (
      gitlink &&
      (!present ||
        (directory &&
          !existsSync(join(absolute, ".git")) &&
          readdirSync(absolute).length === 0))
    ) {
      // checkout 默认不初始化子模块；不能让 git 向上查找后误取主仓库 HEAD。
      identity = gitlink;
    } else if (present) {
      if (directory) {
        if (!existsSync(join(absolute, ".git")))
          throw new Error(`无法识别 E2E 源目录身份：${path}`);
        identity = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: absolute,
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      } else identity = fileSha256(absolute);
    }
    hash.update(JSON.stringify([path, identity]));
  }
  return hash.digest("hex");
}

function runBuild(command, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(`E2E build failed (${code})`)),
    );
  });
}

export function e2eBuildArgs(
  target,
  packageName,
  { withNodeRuntime = false } = {},
) {
  return [
    "build",
    "--debug",
    "--no-bundle",
    "--target",
    target,
    "--features",
    "e2e",
    "--config",
    "src-tauri/tauri.e2e.conf.json",
    "--",
    "--locked",
    "--package",
    packageName,
    // Tauri CLI 已提供 --bins，透传部分只补同图构建的相邻包。
    ...COMPONENTS.flatMap((name) => ["--package", name]),
    ...(withNodeRuntime
      ? TERMINAL_TOOLS.flatMap((name) => ["--example", name])
      : []),
  ];
}

/** 平台配置与 E2E 覆盖都可能重命名程序，不能只猜 Cargo package 的名称。 */
export function e2eExecutable(projectRoot, target, pkg) {
  const platform = target.includes("-windows-")
    ? "windows"
    : target.endsWith("-apple-darwin")
      ? "macos"
      : "linux";
  const config = effectiveConfig(
    projectRoot,
    parseBuildArgs(["--config", "src-tauri/tauri.e2e.conf.json"]),
    pkg.version,
    platform,
  );
  const binary = safeBinaryName(
    config.mainBinaryName ?? mainCargoBinary(pkg).name,
  );
  return join(
    projectRoot,
    "src-tauri",
    "target",
    "e2e",
    target,
    "debug",
    `${binary}${platform === "windows" ? ".exe" : ""}`,
  );
}

export async function buildE2E({ withNodeRuntime = false } = {}) {
  const env = { ...buildEnvironment(), CARGO_TARGET_DIR: targetDirectory };
  const source = e2eSourceIdentity();
  const host = execFileSync("rustc", ["-vV"], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
  })
    .match(/^host: (.+)$/m)?.[1]
    ?.trim();
  if (!host || !/^[a-zA-Z0-9_-]+$/.test(host))
    throw new Error("无法读取本机 Rust target");
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1", "--locked"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
      },
    ),
  );
  const pkg = metadata.packages.find(
    (item) =>
      resolve(item.manifest_path) === join(root, "src-tauri", "Cargo.toml"),
  );
  if (!pkg) throw new Error("未找到应用 Cargo package");
  const executable = e2eExecutable(root, host, pkg);
  const output = dirname(executable);
  const runtimePlan = { root, target: host, env, metadata };
  const runtime = withNodeRuntime ? await buildNodeRuntime(runtimePlan) : null;
  if (runtime) {
    delete env.SWB_NODE_RUNTIME_BUILD_IMAGE;
    if (runtime.imageBinding)
      env.SWB_NODE_RUNTIME_BUILD_IMAGE = runtime.imageBinding;
  }
  // 桌面入口和签名场景共用一个 Cargo 特性图，避免重新编译 Host 依赖。
  await runBuild(
    process.execPath,
    [
      require.resolve("@tauri-apps/cli/tauri.js"),
      ...e2eBuildArgs(host, pkg.name, { withNodeRuntime }),
    ],
    env,
  );
  if (!existsSync(executable))
    throw new Error(`测试主程序不存在：${executable}`);
  let nodeRuntime;
  if (runtime) {
    stageNodeRuntime(runtimePlan, runtime, output);
    nodeRuntime = inspectNodeRuntimeLayout(runtimePlan, output);
  }
  if (source !== e2eSourceIdentity())
    throw new Error("E2E source changed during build; rebuild the candidate");
  const components = binaryReceipts(COMPONENTS, output, host);
  const terminalTools = runtime
    ? binaryReceipts(TERMINAL_TOOLS, join(output, "examples"), host)
    : undefined;
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        formatVersion: 2,
        source,
        executable,
        target: host,
        sha256: fileSha256(executable),
        components,
        nodeRuntime,
        terminalTools,
      },
      null,
      2,
    ),
  );
  return executable;
}

export function readE2EBuildReceipt(
  projectRoot = root,
  { withNodeRuntime = false } = {},
) {
  const targetRoot = join(projectRoot, "src-tauri", "target", "e2e");
  const path = join(targetRoot, "build.json");
  if (!existsSync(path))
    throw new Error(
      "请先运行 pnpm e2e:build，或显式运行 pnpm test:e2e --interactive。",
    );
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const expected = join(targetRoot, receipt.target, "debug");
  if (
    receipt.formatVersion !== 2 ||
    receipt.source !== e2eSourceIdentity(projectRoot) ||
    typeof receipt.target !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(receipt.target) ||
    typeof receipt.executable !== "string" ||
    resolve(receipt.executable, "..") !== expected ||
    fileSha256(receipt.executable) !== receipt.sha256 ||
    !binariesMatch(receipt.components, COMPONENTS, expected, receipt.target)
  )
    throw new Error("E2E 构建收据失效，请重新运行 pnpm e2e:build。");
  if (withNodeRuntime && !receipt.nodeRuntime)
    throw new Error("请先运行 pnpm e2e:build --with-node-runtime。");
  if (receipt.nodeRuntime !== undefined) {
    if (
      !binariesMatch(
        receipt.terminalTools,
        TERMINAL_TOOLS,
        join(expected, "examples"),
        receipt.target,
      )
    )
      throw new Error(
        "E2E 终端验收工具收据失效，请重新运行 pnpm e2e:build --with-node-runtime。",
      );
    const plan = { root: projectRoot, target: receipt.target };
    try {
      if (
        JSON.stringify(receipt.nodeRuntime) !==
        JSON.stringify(inspectNodeRuntimeLayout(plan, expected))
      )
        throw new Error("Runtime layout hash, file mode or link changed");
    } catch (error) {
      throw new Error(
        "E2E 固定 Node 收据失效，请重新运行 pnpm e2e:build --with-node-runtime。",
        { cause: error },
      );
    }
  }
  return receipt;
}

export function readE2EBuild() {
  return readE2EBuildReceipt().executable;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 1 ||
      (args.length === 1 && args[0] !== "--with-node-runtime")
    )
      throw new Error("Usage: pnpm e2e:build [--with-node-runtime].");
    console.log(
      `E2E executable: ${await buildE2E({ withNodeRuntime: args.length === 1 })}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
