// @vitest-environment node
/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  NodePackageDetailsReadParams,
  NodePackageDetailsReadResult,
} from "@serial-workbench/contracts";
import { expect, it } from "vitest";
import { readNodeInstallation } from "./node-management";

const fixtures: { valid: { name: string; value: unknown }[] } = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/src/generated/fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixture = fixtures.valid.find(
  ({ name }) => name === "node-package-complete-details",
)?.value;
const identity = {
  id: "example.terminal",
  archiveSha256: "a".repeat(64),
  expectedRevision: "7",
};

it("checks the digest and assembles UTF-8 package details across byte boundaries", async () => {
  const bytes = Buffer.from(JSON.stringify(fixture), "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const read = async ({
    offset,
  }: NodePackageDetailsReadParams): Promise<NodePackageDetailsReadResult> => ({
    id: identity.id,
    archiveSha256: identity.archiveSha256,
    revision: identity.expectedRevision,
    jsonSha256: digest,
    totalBytes: String(bytes.length),
    offset,
    bytesBase64: bytes
      .subarray(
        Number(offset),
        offset === "0" ? bytes.indexOf(Buffer.from("参考")) + 1 : undefined,
      )
      .toString("base64"),
  });
  await expect(readNodeInstallation(identity, read)).resolves.toEqual(fixture);
  await expect(
    readNodeInstallation(identity, async (params) => {
      const page = await read(params);
      return params.offset === "0" ? page : { ...page, revision: "8" };
    }),
  ).rejects.toThrow("Plugin details snapshot changed");
  await expect(
    readNodeInstallation(identity, async (params) => ({
      ...(await read(params)),
      jsonSha256: "0".repeat(64),
    })),
  ).rejects.toThrow("Plugin details digest mismatch");
});
