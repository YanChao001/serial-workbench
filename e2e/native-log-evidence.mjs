import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// 只检查本套件不主动注入的请求冲突；Host 重启、撤权等已安排的故障仍由所属场景判定。
export function checkNativeRequestDiagnostics(logPath, evidencePath) {
  let bytes;
  try {
    bytes = readFileSync(logPath);
  } catch {
    writeFileSync(
      evidencePath,
      JSON.stringify({ observed: false, passed: false }) + "\n",
    );
    throw new Error("Owned Native request diagnostics could not be read");
  }
  const text = bytes.toString("utf8");
  const evidence = {
    observed: bytes.length > 0,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    conflictWarnings: [...text.matchAll(/RPC_REQUEST_CONFLICT(?:\s|$)/g)]
      .length,
    frontendConflicts: [
      ...text.matchAll(/This request is already pending on the connection/g),
    ].length,
    subscriptionConflicts: [
      ...text.matchAll(/Subscription request is already pending/g),
    ].length,
    subscriptionWarnings: [
      ...text.matchAll(/NATIVE_SUBSCRIPTION_CONFLICT(?:\s|$)/g),
    ].length,
  };
  evidence.passed =
    evidence.observed &&
    evidence.conflictWarnings === 0 &&
    evidence.frontendConflicts === 0 &&
    evidence.subscriptionConflicts === 0 &&
    evidence.subscriptionWarnings === 0;
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  if (!evidence.passed)
    throw new Error(
      "Owned Native log retained an unexpected in-flight request conflict or had no observations",
    );
  return evidence;
}
