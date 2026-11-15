import { constants, copyFileSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSha256 } from "./artifact-lib.mjs";
import { projectFile } from "./fs-utils.mjs";

const ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-library-validation": true,
};

/** 仅处理已核对的独立副本；安装侧收据与同次可信构建编入的身份一起使用。 */
export function prepareMacRuntimeImage({
  root,
  stage,
  resources,
  materials,
  executable,
  spec,
  run,
  fingerprintCodesign = () => fileSha256("/usr/bin/codesign"),
}) {
  const before = lstatSync(executable);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    String(before.size) !== spec.executable.size ||
    fileSha256(executable) !== spec.executable.sha256
  )
    throw new Error("Original macOS Node does not match the verified source");
  const policy = projectFile(root, "resources/runtime/node-entitlements.plist"),
    copiedPolicy = join(materials, "node-entitlements.plist");
  copyFileSync(policy, copiedPolicy, constants.COPYFILE_EXCL);
  const policyHash = fileSha256(policy);
  if (fileSha256(copiedPolicy) !== policyHash)
    throw new Error("Node signing policy changed during copying");
  copyFileSync(
    executable,
    join(stage, "node-upstream-original"),
    constants.COPYFILE_EXCL,
  );
  const signArgs = [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime,hard,kill",
    "--timestamp=none",
    "--entitlements",
    copiedPolicy,
    executable,
  ];
  run("/usr/bin/codesign", signArgs, { logBase: join(stage, "node-sign") });
  run(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=4", executable],
    { logBase: join(stage, "node-sign-verify") },
  );
  const displayed = run(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", executable],
    { logBase: join(stage, "node-sign-display") },
  );
  const details = displayed.stderr.toString("utf8"),
    cdhash = details.match(/^CDHash=([a-f0-9]{40})$/m)?.[1],
    flags = details.match(/\bflags=0x([a-f\d]+)/i)?.[1];
  if (!cdhash || !flags || (Number.parseInt(flags, 16) & 0x10300) !== 0x10300)
    throw new Error(
      "Prepared macOS Node lacks the required signing identity or enforcement flags",
    );
  const entitlementOutput = run(
    "/usr/bin/codesign",
    ["--display", "--entitlements", ":-", executable],
    { logBase: join(stage, "node-sign-entitlements") },
  );
  const parsed = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: entitlementOutput.stdout,
    stdio: ["pipe", "pipe", "pipe"],
    logBase: join(stage, "node-sign-entitlements-json"),
  });
  const actual = JSON.parse(parsed.stdout.toString("utf8"));
  if (
    Object.keys(actual).length !== Object.keys(ENTITLEMENTS).length ||
    Object.entries(ENTITLEMENTS).some(([key, value]) => actual[key] !== value)
  )
    throw new Error("Prepared macOS Node has an unexpected entitlement policy");
  const identity = {
    schemaVersion: "0.1",
    target: spec.target,
    sourceSha256: spec.executable.sha256,
    size: String(lstatSync(executable).size),
    sha256: fileSha256(executable),
    codeDirectoryHash: cdhash,
    entitlementsSha256: policyHash,
  };
  const binding = join(resources, "runtime", "node-image.json");
  const json = JSON.stringify(identity, null, 2) + "\n";
  writeFileSync(binding, json, { flag: "wx" });
  writeFileSync(join(materials, "node-image.json"), json, { flag: "wx" });
  const osBuild = run("/usr/bin/sw_vers", ["-buildVersion"], {
    logBase: join(stage, "node-sign-os-build"),
  })
    .stdout.toString("utf8")
    .trim();
  const record = {
    schemaVersion: 1,
    mode: "ad-hoc-development",
    source: spec.executable,
    identity,
    entitlements: ENTITLEMENTS,
    command: { program: "/usr/bin/codesign", args: signArgs },
    tool: { osBuild, codesignSha256: fingerprintCodesign() },
  };
  writeFileSync(
    join(stage, "node-resigning.json"),
    JSON.stringify(record, null, 2) + "\n",
    { flag: "wx" },
  );
  return { binding, identity, record };
}
