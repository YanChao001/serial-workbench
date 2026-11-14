import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileSha256 } from "./artifact-lib.mjs";

export const COMPONENTS = [
  "serial-workbench-host",
  "serial-workbench-cli",
  "serial-workbench-mcp",
];

// 桌面和辅助程序使用同一 release 策略，避免两阶段的产物配置漂移。
export const RELEASE_SPEED_SETTINGS = Object.freeze([
  "codegen-units=256",
  'lto="off"',
  "opt-level=0",
  "incremental=true",
  "strip=false",
]);

export function targetPlatform(target) {
  if (target.includes("-windows-")) return "windows";
  if (target.endsWith("-apple-darwin")) return "macos";
  if (target.includes("-linux-") && !target.includes("android")) return "linux";
  throw new Error(`Unsupported desktop target: ${target}`);
}

function validateBinary(path, target, platform) {
  if (!existsSync(path)) throw new Error(`Missing component: ${path}`);
  const data = readFileSync(path);
  const arch = target.split("-")[0];
  let actual;
  if (
    platform === "windows" &&
    data.length >= 64 &&
    data.toString("ascii", 0, 2) === "MZ"
  ) {
    const offset = data.readUInt32LE(60);
    if (
      offset + 6 <= data.length &&
      data.toString("binary", offset, offset + 4) === "PE\0\0"
    )
      actual = { 0x8664: "x86_64", 0xaa64: "aarch64", 0x14c: "i686" }[
        data.readUInt16LE(offset + 4)
      ];
  } else if (
    platform === "linux" &&
    data.length >= 20 &&
    data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    data[5] === 1
  ) {
    actual = {
      62: "x86_64",
      183: "aarch64",
      3: "i686",
      40: "arm",
      243: "riscv64",
    }[data.readUInt16LE(18)];
    if (data[4] !== (["i686", "arm"].includes(actual) ? 1 : 2))
      actual = undefined;
  } else if (
    platform === "macos" &&
    data.length >= 8 &&
    data.readUInt32LE(0) === 0xfeedfacf
  ) {
    actual = { 0x01000007: "x86_64", 0x0100000c: "aarch64" }[
      data.readUInt32LE(4)
    ];
  }
  if (
    !actual ||
    (actual !== arch && !(actual === "arm" && arch.startsWith("arm")))
  )
    throw new Error(
      `Invalid component format or architecture for ${target}: ${path}`,
    );
}

export function inspectComponents(plan, outputDir) {
  const suffix = plan.platform === "windows" ? ".exe" : "";
  const files = COMPONENTS.map((name) => {
    const path = `${name}${suffix}`;
    const source = join(outputDir, path);
    validateBinary(source, plan.target, plan.platform);
    return { source, path };
  });
  return {
    files,
    manifest: {
      version: plan.version,
      protocol: "0.1",
      target: plan.target,
      architecture: plan.target.split("-")[0],
      components: files.map(({ source, path }) => ({
        path,
        sha256: fileSha256(source),
      })),
    },
  };
}

export async function buildComponents(
  plan,
  {
    run = async (command, args, options) =>
      execFileSync(command, args, options),
  } = {},
) {
  const args = [
    "build",
    "--locked",
    "--release",
    "--message-format=json",
    "--manifest-path",
    join(plan.root, "Cargo.toml"),
  ];
  if (plan.explicitTarget) args.push("--target", plan.explicitTarget);
  for (const name of COMPONENTS) args.push("--package", name);
  if (plan.optimize === "speed")
    for (const setting of RELEASE_SPEED_SETTINGS)
      args.push("--config", `profile.release.${setting}`);
  const stdout = await run("cargo", args, {
    cwd: join(plan.root, "src-tauri"),
    env: plan.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const paths = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.reason === "compiler-message" && msg.message?.rendered)
      process.stderr.write(msg.message.rendered);
    if (
      msg.reason === "compiler-artifact" &&
      COMPONENTS.includes(msg.target?.name) &&
      msg.target.kind?.includes("bin") &&
      typeof msg.executable === "string"
    )
      paths.set(msg.target.name, msg.executable);
  }
  if (paths.size !== COMPONENTS.length)
    throw new Error("Cargo did not report all component executables");
  const dirs = new Set(
    [...paths.values()].map((path) => realpathSync(dirname(path))),
  );
  if (dirs.size !== 1)
    throw new Error("Cargo components do not share an output directory");
  const outputDir = [...dirs][0];
  const offset = relative(
    realpathSync(plan.metadata.target_directory),
    outputDir,
  );
  const parts = offset.split(sep);
  if (
    isAbsolute(offset) ||
    parts.includes("..") ||
    parts.at(-1) !== "release" ||
    parts.length > 2
  )
    throw new Error("Invalid Cargo component output directory");
  const target = parts.length === 2 ? parts[0] : plan.host;
  if (plan.explicitTarget && target !== plan.explicitTarget)
    throw new Error("Cargo component target differs from requested target");
  return {
    ...inspectComponents(
      { ...plan, target, platform: targetPlatform(target) },
      outputDir,
    ),
    target,
    outputDir,
  };
}

export function stageComponents(plan, components) {
  const dir = join(
    plan.metadata.target_directory,
    ".workbench-sidecars",
    plan.target,
  );
  mkdirSync(dir, { recursive: true });
  const suffix = plan.platform === "windows" ? ".exe" : "";
  for (const { source, path } of components.files) {
    const name = suffix ? path.slice(0, -suffix.length) : path;
    copyFileSync(source, join(dir, `${name}-${plan.target}${suffix}`));
  }
  return COMPONENTS.map((name) => join(dir, name));
}
