import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileSha256, publicationPath } from "./artifact-lib.mjs";
import { projectFile } from "./fs-utils.mjs";
import {
  loadNodeRuntimeRelease,
  verifyRuntimeChecksums,
} from "./node-runtime-source.mjs";
import {
  loadNodeRuntimeLibrary,
  verifyRuntimeLibrarySources,
} from "./node-runtime-library-source.mjs";

function validateSource(source) {
  const url = new URL(source.url);
  const official =
    (url.origin === "https://nodejs.org" &&
      /^\/download\/release\/v[0-9]+\.[0-9]+\.[0-9]+\/node-v[0-9]+\.[0-9]+\.[0-9]+-(?:win-x64\.zip|darwin-(?:arm64|x64)\.tar\.gz|linux-x64\.tar\.xz)$/.test(
        url.pathname,
      )) ||
    (url.origin === "https://archive.ubuntu.com" &&
      /^\/ubuntu\/pool\/main\/g\/gcc-12\/[A-Za-z0-9._~+-]+$/.test(
        url.pathname,
      ));
  if (
    !official ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    source.name !== url.pathname.split("/").at(-1) ||
    !/^[A-Za-z0-9._~+-]+$/.test(source.name) ||
    !/^[1-9][0-9]*$/.test(String(source.size)) ||
    BigInt(source.size) > 128n * 1024n * 1024n ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw new Error("Invalid pinned runtime source URL, size or digest");
}

function verifyCached(root, file, source) {
  const info = lstatSync(file);
  projectFile(root, relative(root, file));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    BigInt(info.size) !== BigInt(source.size)
  )
    throw new Error(`Cached runtime size/type mismatch: ${file}`);
  if (fileSha256(file) !== source.sha256)
    throw new Error(`Cached runtime hash mismatch: ${file}`);
  return file;
}

class RuntimeConnectionError extends Error {
  constructor(cause) {
    super(`Runtime connection failed (${cause.cause.code})`, { cause });
  }
}

/** 有界获取锁定的字节；错误原件保留，已有缓存从不覆盖，不跟随 HTTP 重定向。 */
export async function cachePinnedRuntimeFile(options) {
  try {
    return await downloadPinnedRuntimeFile(options);
  } catch (error) {
    if (!(error.cause instanceof RuntimeConnectionError)) throw error;
    return downloadPinnedRuntimeFile(options);
  }
}

async function downloadPinnedRuntimeFile({
  root,
  cacheDirectory,
  source,
  fetch = globalThis.fetch,
  signal,
  offline = false,
  timeoutMs = 120_000,
}) {
  validateSource(source);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error("Invalid runtime download timeout");
  signal?.throwIfAborted();
  const cache = publicationPath(root, cacheDirectory),
    destination = join(cache, source.name);
  if (existsSync(destination)) return verifyCached(root, destination, source);
  if (offline) throw new Error(`Offline runtime cache miss: ${source.name}`);
  mkdirSync(join(cache, "attempts"), { recursive: true });
  const attempt = mkdtempSync(join(cache, "attempts", source.name + "-"));
  const partial = join(attempt, "payload.partial");
  const controller = new AbortController();
  const abort = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let handle,
    reader,
    size = 0n;
  const sha256 = createHash("sha256");
  try {
    handle = await open(partial, "wx");
    const response = await fetch(source.url, {
      redirect: "manual",
      signal: abort,
      headers: { "Accept-Encoding": "identity" },
    }).catch((error) => {
      if (
        !abort.aborted &&
        error instanceof TypeError &&
        [
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_SOCKET",
          "ECONNRESET",
          "EAI_AGAIN",
        ].includes(error.cause?.code)
      )
        throw new RuntimeConnectionError(error);
      throw error;
    });
    if (response.status !== 200 || !response.body)
      throw new Error(`Runtime download HTTP status ${response.status}`);
    const encoding = response.headers.get("content-encoding"),
      length = response.headers.get("content-length");
    if (encoding && encoding !== "identity")
      throw new Error("Unexpected runtime download encoding");
    if (
      length !== null &&
      (!/^[0-9]+$/.test(length) || BigInt(length) !== BigInt(source.size))
    )
      throw new Error("Runtime download Content-Length mismatch");
    reader = response.body.getReader();
    while (true) {
      abort.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += BigInt(value.byteLength);
      if (size > BigInt(source.size))
        throw new Error("Runtime download exceeds pinned size");
      sha256.update(value);
      for (let offset = 0; offset < value.byteLength;) {
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset,
          null,
        );
        if (!bytesWritten)
          throw new Error("Runtime download write made no progress");
        offset += bytesWritten;
      }
    }
    abort.throwIfAborted();
    if (size !== BigInt(source.size) || sha256.digest("hex") !== source.sha256)
      throw new Error("Runtime download size/hash mismatch");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // 同目录硬链接以排他方式发布完整文件；并发成功者只可复用相同字节。
    try {
      await link(partial, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      verifyCached(root, destination, source);
    }
    await unlink(partial);
    writeFileSync(
      join(attempt, "verified.json"),
      JSON.stringify({ source, size: String(size) }, null, 2) + "\n",
      { flag: "wx" },
    );
    return destination;
  } catch (error) {
    controller.abort(error);
    writeFileSync(
      join(attempt, "failure.json"),
      JSON.stringify(
        { source, size: String(size), error: error.message },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw new Error(
      `${error.message}; download evidence retained: ${attempt}`,
      { cause: error },
    );
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await handle?.close();
  }
}

/** 先验证离线签名链，再下载本目标的固定归档和完整对应源码。 */
export async function fetchNodeRuntimeSources({
  root,
  target,
  cacheDirectory = join(root, ".cache/node-runtime/sources"),
  ...options
}) {
  const release = loadNodeRuntimeRelease(root),
    spec = release.targets.find((entry) => entry.target === target);
  if (!spec) throw new Error("Unsupported Node runtime target");
  const cache = publicationPath(root, cacheDirectory);
  mkdirSync(cache, { recursive: true });
  const verification = mkdtempSync(join(cache, "verification-"));
  verifyRuntimeChecksums({
    release,
    cache: verification,
    publicKey: readFileSync(projectFile(root, release.upstream.publicKeyPath)),
    signedChecksums: readFileSync(
      projectFile(root, "resources/runtime/SHASUMS256.txt.asc"),
    ),
  });
  const library =
    spec.platform === "linux" ? loadNodeRuntimeLibrary(root) : undefined;
  if (library)
    verifyRuntimeLibrarySources({
      root,
      cache: verification,
      release: library,
    });
  const archiveDirectory = join(cache, release.id),
    artifactDirectory = library ? join(cache, library.id) : undefined;
  await cachePinnedRuntimeFile({
    ...options,
    root,
    cacheDirectory: archiveDirectory,
    source: spec.archive,
  });
  for (const artifact of library?.artifacts ?? [])
    await cachePinnedRuntimeFile({
      // 固定的 GCC 完整源码比运行时归档大。继续使用同一长度、摘要和来源校验。
      ...(artifact.filename.endsWith(".orig.tar.gz")
        ? { timeoutMs: 300_000 }
        : {}),
      ...options,
      root,
      cacheDirectory: artifactDirectory,
      source: {
        ...artifact,
        name: artifact.filename.split("/").at(-1),
        url: library.upstream.baseUrl + artifact.filename,
      },
    });
  return { archiveDirectory, artifactDirectory };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = process.argv.slice(2),
      options = { root: resolve(import.meta.dirname, "..") };
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log(
        "Usage: pnpm runtime:fetch --target <triple> [--cache <project-directory>] [--offline]",
      );
    } else {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--offline") {
          options.offline = true;
          continue;
        }
        const key = { "--target": "target", "--cache": "cacheDirectory" }[
            args[i]
          ],
          value = args[++i];
        if (!key || !value || value.startsWith("--"))
          throw new Error(
            "Usage: pnpm runtime:fetch --target <triple> [--cache <project-directory>] [--offline]",
          );
        options[key] = value;
      }
      if (!options.target) throw new Error("Runtime target is required");
      console.log(
        JSON.stringify(await fetchNodeRuntimeSources(options), null, 2),
      );
    }
  } catch (error) {
    console.error(`Runtime source download failed: ${error.message}`);
    process.exitCode = 1;
  }
}
