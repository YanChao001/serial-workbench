import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const PACKAGES = ["contracts", "host-client"];
function sourceFile(file: string) {
  return (
    /\.(?:ts|mjs|json)$/.test(file) && !/\.(?:test|spec)\.[^.]+$/.test(file)
  );
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && sourceFile(file)
        ? [file]
        : [];
  });
}

/** 预构建本地大模块；源码参与缓存身份，包内变更重启开发图而不复用旧校验器。 */
export function linkedPackagesDevConfig(root: string) {
  const directories = PACKAGES.map((name) => path.join(root, "packages", name));
  const files = directories
    .flatMap((directory) => [
      path.join(directory, "package.json"),
      ...sourceFiles(path.join(directory, "src")),
    ])
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(path.relative(root, file))
      .update("\0")
      .update(readFileSync(file))
      .update("\0");
  const fingerprint = hash.digest("hex");
  const watchesSource = (file: string) =>
    directories.some((directory) => {
      const relative = path.relative(directory, file);
      return (
        relative === "package.json" ||
        (relative.startsWith(`src${path.sep}`) && sourceFile(relative))
      );
    });
  const plugin: Plugin = {
    name: "linked-package-runtime",
    apply: "serve",
    configureServer(server) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const changed = (event: string, file: string) => {
        if (
          stopped ||
          !["add", "change", "unlink"].includes(event) ||
          !watchesSource(file)
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          if (!stopped)
            void server
              .restart()
              .catch((error: unknown) =>
                server.config.logger.error(String(error)),
              );
        }, 75);
      };
      server.watcher.add(directories);
      server.watcher.on("all", changed);
      server.httpServer?.once("close", () => {
        stopped = true;
        clearTimeout(timer);
        server.watcher.off("all", changed);
      });
    },
  };
  return {
    cacheDir: path.join(root, ".cache", "vite-linked", fingerprint),
    optimizeDeps: {
      include: PACKAGES.map((name) => `@serial-workbench/${name}`),
    },
    plugin,
  };
}
