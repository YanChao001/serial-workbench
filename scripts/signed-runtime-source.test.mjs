import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { removeProjectPath } from "./fs-utils.mjs";
import { withVerifiedRuntimeSource } from "./signed-runtime-source.mjs";

function fixture(t, { exit = 0, signer = "A".repeat(40) } = {}) {
  const root = resolve(import.meta.dirname, ".."),
    parent = join(root, ".cache/script-tests");
  mkdirSync(parent, { recursive: true });
  const cache = mkdtempSync(join(parent, "signed-output-"));
  t.after(() => {
    if (t.passed) removeProjectPath(root, relative(root, cache));
  });
  const publicKey = Buffer.from("fixed public key fixture"),
    signedMetadata = Buffer.from("fixed signed metadata fixture");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return {
    cache,
    publicKey,
    signedMetadata,
    pins: {
      publicKeySha256: hash(publicKey),
      signedMetadataSha256: hash(signedMetadata),
      signerFingerprint: "A".repeat(40),
    },
    runGpgv: (_program, args, options) => {
      const output = args[args.indexOf("--output") + 1],
        status = `[GNUPG:] VALIDSIG ${signer} 2026-11-15\n`;
      // 来自实际 2.5.24 故障的输出形态；不能把残留 part 当作已提交的明文。
      writeFileSync(
        join(options.cwd, "verified.txt.part"),
        "unverified partial output",
      );
      if (output !== "-")
        return { status: exit, stdout: status, stderr: "GPG fixture" };
      return { status: exit, stdout: "signed output\n", stderr: status };
    },
  };
}

test("receives verified stdout without relying on GnuPG partial-file promotion", (t) => {
  const input = fixture(t);
  const value = withVerifiedRuntimeSource(input, (verified) => {
    assert.equal(verified.plaintext, "signed output\n");
    const directory = join(input.cache, readdirSync(input.cache)[0]);
    assert.equal(
      readFileSync(join(directory, "verified.txt"), "utf8"),
      "signed output\n",
    );
    return verified.signerFingerprint;
  });
  assert.equal(value, "A".repeat(40));
  assert.deepEqual(readdirSync(input.cache), []);
});
for (const [name, options, message] of [
  ["nonzero verifier", { exit: 1 }, /signature verification failed/],
  [
    "unexpected signer",
    { signer: "B".repeat(40) },
    /Unexpected runtime source signer/,
  ],
])
  test(`does not consume plaintext from ${name}`, (t) => {
    const input = fixture(t, options);
    let consumed = false;
    assert.throws(
      () =>
        withVerifiedRuntimeSource(input, () => {
          consumed = true;
        }),
      message,
    );
    assert.equal(consumed, false);
    const directory = join(input.cache, readdirSync(input.cache)[0]);
    assert.equal(existsSync(join(directory, "verified.txt")), false);
    assert.equal(existsSync(join(directory, "signed.asc")), true);
  });
