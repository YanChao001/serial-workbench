#!/usr/bin/env node
/** 构建便携版，或用有效收据复用先前编译；分发到 artifacts/<版本>/<target>/portable。 */
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactDirectory, publishArtifacts } from "./artifact-lib.mjs";
import { buildApplication, prepareBuild } from "./build-lib.mjs";
import {
  loadPortableBuild,
  portableFileName,
  recordPortableBuild,
} from "./portable-lib.mjs";

export function portableArtifactEntries(
  root,
  { executable, executableName, readme },
) {
  return [
    { source: executable, path: executableName },
    { contents: readme, path: "使用说明.txt" },
    ...["LICENSE", "NOTICE"].map((path) => ({
      source: resolve(root, path),
      path,
    })),
    { source: resolve(root, "resources/third-party"), path: "third-party" },
  ];
}

async function main() {
  if (process.platform !== "win32")
    throw new Error(
      "Portable builds are supported only on Windows. Use AppImage on Linux or .app / DMG on macOS.",
    );
  const root = resolve(import.meta.dirname, "..");
  const raw = process.argv.slice(2);
  if (raw.includes("--help") || raw.includes("-h")) {
    console.log(
      "Usage: pnpm app:portable [--optimize speed|size] [--skip-build] [--target <triple>] [--config <JSON>] [--features <features>] [--ci]\nDefaults to size for smaller binaries; use speed for faster compilation. --skip-build requires a portable build with the same optimization strategy.",
    );
    return;
  }
  const skipBuild = raw.includes("--skip-build");
  const args = raw.filter((arg) => arg !== "--skip-build");
  if (args.some((arg) => /^(?:--bundles|-b)(?:=|$)/.test(arg)))
    throw new Error(
      "Portable builds do not generate installers. Use pnpm app:build with --bundles.",
    );
  const plan = prepareBuild(root, [...args, "--no-bundle"]);
  if (plan.platform !== "windows")
    throw new Error("Portable builds require a Windows target.");
  const productName = plan.config.productName ?? plan.package.name;
  const executableName = portableFileName(productName);
  artifactDirectory(root, plan.version, plan.target, "portable");
  const built = skipBuild
    ? loadPortableBuild(plan)
    : await buildApplication(plan);
  if (!built.target.includes("-windows-"))
    throw new Error(
      "The portable build receipt does not refer to a Windows target.",
    );
  if (!skipBuild) recordPortableBuild(plan, built);
  const readme = `${productName} 便携版 v${plan.version}

双击 EXE 运行。目标机器需要 Windows 10 / 11 与 Microsoft Edge WebView2 Runtime。
缺少运行时时请先安装：https://go.microsoft.com/fwlink/p/?LinkId=2124703

设置、窗口状态与壁纸写入当前用户的应用数据目录，日志与 WebView 数据分别使用系统配置的日志和缓存目录。
数据不随 EXE 移动。本程序无需安装，但不是将全部用户数据保存在同目录的绿色版。
插件功能尚未实现。退出、重启或安装更新遇到未完成工作时，应用会先协调保存、放弃或取消。自启动和后台运行默认关闭，可在“设置”中开启。
配置更新签名后，应用内安装更新会启动 NSIS 安装器，转为安装版，不会原地替换便携 EXE；若需保持免安装形态，请手动下载新版便携包。

此脚本不会进行 Authenticode 签名。对外分发前需单独配置签名并验证运行环境。
manifest.json 记录版本、目标平台和文件 SHA-256，可用于检查分发文件完整性。
项目许可见 LICENSE（Apache-2.0）；版权与第三方归属说明见 NOTICE。third-party 目录保留相应第三方许可，分发时请一并携带。
`;
  const output = publishArtifacts(root, {
    version: plan.version,
    target: built.target,
    kind: "portable",
    entries: portableArtifactEntries(root, {
      executable: built.executable,
      executableName,
      readme,
    }),
  });
  console.log(`Portable build created: ${relative(root, output)}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`Portable build failed: ${error.message}`);
    if (["EPERM", "EBUSY", "EACCES"].includes(error.code))
      console.error(
        "Close programs using the distribution files, check directory write permissions, and try again.",
      );
    process.exitCode = 1;
  }
}
