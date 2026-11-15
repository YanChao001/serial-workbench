import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadNodeRuntimeLibrary,
  verifyRuntimeLibrarySources,
} from "./node-runtime-library-source.mjs";

const root = resolve(import.meta.dirname, "..");
function cache(t) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-lib-源-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("verifies actual Ubuntu signature, both indexes and complete matching source artifacts offline", (t) => {
  const release = loadNodeRuntimeLibrary(root);
  const receipt = verifyRuntimeLibrarySources({ root, cache: cache(t) });
  assert.equal(
    receipt.signerFingerprint,
    "F6ECB3762474EDA9D21B7022871920D1991BC93C",
  );
  assert.equal(receipt.artifacts.length, 5);
  assert.deepEqual(receipt.artifacts, release.artifacts);
});

test("rejects index, binary and corresponding-source hashes that disagree with signed Ubuntu metadata", (t) => {
  const scratch = cache(t);
  for (const mutate of [
    (value) => {
      value.upstream.packageIndex.sha256 = "0".repeat(64);
    },
    (value) => {
      value.artifacts[0].sha256 = "0".repeat(64);
    },
    (value) => {
      value.artifacts[2].sha256 = "0".repeat(64);
    },
    (value) => {
      value.gplLicense.sha256 = "0".repeat(64);
    },
  ]) {
    const release = structuredClone(loadNodeRuntimeLibrary(root));
    mutate(release);
    assert.throws(
      () => verifyRuntimeLibrarySources({ root, cache: scratch, release }),
      /hash|artifact|checksum/i,
    );
  }
});
