import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { $, browser } from "@wdio/globals";
import { startMcpFixture } from "../mcp-fixture.mjs";
import { sessionScopes } from "../session-scopes.mjs";
import { hostQuery } from "../settings.mjs";

const execute = promisify(execFile);
export const handoff = process.env.STARTER_E2E_LAN_HANDOFF;
export const ownerProfile = process.env.STARTER_E2E_LAN_OWNER_PROFILE;
export const callerProfile = process.env.STARTER_E2E_LAN_CALLER_PROFILE;
export const selected = "native-lan-selected";
export const sibling = "native-lan-sibling";

export async function cli(profile, ...args) {
  const { stdout } = await execute(
    process.env.STARTER_E2E_CLI,
    ["--profile", profile, ...args, "--json"],
    { windowsHide: true, timeout: 15_000 },
  );
  const reply = JSON.parse(stdout);
  assert.notEqual(reply.ok, false);
  return reply.result;
}

export async function paramsFile(params) {
  const file = join(process.env.STARTER_E2E_DATA_ROOT, randomUUID() + ".json");
  await writeFile(file, JSON.stringify(params), { flag: "wx" });
  return file;
}

export async function discovery(profile) {
  const { hostId, instanceEpoch, pid } = JSON.parse(
    await readFile(join(profile, "host-v0", "discovery.json"), "utf8"),
  );
  return { hostId, instanceEpoch, pid };
}

export async function liveSession() {
  const { value } = await hostQuery("state.scopes", "host");
  const sessions = sessionScopes(value.scopes);
  assert.equal(sessions.length, 1);
  return sessions[0].target;
}

export function connectAssistant(clientId, route) {
  return startMcpFixture({
    binary: process.env.STARTER_E2E_MCP,
    profile: callerProfile,
    clientId,
    host: process.env.SWB_DEV_EXPECTED_HOST_EXECUTABLE,
    route,
  });
}

export function sendParams(text) {
  return {
    bytesBase64: Buffer.from(text).toString("base64"),
    writeWaitMs: "1000",
  };
}

export async function waitForEcho(text) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (marker) =>
          [
            ...document.querySelectorAll(
              '.workbench-stream-row[data-direction="rx"]',
            ),
          ].some((row) => row.textContent.includes(marker)),
        text,
      ),
    { timeoutMsg: `The serial receive log did not show ${text}` },
  );
}

export const sendDraft = () =>
  $("//textarea[@id=//label[normalize-space()='Send draft']/@for]");

export function evidence(name) {
  return join(
    process.env.STARTER_E2E_LAN_DIR,
    process.env.STARTER_E2E_PHASE,
    name,
  );
}
