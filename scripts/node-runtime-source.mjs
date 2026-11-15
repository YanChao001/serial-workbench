import { readFileSync } from "node:fs";
import { validateNodeRuntimeRelease } from "../packages/contracts/src/generated/validators.mjs";
import { projectFile } from "./fs-utils.mjs";
import { withVerifiedRuntimeSource } from "./signed-runtime-source.mjs";

/** @returns {import('../packages/contracts/src/generated/types.ts').NodeRuntimeRelease} */
export function loadNodeRuntimeRelease(root) {
  const value = JSON.parse(
    readFileSync(
      projectFile(root, "resources/runtime/node-release.json"),
      "utf8",
    ),
  );
  if (!validateNodeRuntimeRelease(value))
    throw new Error("Invalid Rust Node runtime release metadata");
  return value;
}

export function parseRuntimeChecksums(plaintext) {
  if (
    typeof plaintext !== "string" ||
    Buffer.byteLength(plaintext) > 256 * 1024
  )
    throw new Error("Node runtime checksum output exceeded budget");
  const checksums = new Map();
  const lines = plaintext.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
    if (!match || checksums.has(match[2]))
      throw new Error("Invalid or duplicate Node runtime checksum entry");
    checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0) throw new Error("Empty Node runtime checksums");
  return checksums;
}

/** 原始签名/公钥是已锁定的构建输入；失败保留独立工作目录和 GPG 证据。 */
export function verifyRuntimeChecksums({
  release,
  publicKey,
  signedChecksums,
  cache,
  gpgv,
}) {
  if (!validateNodeRuntimeRelease(release))
    throw new Error("Invalid Rust Node runtime release metadata");
  return withVerifiedRuntimeSource(
    {
      publicKey,
      signedMetadata: signedChecksums,
      cache,
      gpgv,
      pins: {
        publicKeySha256: release.upstream.publicKeySha256,
        signedMetadataSha256: release.upstream.checksumsSha256,
        signerFingerprint: release.upstream.signerFingerprint,
      },
    },
    (verified) => {
      const checksums = parseRuntimeChecksums(verified.plaintext);
      for (const target of release.targets)
        if (checksums.get(target.archive.name) !== target.archive.sha256)
          throw new Error("Node archive checksum mismatch");
      return {
        signerFingerprint: verified.signerFingerprint,
        publicKeySha256: verified.publicKeySha256,
        signedChecksumsSha256: verified.signedMetadataSha256,
        status: verified.status,
        checksums,
      };
    },
  );
}
