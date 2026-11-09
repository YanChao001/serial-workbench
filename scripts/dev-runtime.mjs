import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileSha256 } from "./artifact-lib.mjs";

/** 独立 Host 可以跨 GUI 生命周期运行；Cargo 输出始终留给下一次构建。 */
export function stageDevRuntime(root, sources) {
  const files = sources.map((source) => ({
    source,
    name: basename(source),
    sha256: fileSha256(source),
  }));
  if (new Set(files.map((file) => file.name)).size !== files.length)
    throw new Error("Development runtime component names must be distinct");
  const version = createHash("sha256")
    .update(JSON.stringify(files.map(({ name, sha256 }) => ({ name, sha256 }))))
    .digest("hex");
  let directory = resolve(root);
  for (const part of [".cache", "dev-runtime", version]) {
    directory = join(directory, part);
    if (existsSync(directory)) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          "Development runtime directory is not a real directory",
        );
    } else mkdirSync(directory);
  }
  return files.map(({ source, name, sha256 }) => {
    const target = join(directory, name);
    const valid = () => {
      const info = lstatSync(target);
      return (
        info.isFile() && !info.isSymbolicLink() && fileSha256(target) === sha256
      );
    };
    if (existsSync(target)) {
      if (!valid())
        throw new Error("Development runtime component was changed");
      return target;
    }
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    try {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
      try {
        renameSync(temporary, target);
      } catch (error) {
        // 并行启动可能已发布同一版本；只复用内容相同的文件。
        if (!existsSync(target) || !valid()) throw error;
      }
      if (!valid())
        throw new Error("Development runtime copy failed validation");
      return target;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  });
}
