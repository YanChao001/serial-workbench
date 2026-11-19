import { createHash } from "node:crypto";
import {
  copyFileSync,
  constants,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateNodeSourceApproveParams } from "../packages/contracts/src/generated/validators.mjs";
import { fileSha256 } from "../scripts/artifact-lib.mjs";

const INPUTS = [
  ["beforeClose", "terminal-reader-open\n"],
  ["whileClosed", "terminal-reader-closed\n"],
  ["afterReopen", "terminal-reader-reopened\n"],
];

export function readSignedReferenceFixture(receiptPath, reference) {
  if (!receiptPath || !isAbsolute(receiptPath))
    throw new Error(
      `Set SWB_TEST_SIGNED_${reference.toUpperCase()}_RECEIPT to an absolute signed ${reference} receipt path.`,
    );
  const { archive, archiveSha256, sourceApproval } = JSON.parse(
    readFileSync(receiptPath, "utf8"),
  );
  if (
    typeof archive !== "string" ||
    !isAbsolute(archive) ||
    typeof archiveSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(archiveSha256) ||
    !validateNodeSourceApproveParams(sourceApproval)
  )
    throw new Error(`Invalid signed ${reference} receipt.`);
  const key = Buffer.from(sourceApproval.publicKey);
  if (
    createHash("sha256").update(key).digest("hex") !==
    sourceApproval.publicKeySha256
  )
    throw new Error(
      `Signed ${reference} public key does not match its receipt.`,
    );
  const archiveInfo = lstatSync(archive);
  if (
    !archiveInfo.isFile() ||
    archiveInfo.isSymbolicLink() ||
    fileSha256(archive) !== archiveSha256
  )
    throw new Error(`Signed ${reference} archive does not match its receipt.`);
  return {
    archive,
    archiveSha256,
    sourceApproval,
    publicKeyHex: key.toString("hex"),
  };
}

export function prepareSignedReferenceEvidence(fixture, directory, reference) {
  const archive = join(directory, `reference-${reference}.zip`);
  copyFileSync(fixture.archive, archive, constants.COPYFILE_EXCL);
  if (fileSha256(archive) !== fixture.archiveSha256)
    throw new Error(
      `Signed ${reference} archive changed during evidence preparation.`,
    );
  return {
    archive,
    archiveSha256: fixture.archiveSha256,
    source: fixture.sourceApproval.source,
    keyId: fixture.sourceApproval.keyId,
    publicKeyHex: fixture.publicKeyHex,
  };
}

export function prepareTerminalEvidence(fixture, directory) {
  const signed = prepareSignedReferenceEvidence(fixture, directory, "terminal");
  const capture = join(directory, "terminal.swbcap");
  const expected = join(directory, "expected-rx.bin");
  const writes = Object.fromEntries(
    INPUTS.map(([phase, value]) => [phase, Buffer.from(value).toString("hex")]),
  );
  writeFileSync(
    expected,
    Buffer.from(INPUTS.map(([, value]) => value).join("")),
    { flag: "wx" },
  );
  const plan = {
    ...signed,
    capture,
    expected,
    writes,
  };
  const path = join(directory, "terminal-inputs.json");
  writeFileSync(path, JSON.stringify(plan, null, 2), { flag: "wx" });
  return { ...plan, path };
}
