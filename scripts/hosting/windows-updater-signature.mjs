import { constants, copyFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Sign one finalized NSIS artifact twice under distinct trusted filenames.
 * The suite is staged again before the signature may be used for updates.
 */
export function bindWindowsUpdaterSignature({
  artifact,
  version,
  publicKey,
  activeInstall,
  directory,
  sign,
  runStage,
}) {
  const request = { activeInstall, artifact, publicKey, version };
  const measurement = join(directory, "serial-workbench-nsis-stage-v1.exe");
  copyFileSync(artifact, measurement, constants.COPYFILE_EXCL);
  sign(measurement, version);
  const measured = runStage("--measure-windows-nsis", {
    ...request,
    signature: `${measurement}.sig`,
  });
  if (
    measured?.version !== version ||
    measured.suiteVerified !== false ||
    typeof measured.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(measured.digest)
  ) {
    throw new Error("Invalid Windows update suite measurement");
  }

  const bound = join(
    directory,
    `serial-workbench-nsis-stage-v2-${measured.digest}.exe`,
  );
  copyFileSync(measurement, bound, constants.COPYFILE_EXCL);
  sign(bound, version);
  const signature = `${bound}.sig`;
  const release = runStage("--stage-windows-nsis", { ...request, signature });
  if (
    release?.version !== version ||
    release.suiteVerified !== true ||
    release.digest !== measured.digest
  ) {
    throw new Error("Windows update stage did not verify the signed suite");
  }
  return { signature, release };
}
