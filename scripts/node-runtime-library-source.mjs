import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { validateNodeRuntimeLibraryRelease } from "../packages/contracts/src/generated/validators.mjs";
import { projectFile } from "./fs-utils.mjs";
import { withVerifiedRuntimeSource } from "./signed-runtime-source.mjs";

/** @returns {import('../packages/contracts/src/generated/types.ts').NodeRuntimeLibraryRelease} */
export function loadNodeRuntimeLibrary(root) {
  const value = JSON.parse(
    readFileSync(
      projectFile(root, "resources/runtime/libatomic-jammy.json"),
      "utf8",
    ),
  );
  if (!validateNodeRuntimeLibraryRelease(value))
    throw new Error("Invalid Rust runtime library metadata");
  return value;
}

function readEvidence(root, file) {
  const location = projectFile(root, file.bundledPath);
  const size = statSync(location).size;
  if (size > 8 * 1024 * 1024 || BigInt(size) !== BigInt(file.size))
    throw new Error("Runtime repository evidence size mismatch");
  const body = readFileSync(location);
  if (createHash("sha256").update(body).digest("hex") !== file.sha256)
    throw new Error("Runtime repository evidence hash mismatch");
  return body;
}

function checksumRows(value) {
  const result = new Map();
  for (const line of value.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+(0|[1-9][0-9]*)\s+(\S+)$/.exec(
      line.trim(),
    );
    if (!match || result.has(match[3]))
      throw new Error("Invalid or duplicate repository checksum");
    result.set(match[3], { sha256: match[1], size: match[2] });
  }
  return result;
}

function* controlRecords(bytes) {
  const text = gunzipSync(bytes, {
    maxOutputLength: 64 * 1024 * 1024,
  }).toString("utf8");
  for (const block of text.split(/\n\n/)) {
    if (!block) continue;
    const fields = Object.create(null);
    let key;
    for (const line of block.split("\n")) {
      if (!line) continue;
      if (/^[ \t]/.test(line)) {
        if (!key) throw new Error("Invalid repository control continuation");
        fields[key] += "\n" + line;
        continue;
      }
      const match = /^([^:]+):\s?(.*)$/.exec(line);
      if (!match || Object.hasOwn(fields, match[1]))
        throw new Error("Duplicate or malformed repository control field");
      key = match[1];
      fields[key] = match[2];
    }
    yield fields;
  }
}

function selectedRecord(records, predicate) {
  let selected;
  for (const record of records)
    if (predicate(record)) {
      if (selected) throw new Error("Ambiguous repository artifact");
      selected = record;
    }
  if (!selected) throw new Error("Missing repository artifact");
  return selected;
}

/** 原始签名、压缩索引和最终文件 pin 分别核对，断网复核不依赖滚动仓库索引。 */
export function verifyRuntimeLibrarySources({
  root,
  cache,
  release = loadNodeRuntimeLibrary(root),
  gpgv,
}) {
  if (!validateNodeRuntimeLibraryRelease(release))
    throw new Error("Invalid Rust runtime library metadata");
  const upstream = release.upstream;
  const key = readEvidence(root, upstream.keyring),
    signed = readEvidence(root, upstream.inRelease);
  const packageIndex = readEvidence(root, upstream.packageIndex),
    sourceIndex = readEvidence(root, upstream.sourceIndex);
  for (const [path, expected] of [
    [release.copyrightSourcePath, release.copyright],
    [release.gplSourcePath, release.gplLicense],
  ]) {
    const text = readFileSync(projectFile(root, path));
    if (
      String(text.length) !== expected.size ||
      createHash("sha256").update(text).digest("hex") !== expected.sha256
    )
      throw new Error("Runtime library license hash mismatch");
  }
  return withVerifiedRuntimeSource(
    {
      publicKey: key,
      signedMetadata: signed,
      cache,
      gpgv,
      pins: {
        publicKeySha256: upstream.keyring.sha256,
        signedMetadataSha256: upstream.inRelease.sha256,
        signerFingerprint: upstream.signerFingerprint,
      },
    },
    (verified) => {
      const shaSection = verified.plaintext.match(
        /^SHA256:\n((?:[ \t].*\n)+)/m,
      )?.[1];
      if (!shaSection)
        throw new Error("Missing signed repository checksum table");
      const indexes = checksumRows(shaSection);
      for (const file of [upstream.packageIndex, upstream.sourceIndex]) {
        const entry = indexes.get(
          file.repositoryPath.replace(/^dists\/jammy-updates\//, ""),
        );
        if (entry?.sha256 !== file.sha256 || entry?.size !== file.size)
          throw new Error("Signed repository index checksum mismatch");
      }
      const binary = release.artifacts.filter((a) => a.kind === "binary");
      for (const artifact of binary) {
        const record = selectedRecord(
          controlRecords(packageIndex),
          (r) =>
            r.Package === artifact.package &&
            r.Version === artifact.version &&
            r.Architecture === release.architecture,
        );
        const source = /^(\S+)(?: \(([^()]+)\))?$/.exec(
          record.Source ?? record.Package,
        );
        if (
          record.Filename !== artifact.filename ||
          record.Size !== artifact.size ||
          record.SHA256 !== artifact.sha256 ||
          source?.[1] !== "gcc-12" ||
          (source?.[2] ?? record.Version) !== release.version
        )
          throw new Error(
            "Signed binary artifact checksum or identity mismatch",
          );
      }
      const source = selectedRecord(
        controlRecords(sourceIndex),
        (r) => r.Package === "gcc-12" && r.Version === release.version,
      );
      const sourceFiles = checksumRows(source["Checksums-Sha256"] ?? "");
      const selected = release.artifacts.filter(
        (a) => a.kind === "correspondingSource",
      );
      if (sourceFiles.size !== selected.length)
        throw new Error("Incomplete corresponding source artifacts");
      for (const artifact of selected) {
        const filename = artifact.filename.slice(source.Directory.length + 1),
          entry = sourceFiles.get(filename);
        if (
          artifact.package !== source.Package ||
          !artifact.filename.startsWith(source.Directory + "/") ||
          entry?.sha256 !== artifact.sha256 ||
          entry?.size !== artifact.size
        )
          throw new Error(
            "Signed corresponding-source artifact checksum mismatch",
          );
      }
      return {
        signerFingerprint: verified.signerFingerprint,
        status: verified.status,
        inReleaseSha256: verified.signedMetadataSha256,
        packageIndexSha256: upstream.packageIndex.sha256,
        sourceIndexSha256: upstream.sourceIndex.sha256,
        artifacts: release.artifacts,
      };
    },
  );
}
