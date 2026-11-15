import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadNodeRuntimeRelease,
  parseRuntimeChecksums,
  verifyRuntimeChecksums,
} from "./node-runtime-source.mjs";

const root = resolve(import.meta.dirname, "..");
const release = () => loadNodeRuntimeRelease(root);
function inputs(t) {
  const cache = mkdtempSync(join(tmpdir(), "runtime 源-source-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  return {
    release: release(),
    cache,
    publicKey: readFileSync(
      join(root, "resources/runtime/node-release-key.gpg"),
    ),
    signedChecksums: readFileSync(
      join(root, "resources/runtime/SHASUMS256.txt.asc"),
    ),
  };
}

test("verifies actual upstream signed checksums using only the pinned public key", (t) => {
  const result = verifyRuntimeChecksums(inputs(t));
  assert.equal(result.signerFingerprint, release().upstream.signerFingerprint);
  for (const target of release().targets)
    assert.equal(
      result.checksums.get(target.archive.name),
      target.archive.sha256,
    );
});

test("rejects changed key or signed bytes and refuses an unexpected valid signer", (t) => {
  const good = inputs(t);
  const key = Buffer.from(good.publicKey);
  key[0] ^= 1;
  assert.throws(
    () => verifyRuntimeChecksums({ ...good, publicKey: key }),
    /key.*hash/i,
  );
  const signature = Buffer.from(good.signedChecksums);
  signature[signature.length - 1] ^= 1;
  assert.throws(
    () => verifyRuntimeChecksums({ ...good, signedChecksums: signature }),
    /signed.*hash/i,
  );
  const other = structuredClone(good.release);
  other.upstream.signerFingerprint = "A".repeat(40);
  assert.throws(
    () => verifyRuntimeChecksums({ ...good, release: other }),
    /signer/i,
  );
  const mismatch = structuredClone(good.release);
  mismatch.targets[0].archive.sha256 = "0".repeat(64);
  assert.throws(
    () => verifyRuntimeChecksums({ ...good, release: mismatch }),
    /archive.*checksum/i,
  );
});

test("rejects duplicate, malformed and oversized checksum output", () => {
  const entry = "0".repeat(64) + "  node.zip\n";
  assert.equal(parseRuntimeChecksums(entry).get("node.zip"), "0".repeat(64));
  for (const value of [
    entry + entry,
    "malformed\n",
    entry + " ",
    "x".repeat(256 * 1024 + 1),
  ])
    assert.throws(() => parseRuntimeChecksums(value));
});

test("retains evidence when the verifier process cannot start", (t) => {
  const data = inputs(t);
  assert.throws(
    () =>
      verifyRuntimeChecksums({
        ...data,
        gpgv: join(data.cache, "missing-gpgv"),
      }),
    /signature verification failed.*evidence retained/,
  );
  const directories = readdirSync(data.cache);
  assert.equal(directories.length, 1);
  assert.ok(existsSync(join(data.cache, directories[0], "gpg-error.txt")));
});
