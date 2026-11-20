import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileSha256, publicationPath } from "./artifact-lib.mjs";
import { projectFile } from "./fs-utils.mjs";
import { inspectComponents } from "./components-build.mjs";
import { configureBuildTarget } from "./build-lib.mjs";

export function portableFileName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[<>:"/\\|?*]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  ) {
    throw new Error(`Invalid Windows executable filename: ${value}`);
  }
  return `${value}.exe`;
}

function receiptPath(plan) {
  return join(plan.metadata.target_directory, ".starter-portable.json");
}

function resourceFiles(plan, directory, name) {
  const resources = publicationPath(plan.root, directory);
  if (!lstatSync(resources).isDirectory())
    throw new Error(`Invalid portable ${name} directory`);
  const files = [];
  let nodes = 0,
    size = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (++nodes > 10_000)
        throw new Error(`Portable ${name} file budget exceeded`);
      const file = join(directory, name),
        info = lstatSync(file);
      if (info.isSymbolicLink())
        throw new Error(`Portable ${name} links are not allowed`);
      if (info.isDirectory()) {
        visit(file);
        continue;
      }
      if (!info.isFile()) throw new Error(`Invalid portable ${name} file`);
      size += info.size;
      if (size > 512 * 1024 * 1024)
        throw new Error(`Portable ${name} byte budget exceeded`);
      projectFile(plan.root, relative(plan.root, file));
      files.push({
        path: relative(resources, file).split(sep).join("/"),
        size: String(info.size),
        sha256: fileSha256(file),
      });
    }
  };
  visit(resources);
  if (!files.length) throw new Error(`Empty portable ${name} resources`);
  return files;
}

function runtimeFiles(plan, runtime) {
  if (typeof runtime?.resources !== "string")
    throw new Error("Missing portable runtime resources");
  return resourceFiles(plan, runtime.resources, "runtime");
}

function fingerprint(plan) {
  const buildArgs = [];
  for (let i = 0; i < plan.buildArgs.length; i++) {
    if (["--target", "-t"].includes(plan.buildArgs[i])) {
      i++;
      continue;
    }
    buildArgs.push(plan.buildArgs[i]);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        config: plan.config,
        buildArgs,
        optimize: plan.optimize,
      }),
    )
    .digest("hex");
}

export function recordPortableBuild(plan, built) {
  const components = inspectComponents(plan, built.outputDir);
  if (
    JSON.stringify(components.manifest) !==
    JSON.stringify(built.components?.manifest)
  )
    throw new Error("Components changed after the build");
  const receipt = {
    root: realpathSync(plan.root),
    version: plan.version,
    fingerprint: fingerprint(plan),
    target: built.target,
    layout: relative(
      realpathSync(plan.metadata.target_directory),
      realpathSync(built.outputDir),
    ),
    executable: realpathSync(built.executable),
    sha256: fileSha256(built.executable),
    components: components.manifest,
    runtime: built.runtime,
    runtimeFiles: runtimeFiles(plan, built.runtime),
    browserFiles: resourceFiles(
      plan,
      join(plan.root, "dist"),
      "browser workbench",
    ),
    componentsSha256: createHash("sha256")
      .update(`${JSON.stringify(components.manifest, null, 2)}\n`)
      .digest("hex"),
  };
  const file = receiptPath(plan);
  const temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** --skip-build 仅复用本项目相同版本和配置且未被打包器改写的便携编译。 */
export function loadPortableBuild(plan) {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(plan), "utf8"));
    const executable = realpathSync(receipt.executable);
    const offset = relative(
      realpathSync(plan.metadata.target_directory),
      executable,
    );
    const layout = relative(
      realpathSync(plan.metadata.target_directory),
      dirname(executable),
    );
    if (
      typeof receipt.target !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(receipt.target) ||
      receipt.layout !== layout ||
      !["release", join(receipt.target, "release")].includes(layout)
    )
      throw new Error("Invalid portable receipt target or output layout");
    if (plan.explicitTarget && plan.explicitTarget !== receipt.target)
      throw new Error(
        "The requested target differs from the portable receipt target",
      );
    configureBuildTarget(plan, receipt.target);
    const components = inspectComponents(plan, dirname(executable));
    if (
      JSON.stringify(receipt.runtimeFiles) !==
      JSON.stringify(runtimeFiles(plan, receipt.runtime))
    )
      throw new Error("The runtime or license files have changed");
    if (
      JSON.stringify(receipt.browserFiles) !==
      JSON.stringify(
        resourceFiles(plan, join(plan.root, "dist"), "browser workbench"),
      )
    )
      throw new Error("The browser workbench files have changed");
    if (
      !offset ||
      offset === ".." ||
      offset.startsWith(`..${sep}`) ||
      isAbsolute(offset) ||
      receipt.root !== realpathSync(plan.root) ||
      receipt.version !== plan.version ||
      receipt.fingerprint !== fingerprint(plan) ||
      receipt.sha256 !== fileSha256(executable) ||
      JSON.stringify(receipt.components) !==
        JSON.stringify(components.manifest) ||
      receipt.componentsSha256 !==
        createHash("sha256")
          .update(`${JSON.stringify(components.manifest, null, 2)}\n`)
          .digest("hex")
    ) {
      throw new Error("The version, configuration, or executable has changed");
    }
    return {
      executable,
      outputDir: dirname(executable),
      target: receipt.target,
      components,
      runtime: receipt.runtime,
    };
  } catch (error) {
    throw new Error(
      `Cannot skip the build: ${error.message}. Run pnpm app:portable first.`,
      { cause: error },
    );
  }
}
