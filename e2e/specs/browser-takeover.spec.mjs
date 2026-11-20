import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { language, navigate, ready } from "../helpers.mjs";
import { startMcpFixture } from "../mcp-fixture.mjs";
import { sessionScopes } from "../session-scopes.mjs";
import { hostQuery } from "../settings.mjs";
import { byText, button, click, dialogButton } from "./reference-plugin.mjs";
import { openVirtual } from "./workbench.mjs";

const execute = promisify(execFile);
const profile = process.env.SWB_PROFILE;
const selectedClient = "native-bench-primary";
const otherClient = "native-bench-secondary";
const configureBrowser = () =>
  $("button[aria-label='Configure browser access']");

async function openPairing() {
  await click(configureBrowser());
  await click($("#desktop-browser-mode"));
  await click(byText("*[@role='option']", "View and operate"));
  await click(dialogButton("Generate pairing code"));
  try {
    const field = $("#desktop-browser-code");
    await field.waitForDisplayed();
    const code = await field.getValue();
    const url = await byText("a", "Open in browser").getAttribute("href");
    assert.ok(
      /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url),
      "Expected a loopback browser entry",
    );
    assert.ok(
      /^[A-Za-z0-9_-]{43}$/.test(code),
      "Expected a one-time pairing code",
    );
    return { url, code };
  } finally {
    await browser.keys(Key.Escape);
    await $("#desktop-browser-code").waitForExist({ reverse: true });
  }
}

async function grantWrites(clientId, target) {
  const params = join(
    process.env.STARTER_E2E_DATA_ROOT,
    `${clientId}-grant.json`,
  );
  await writeFile(
    params,
    JSON.stringify({
      clientId,
      permissions: ["device.modify"],
      targets: [target],
    }),
  );
  const { stdout } = await execute(
    process.env.STARTER_E2E_CLI,
    ["--profile", profile, "authorize", "--params-json", params, "--json"],
    { windowsHide: true, timeout: 15_000 },
  );
  assert.equal(JSON.parse(stdout).result.operation.actionId, "auth.authorize");
}

async function liveSession() {
  const scopes = await hostQuery("state.scopes", "host");
  const active = sessionScopes(scopes.value.scopes);
  assert.equal(active.length, 1);
  return active[0].target;
}

/* global describe, it */
describe("Desktop browser takeover", () => {
  it("pairs from desktop settings and confirms only the selected MCP client for the live port", async () => {
    await ready();
    await language("en");
    await navigate("/");
    await openVirtual();
    const target = await liveSession();
    const assistants = [];
    const web = await chromium.launch({ headless: true });
    try {
      for (const clientId of [selectedClient, otherClient]) {
        const assistant = await startMcpFixture({
          binary: process.env.STARTER_E2E_MCP,
          profile,
          clientId,
          host: process.env.SWB_DEV_EXPECTED_HOST_EXECUTABLE,
        });
        assistants.push(assistant);
        await assistant.call("swb_session_x2E_get", target);
        await grantWrites(clientId, target);
      }
      const serial = { bytesBase64: "U1RBVFVTPw==", writeWaitMs: "1000" };
      const allowed = async (assistant) => {
        const checked = await assistant.call("swb_action_x2E_check", target, {
          actionId: "session.tx",
          params: serial,
        });
        return checked.allowed;
      };
      assert.equal(await allowed(assistants[0]), true);
      assert.equal(await allowed(assistants[1]), true);

      await navigate("/settings");
      const { url, code } = await openPairing();
      const page = await web.newPage();
      const liveSockets = new Set();
      page.on("websocket", (socket) => {
        liveSockets.add(socket);
        socket.on("close", () => liveSockets.delete(socket));
      });
      await page.goto(url);
      await page.getByLabel(/^(Pairing code|配对码)$/).fill(code);
      await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
      await page.locator(".workbench-device-select").click();
      await page
        .getByRole("option", { name: "virtual:echo", exact: true })
        .click();
      await page.getByRole("button", { name: "Open virtual:echo" }).click();
      await expect(
        page.getByRole("button", { name: "Close session" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await page.getByRole("combobox", { name: "AI client to follow" }).click();
      await page
        .getByRole("option", { name: selectedClient, exact: true })
        .click();
      await page
        .getByRole("button", { name: "Request control of virtual:echo" })
        .click();

      await byText(
        "p",
        `The browser asks to stop ${selectedClient} from writing to virtual:echo.`,
      ).waitForDisplayed();
      const activity = await hostQuery("state.snapshot", "host", undefined, {
        scopeId: "host.activity",
      });
      assert.equal(
        activity.value.state.pendingTakeover?.clientId,
        selectedClient,
      );
      assert.deepEqual(activity.value.state.pendingTakeover?.target, target);
      const output = join(
        process.env.STARTER_E2E_BROWSER_DIR,
        "browser-takeover",
      );
      await browser.saveScreenshot(join(output, "native-confirmation.png"));
      await click(button("Confirm takeover"));
      await expect(
        page.getByText("AI write access to this port was revoked."),
      ).toBeVisible();
      assert.equal(await allowed(assistants[0]), false);
      // 当前身份失去唯一的串口写入授权，MCP 目录随即移除发送工具。
      await assert.rejects(
        assistants[0].call("swb_session_x2E_tx", target, {
          ...serial,
          bytesBase64: Buffer.from(
            "selected MCP denied after takeover",
          ).toString("base64"),
        }),
        { code: -32601 },
      );
      assert.equal(await allowed(assistants[1]), true);
      assert.deepEqual(await liveSession(), target);

      await click(configureBrowser());
      assert.ok(
        liveSockets.size > 0,
        "Expected active browser connections before revocation",
      );
      await click(dialogButton("Turn off browser access"));
      await expect.poll(() => liveSockets.size).toBe(0);
      const marker = "MCP echo after browser revocation";
      const sent = await assistants[1].call("swb_session_x2E_tx", target, {
        ...serial,
        bytesBase64: Buffer.from(marker).toString("base64"),
      });
      assert.equal(sent.actionId, "session.tx");
      await browser.keys(Key.Escape);
      await navigate("/");
      await browser.waitUntil(() =>
        browser.execute(
          (text) =>
            [
              ...document.querySelectorAll(
                '.workbench-stream-row[data-direction="rx"]',
              ),
            ].some((row) => row.textContent.includes(text)),
          marker,
        ),
      );
      assert.deepEqual(await liveSession(), target);
      await writeFile(
        join(output, "receipt.json"),
        JSON.stringify(
          {
            target,
            selectedClient,
            otherClient,
            pairedFromNativeSettings: true,
            nativeApprovalRevokedSelectedMcpOnly: true,
            browserObservedTakeoverTerminal: true,
            browserRevokedWhileSerialSessionRemainedOpen: true,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await web.close();
      for (const assistant of assistants) await assistant.stop();
    }
  });
});
