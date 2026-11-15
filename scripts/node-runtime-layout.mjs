import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { fileSha256, publicationPath } from "./artifact-lib.mjs";
import { removeProjectPath } from "./fs-utils.mjs";
import { loadNodeRuntimeRelease } from "./node-runtime-source.mjs";
import { loadNodeRuntimeLibrary } from "./node-runtime-library-source.mjs";

function allowedLinks(plan) {
  const release = loadNodeRuntimeRelease(plan.root),
    target = release.targets.find((entry) => entry.target === plan.target);
  if (!target) throw new Error("Unsupported runtime layout target");
  if (!target.requiredPrivateLibraries.length) return new Map();
  const library = loadNodeRuntimeLibrary(plan.root);
  const base = posix.dirname(posix.dirname(target.executable.resourcePath));
  return new Map([
    [
      posix.join(base, library.sonameLink.resourcePath),
      library.sonameLink.target,
    ],
  ]);
}

function snapshot(resources, links) {
  const root = realpathSync(resources),
    files = [];
  let nodes = 0,
    bytes = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (++nodes > 10_000)
        throw new Error("Runtime layout file budget exceeded");
      const file = join(directory, name),
        info = lstatSync(file),
        path = relative(root, file).split(sep).join("/");
      if (info.isSymbolicLink()) {
        const link = readlinkSync(file),
          resolved = relative(root, realpathSync(file));
        if (
          links.get(path) !== link ||
          isAbsolute(resolved) ||
          resolved === ".." ||
          resolved.startsWith(".." + sep) ||
          !statSync(file).isFile()
        )
          throw new Error("Unexpected runtime layout link");
        files.push({ path, link });
      } else if (info.isDirectory()) visit(file);
      else {
        if (!info.isFile()) throw new Error("Invalid runtime layout file type");
        bytes += info.size;
        if (bytes > 512 * 1024 * 1024)
          throw new Error("Runtime layout byte budget exceeded");
        files.push({
          path,
          size: String(info.size),
          mode: info.mode & 0o777,
          sha256: fileSha256(file),
        });
      }
    }
  };
  const runtime = join(root, "runtime"),
    runtimeInfo = lstatSync(runtime);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink())
    throw new Error("Runtime layout root must be a directory without links");
  visit(runtime);
  if (!files.length) throw new Error("Empty runtime layout");
  return files;
}

/** 构建和验收共用字节/模式/链接清单；仅接受项目内的固定目标资源树。 */
export function inspectNodeRuntimeLayout(plan, resources) {
  return snapshot(publicationPath(plan.root, resources), allowedLinks(plan));
}

/** 独立构建输出使用同一资源树；保留 SONAME 链接，失败不覆盖现有运行时。 */
export function stageNodeRuntime(plan, runtime, outputDirectory) {
  const targetRoot = realpathSync(plan.metadata.target_directory);
  const output = publicationPath(targetRoot, outputDirectory);
  const destination = publicationPath(targetRoot, join(output, "runtime"));
  const resources = publicationPath(plan.root, runtime.resources);
  const links = allowedLinks(plan),
    source = snapshot(resources, links);
  if (
    existsSync(destination) &&
    (!lstatSync(destination).isDirectory() ||
      lstatSync(destination).isSymbolicLink())
  )
    throw new Error("Runtime output must be an owned directory");
  mkdirSync(output, { recursive: true });
  const candidate = mkdtempSync(join(output, ".node-runtime-"));
  const backup = join(output, ".runtime-previous-" + randomUUID());
  let previous = false,
    committed = false;
  try {
    cpSync(join(resources, "runtime"), join(candidate, "runtime"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    if (JSON.stringify(snapshot(candidate, links)) !== JSON.stringify(source))
      throw new Error("Runtime layout changed during staging");
    // 每次更名重新检查目标边界，不让目录链接把提交或回滚导向用户数据。
    if (existsSync(destination)) {
      renameSync(
        publicationPath(targetRoot, destination),
        publicationPath(targetRoot, backup),
      );
      previous = true;
    }
    try {
      renameSync(
        publicationPath(targetRoot, join(candidate, "runtime")),
        publicationPath(targetRoot, destination),
      );
    } catch (error) {
      if (previous) {
        try {
          renameSync(
            publicationPath(targetRoot, backup),
            publicationPath(targetRoot, destination),
          );
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Runtime commit and restoration failed; previous output retained: ${backup}`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    committed = true;
    removeProjectPath(targetRoot, relative(targetRoot, candidate));
    if (previous) {
      try {
        removeProjectPath(targetRoot, relative(targetRoot, backup));
      } catch (error) {
        console.warn(
          `Runtime staged; previous output retained: ${backup}: ${error.message}`,
        );
      }
    }
  } catch (error) {
    throw new Error(
      `${error.message}; runtime staging retained: ${candidate}${committed ? " (new runtime committed)" : ""}`,
      { cause: error },
    );
  }
}
