import { readFileSync } from "node:fs";
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import type { NodePackageInstallation } from "@serial-workbench/contracts";

export function xyCaptureFixture() {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-statistics/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid statistics manifest");
  const action = manifest.contributes.actions.find(
    ({ actionId }) => actionId === "swb.reference.statistics.alignXY",
  );
  if (!action) throw new Error("Missing professional XY action");
  const archiveSha256 = "e".repeat(64);
  const verifiedSource = {
    source: "Workbench",
    keyId: "statistics-signing",
    publicKeySha256: "f".repeat(64),
  };
  const installation = {
    manifest,
    archiveSha256,
    verifiedSource,
    enabled: true,
    executionTrust: {
      archiveSha256,
      permissions: manifest.permissions,
      verifiedSource,
    },
  } satisfies NodePackageInstallation;
  const archive = {
    reference: {
      kind: "file",
      id: "reference-statistics",
      hostId: "workbench-gui-host",
    },
    name: "statistics.zip",
    length: "4096",
    mime: "application/zip",
  };
  return {
    action,
    plugin: { archive, installation, initiallyInstalled: true },
  };
}
