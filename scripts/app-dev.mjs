import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { buildEnvironment } from "./build-lib.mjs";
import { stageDevRuntime } from "./dev-runtime.mjs";

const require = createRequire(import.meta.url);

function cargoSelection(args) {
  const split = args.indexOf("--");
  const tauri = split < 0 ? args : args.slice(0, split);
  const cargo =
    split < 0
      ? []
      : args.slice(
          split + 1,
          args.indexOf("--", split + 1) < 0
            ? undefined
            : args.indexOf("--", split + 1),
        );
  if (
    tauri.some(
      (value) => /^--runner(?:=|$)/.test(value) || value.startsWith("-r"),
    )
  )
    throw new Error("app:dev cannot synchronize a custom runner with Host");
  const picked = [];
  for (const [list, keys] of [
    [tauri, new Set(["--target", "-t"])],
    [cargo, new Set(["--target", "--target-dir", "--profile", "--config"])],
  ]) {
    for (let i = 0; i < list.length; i++) {
      const value = list[i];
      if (
        list === tauri &&
        value.startsWith("-t") &&
        value.length > 2 &&
        !value.startsWith("-t=")
      ) {
        picked.push("--target", value.slice(2));
        continue;
      }
      if (
        list === cargo &&
        /^(--manifest-path|--package|-p|--workspace|--all)(=|$)/.test(value)
      )
        throw new Error(`app:dev cannot synchronize Cargo argument ${value}`);
      const equals = value.indexOf("=");
      const key = equals < 0 ? value : value.slice(0, equals);
      if (!keys.has(key)) continue;
      const argument = equals < 0 ? list[++i] : value.slice(equals + 1);
      if (!argument) throw new Error(`${key} requires a value`);
      picked.push(key === "-t" ? "--target" : key, argument);
    }
  }
  if (
    (tauri.includes("--release") || cargo.includes("--release")) &&
    !picked.includes("--profile")
  )
    picked.push("--release");
  return picked;
}

function runProcess(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const { onStdoutLine, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: "inherit", ...spawnOptions });
    if (onStdoutLine)
      createInterface({ input: child.stdout }).on("line", onStdoutLine);
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolveResult(code ?? (signal === "SIGINT" ? 130 : 1)),
    );
  });
}

export async function runDev(
  root,
  args,
  { run = runProcess, stageRuntime = stageDevRuntime } = {},
) {
  const options = {
    cwd: join(root, "src-tauri"),
    env: buildEnvironment(),
    windowsHide: true,
    shell: false,
  };
  if (args.length === 1 && ["--help", "-h"].includes(args[0]))
    return run(
      process.execPath,
      [require.resolve("@tauri-apps/cli/tauri.js"), "dev", ...args],
      { ...options, cwd: root },
    );
  const buildArgs = [
    "build",
    "--locked",
    "--message-format=json",
    "--manifest-path",
    join(root, "Cargo.toml"),
    "--package",
    "serial-workbench-host",
    "--package",
    "serial-workbench-cli",
    ...cargoSelection(args),
  ];
  const executables = new Map([
    ["serial-workbench-host", new Set()],
    ["serial-workbench-cli", new Set()],
  ]);
  const status = await run("cargo", buildArgs, {
    ...options,
    stdio: ["ignore", "pipe", "inherit"],
    onStdoutLine(line) {
      if (!line) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`${line}\n`);
        return;
      }
      if (
        message?.reason === "compiler-message" &&
        typeof message.message?.rendered === "string"
      )
        process.stderr.write(message.message.rendered);
      if (
        message?.reason === "compiler-artifact" &&
        executables.has(message.target?.name) &&
        Array.isArray(message.target.kind) &&
        message.target.kind.includes("bin")
      )
        executables.get(message.target.name).add(message.executable);
    },
  });
  if (status !== 0) return status;
  const paths = [...executables.values()].map((values) => {
    const [path] = values;
    if (values.size !== 1 || typeof path !== "string" || !isAbsolute(path))
      throw new Error(
        "Cargo did not report unambiguous Host and CLI executables",
      );
    return resolve(path);
  });
  if (dirname(paths[0]) !== dirname(paths[1]))
    throw new Error(
      "Cargo Host and CLI executables do not share an output directory",
    );
  const runtime = stageRuntime(root, paths);
  const developmentOptions = {
    ...options,
    env: { ...options.env, SWB_DEV_EXPECTED_HOST_EXECUTABLE: runtime[0] },
  };
  // 在 Tauri 的 cargo run 创建受限 Job 前，由正式 CLI 认证并准备同一 Host。
  const ready = await run(runtime[1], ["catalog", "--json"], {
    ...developmentOptions,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (ready !== 0) return ready;
  return run(
    process.execPath,
    [require.resolve("@tauri-apps/cli/tauri.js"), "dev", ...args],
    { ...developmentOptions, cwd: root },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await runDev(
      resolve(import.meta.dirname, ".."),
      process.argv.slice(2),
    );
  } catch (error) {
    console.error(`Development startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
