import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEnvironment } from "./build-lib.mjs";

export function stopHost(
  root,
  args,
  { start = spawn, env = process.env } = {},
) {
  const environment = buildEnvironment(env);
  // 此明确入口停止实际运行的旧版本；仍由 CLI 执行本地认证与正常退出协议。
  delete environment.SWB_DEV_EXPECTED_HOST_EXECUTABLE;
  return new Promise((resolveResult, reject) => {
    const child = start(
      "cargo",
      [
        "run",
        "--locked",
        "--manifest-path",
        join(root, "Cargo.toml"),
        "--package",
        "serial-workbench-cli",
        "--",
        "host",
        "stop",
        ...args,
      ],
      {
        cwd: join(root, "src-tauri"),
        env: environment,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    );
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolveResult(code ?? (signal === "SIGINT" ? 130 : 1)),
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await stopHost(
      resolve(import.meta.dirname, ".."),
      process.argv.slice(2),
    );
  } catch (error) {
    console.error(`Cannot stop Host: ${error.message}`);
    process.exitCode = 1;
  }
}
