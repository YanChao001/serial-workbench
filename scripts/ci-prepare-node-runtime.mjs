import { appendFileSync } from "node:fs";
import { buildNodeRuntime } from "./node-runtime-build.mjs";

// 使用 runner 的原生 shell，与正式构建保持相同的 Windows 系统工具选择。
if (!process.env.GITHUB_ENV) throw new Error("Missing GitHub environment file");
const runtime = await buildNodeRuntime({
  root: process.cwd(),
  target: process.env.RUNTIME_TARGET,
  env: process.env,
});
appendFileSync(
  process.env.GITHUB_ENV,
  `SWB_NODE_RUNTIME_TEST_ROOT=${runtime.resources}\n`,
);
if (runtime.imageBinding)
  appendFileSync(
    process.env.GITHUB_ENV,
    `SWB_NODE_RUNTIME_BUILD_IMAGE=${runtime.imageBinding}\n`,
  );
