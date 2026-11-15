import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { removeProjectPath } from "./fs-utils.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function defaultGpgv() {
  if (process.platform === "win32") {
    const git = join(
      process.env.ProgramFiles ?? "C:/Program Files",
      "Git/usr/bin/gpgv.exe",
    );
    if (existsSync(git)) return git;
  }
  return "gpgv";
}

/** 验签和后续语义核对共用一份现场；任一步失败均保留原始输入和工具输出。 */
export function withVerifiedRuntimeSource(
  {
    publicKey,
    signedMetadata,
    pins,
    cache,
    gpgv = defaultGpgv(),
    runGpgv = spawnSync,
  },
  consume,
) {
  if (
    !Buffer.isBuffer(publicKey) ||
    publicKey.length > 64 * 1024 ||
    sha256(publicKey) !== pins.publicKeySha256
  )
    throw new Error("Runtime public key hash mismatch");
  if (
    !Buffer.isBuffer(signedMetadata) ||
    signedMetadata.length > 1024 * 1024 ||
    sha256(signedMetadata) !== pins.signedMetadataSha256
  )
    throw new Error("Runtime signed metadata hash mismatch");
  cache = resolve(cache);
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "runtime-source-"));
  writeFileSync(join(directory, "public-key.gpg"), publicKey, { flag: "wx" });
  writeFileSync(join(directory, "signed.asc"), signedMetadata, { flag: "wx" });
  // 相对路径兼容 Git for Windows 的 MSYS GPG；工作目录中只有本次公开输入。
  const result = runGpgv(
    gpgv,
    [
      "--homedir",
      ".",
      "--keyring",
      "./public-key.gpg",
      "--log-file",
      "./gpg-log.txt",
      "--status-fd",
      "2",
      "--output",
      "-",
      "./signed.asc",
    ],
    {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.from(result.stderr ?? "");
  const status = stderr.toString("utf8");
  writeFileSync(
    join(directory, "gpg-status.txt"),
    stderr.subarray(0, 256 * 1024),
    { flag: "wx" },
  );
  writeFileSync(
    join(directory, "gpg-output.txt"),
    stdout.subarray(0, 1024 * 1024),
    { flag: "wx" },
  );
  writeFileSync(join(directory, "gpg-stderr.txt"), stderr, {
    flag: "wx",
  });
  if (result.error)
    writeFileSync(join(directory, "gpg-error.txt"), result.error.message, {
      flag: "wx",
    });
  try {
    if (result.error || result.status !== 0)
      throw new Error("Runtime source signature verification failed");
    if (
      !status
        .split(/\r?\n/)
        .some((line) =>
          line.startsWith(`[GNUPG:] VALIDSIG ${pins.signerFingerprint} `),
        )
    )
      throw new Error("Unexpected runtime source signer");
    if (stdout.length > 1024 * 1024 || stderr.length > 256 * 1024)
      throw new Error("Verified runtime metadata exceeded budget");
    // GnuPG 2.5 的文件输出可能保留为 .part。只消费进程有界输出，成功验签后自行提交原字节。
    const plaintext = new TextDecoder("utf8", { fatal: true }).decode(stdout);
    writeFileSync(join(directory, "verified.txt"), stdout, { flag: "wx" });
    const verified = {
      plaintext,
      status,
      signerFingerprint: pins.signerFingerprint,
      publicKeySha256: sha256(publicKey),
      signedMetadataSha256: sha256(signedMetadata),
    };
    const value = consume(verified);
    removeProjectPath(cache, relative(cache, directory));
    return value;
  } catch (error) {
    throw new Error(`${error.message}; evidence retained: ${directory}`, {
      cause: error,
    });
  }
}
