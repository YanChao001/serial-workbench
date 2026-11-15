import { globSync, lstatSync, statSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { fetchNodeRuntimeSources } from "./node-runtime-download.mjs";
import { prepareNodeRuntime } from "./node-runtime-prepare.mjs";
import { loadNodeRuntimeRelease } from "./node-runtime-source.mjs";
import { validateNodePackagePath } from "../packages/contracts/src/generated/validators.mjs";

/** 构建与发行共用资源；跨目标仅静态准备，本目标必须实际运行 ABI 自检。 */
export async function buildNodeRuntime(plan) {
  const release = loadNodeRuntimeRelease(plan.root),
    spec = release.targets.find((s) => s.target === plan.target);
  if (!spec) throw new Error("Unsupported Node runtime build target");
  const inputs = await fetchNodeRuntimeSources({
    root: plan.root,
    target: plan.target,
    offline: plan.env?.SWB_RUNTIME_OFFLINE === "1",
  });
  return prepareNodeRuntime({
    root: plan.root,
    target: plan.target,
    ...inputs,
    runSelfTest:
      process.platform === spec.platform && process.arch === spec.arch,
  });
}

// 与 tauri-utils 2.x resource_relpath 一致；保留列表配置的 _up_ / _root_ 语义。
function resourceRelativePath(path) {
  const root = parse(path).root;
  const parts = path
    .slice(root.length)
    .split(process.platform === "win32" ? /[/\\]/ : "/")
    .filter((part) => part && part !== ".")
    .map((part) => (part === ".." ? "_up_" : part));
  return [...(isAbsolute(path) ? ["_root_"] : []), ...parts].join("/");
}

/** 将列表的 glob 展开后保留目录层次，避免 map glob 的扁平化行为改变用户资源。 */
export function runtimeResourceMap(plan, runtime) {
  const original = plan.config.bundle?.resources ?? {};
  let resources;
  if (Array.isArray(original)) {
    const entries = [];
    for (const pattern of original) {
      if (typeof pattern !== "string")
        throw new Error("Invalid resource pattern");
      if (pattern.includes("*")) {
        const files = globSync(pattern, {
          cwd: join(plan.root, "src-tauri"),
        }).filter((file) =>
          statSync(resolve(plan.root, "src-tauri", file)).isFile(),
        );
        if (!files.length)
          throw new Error(`Resource glob has no files: ${pattern}`);
        entries.push(
          ...files.map((file) => [
            file.split(sep).join("/"),
            resourceRelativePath(file),
          ]),
        );
      } else {
        const directory = lstatSync(
          resolve(plan.root, "src-tauri", pattern),
        ).isDirectory();
        entries.push([
          pattern,
          resourceRelativePath(pattern) + (directory ? "/" : ""),
        ]);
      }
    }
    resources = Object.fromEntries(entries);
  } else if (
    original &&
    typeof original === "object" &&
    Object.values(original).every((v) => typeof v === "string")
  ) {
    resources = { ...original };
  } else throw new Error("Invalid Tauri resource mapping");
  return plan.platform === "linux"
    ? resources
    : { ...resources, [runtime.resources.replaceAll("\\", "/") + "/"]: "" };
}

/** Linux 的逐文件资源复制会解引用链接，使用打包器已有的整目录复制入口。 */
export function runtimeBundleConfig(plan, runtime) {
  const resources = runtimeResourceMap(plan, runtime);
  if (plan.platform !== "linux") return { resources };
  const productName = plan.config.productName ?? plan.package?.name;
  if (
    !validateNodePackagePath(productName) ||
    productName.includes("/") ||
    Buffer.byteLength(productName) > 255
  )
    throw new Error("Invalid runtime product directory");
  const destination = `/usr/lib/${productName}/runtime`,
    source = join(runtime.resources, "runtime");
  const linux = {};
  for (const type of ["deb", "rpm", "appimage"]) {
    const original = plan.config.bundle?.linux?.[type]?.files ?? {};
    if (
      Object.hasOwn(original, destination) &&
      original[destination] !== source
    )
      throw new Error(
        "Linux runtime product directory conflicts with an existing mapping",
      );
    linux[type] = { files: { ...original, [destination]: source } };
  }
  return { resources, linux };
}
