import { execFileSync } from "node:child_process";
import {
  globSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  resolve,
  sep,
} from "node:path";
import { fileSha256 } from "./artifact-lib.mjs";
import { fetchNodeRuntimeSources } from "./node-runtime-download.mjs";
import { inspectNodeRuntimeLayout } from "./node-runtime-layout.mjs";
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

function linuxRuntimeProductName(plan) {
  const productName = plan.config.productName ?? plan.package?.name;
  if (
    !validateNodePackagePath(productName) ||
    productName.includes("/") ||
    Buffer.byteLength(productName) > 255
  )
    throw new Error("Invalid runtime product directory");
  return productName;
}

/** Linux 的逐文件资源复制会解引用链接，使用打包器已有的整目录复制入口。 */
export function runtimeBundleConfig(plan, runtime) {
  const resources = runtimeResourceMap(plan, runtime);
  if (plan.platform !== "linux") return { resources };
  const productName = linuxRuntimeProductName(plan);
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

/** Tauri 2.12 的 Debian tar 会解引用 SONAME。按已验证的资源布局复原后再归档。 */
export function preserveDebianRuntimeLink(plan, runtime, deb) {
  const expected = inspectNodeRuntimeLayout(plan, runtime.resources);
  const link = expected.find((entry) => entry.link);
  if (!link) return;
  const path = posix.join(posix.dirname(link.path), link.link);
  const library = expected.find((entry) => entry.path === path);
  if (!library?.sha256) throw new Error("Missing verified SONAME library");

  const staging = mkdtempSync(join(dirname(deb), ".runtime-deb-"));
  try {
    const data = join(staging, "package");
    execFileSync("dpkg-deb", ["--raw-extract", deb, data], { env: plan.env });
    const resources = join(data, "usr", "lib", linuxRuntimeProductName(plan));
    const alias = join(resources, link.path);
    const info = lstatSync(alias);
    if (fileSha256(join(resources, path)) !== library.sha256)
      throw new Error(
        "Packaged SONAME library differs from the verified runtime",
      );
    if (info.isSymbolicLink() && readlinkSync(alias) === link.link) return;
    if (!info.isFile() || fileSha256(alias) !== library.sha256)
      throw new Error("Unexpected SONAME alias in the Debian package");
    unlinkSync(alias);
    symlinkSync(link.link, alias);
    const repaired = join(staging, "package.deb");
    execFileSync(
      "dpkg-deb",
      ["-Zgzip", "--root-owner-group", "--build", data, repaired],
      { env: plan.env, stdio: "inherit" },
    );
    renameSync(repaired, deb);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
