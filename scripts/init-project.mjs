import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyInitialization,
  checkInitialization,
  initializationDiff,
  prepareInitialization,
} from "./init-lib.mjs";

try {
  const args = process.argv.slice(2);
  let config,
    dryRun = false,
    check = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") dryRun = true;
    else if (args[index] === "--check") check = true;
    else if (
      args[index] === "--config" &&
      !config &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      config = args[++index];
    else if (["--help", "-h"].includes(args[index])) {
      console.log(
        "用法: pnpm config:sync [--config <应用配置JSON文件>] [--dry-run]\n检查同步: pnpm config:check\n版本请用 pnpm version:set；图标和安装器视觉修改 resources/branding/*.svg 后运行 pnpm branding:generate。签名私钥不会被读取或修改。",
      );
      process.exit(0);
    } else throw new Error(`未知或缺值参数：${args[index]}`);
  }
  if (check && (config || dryRun))
    throw new Error(
      "--check 仅检查当前配置，不能与 --config 或 --dry-run 合用",
    );
  const root = resolve(import.meta.dirname, "..");
  const patch = config ? JSON.parse(readFileSync(resolve(config), "utf8")) : {};
  if (check) {
    const differences = checkInitialization(root);
    if (differences.length)
      throw new Error(
        `应用配置未同步：${differences.join("、")}。请运行 pnpm config:sync --dry-run 核对，再运行 pnpm config:sync。`,
      );
    console.log("应用身份、系统集成与品牌配置一致。");
    process.exit(0);
  }
  const plan = prepareInitialization(root, patch);
  console.log(initializationDiff(plan) || "应用配置已一致，无需修改。");
  if (dryRun) console.log(`预览完成：${plan.changes.length} 个文件，未写入。`);
  else {
    applyInitialization(plan);
    console.log(
      `配置同步完成：${plan.changes.length} 个文件。请核对应用身份、系统集成和品牌资源，再运行 pnpm config:check。`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
