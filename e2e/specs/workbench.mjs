import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { openDeepLink } from "../helpers.mjs";
import { hostQuery, nativeValue } from "../settings.mjs";

async function openTool(name) {
  await $("button[aria-label='Workspace menu']").click();
  // 原生驱动的 HTMLElement.click() 不生成 pointerdown；用真实键盘入口展开菜单。
  await browser.keys(Key.ArrowDown);
  const item = await $(
    "//*[@role='menuitem'][normalize-space()='" + name + "']",
  );
  await item.waitForDisplayed();
  await item.click();
  await $("[role=dialog]").waitForDisplayed();
}
const field = (name) => $("//label[normalize-space()='" + name + "']//input");
const sendDraft = () =>
  $("//textarea[@id=//label[normalize-space()='Send draft']/@for]");
async function clickEnabled(selector) {
  const button = await $(selector);
  await button.waitForEnabled();
  await button.click();
  return button;
}
async function saveDrafts() {
  const button = await clickEnabled("button=Save drafts");
  await button.waitForEnabled({ reverse: true });
}
async function selectDraftTab(name, expectedDraft) {
  const tab = await $("//*[@role='tab'][normalize-space()='" + name + "']");
  await tab.click();
  await browser.waitUntil(async () => {
    const currentTab = await $(
      "//*[@role='tab'][normalize-space()='" + name + "']",
    );
    return (
      (await currentTab.getAttribute("aria-selected")) === "true" &&
      (await (await sendDraft()).getValue()) === expectedDraft
    );
  });
  return sendDraft();
}
const workspace = async () => {
  const result = await hostQuery("workspace.read", "workspace", "default");
  assert.equal(result.kind, "workspace");
  return result.value;
};
async function selectVirtual() {
  const choose = await $(".workbench-device-select");
  await choose.waitForEnabled();
  await choose.click();
  await $("//*[@role='option'][normalize-space()='virtual:echo']").click();
}
async function openVirtual() {
  await selectVirtual();
  const open = await $("button[aria-label='Open virtual:echo']");
  await open.waitForEnabled();
  await open.click();
  await $("button=Close session").waitForEnabled();
}

export function workbenchChecks() {
  it("edits and clones saved views through the real workspace menu and preserves independent drafts", async () => {
    await openDeepLink("/");
    await openVirtual();
    const before = await workspace();
    const saveLayout = await $("button[aria-label='Save current layout']");
    await saveLayout.click();
    await browser.waitUntil(async () => {
      const saved = await workspace();
      return (
        BigInt(saved.document.revision) > BigInt(before.document.revision) &&
        saved.document.value.views.length === 1
      );
    });
    await saveLayout.waitForEnabled();
    await openTool("Workspace");
    await (await field("View name")).setValue("Original view");
    await $("button=Clone view").click();
    await (await field("View name")).setValue("Clone view");
    await $("button=Save workspace").click();
    let saved;
    await browser.waitUntil(async () => {
      saved = await workspace();
      return (
        saved.document.value.views.map((view) => view.name).join("|") ===
        "Original view|Clone view"
      );
    });
    assert.ok(
      BigInt(saved.document.revision) > BigInt(before.document.revision),
    );
    assert.equal(saved.document.value.bindings.length, 2);
    assert.ok(
      saved.document.value.bindings.every(
        (binding) => binding.deviceId === "virtual:echo",
      ),
    );
    await browser.keys(Key.Escape);
    await $("[role=dialog]").waitForExist({ reverse: true });
    await browser.refresh();
    const original = await $(
      "//*[@role='tab'][normalize-space()='Original view']",
    );
    await original.waitForExist();
    await original.click();
    // 恢复模板只恢复视图；显式打开 Virtual 才关联仍在运行的 Host 会话。
    await openVirtual();
    await (await sendDraft()).setValue("ORIGINAL UNSENT");
    const cloneDraft = await selectDraftTab("Clone view", "");
    await cloneDraft.setValue("CLONE UNSENT");
    await selectDraftTab("Original view", "ORIGINAL UNSENT");
    await saveDrafts();
    const state = await nativeValue("client_state_read");
    assert.ok(Object.values(state.state.drafts).includes("ORIGINAL UNSENT"));
    assert.ok(Object.values(state.state.drafts).includes("CLONE UNSENT"));
  });

  it("waits for actual configuration completion and renders one TX block with its receipt", async () => {
    await openTool("Connection parameters");
    await (await field("Baud rate")).setValue("250000");
    const apply = await $("button=Apply configuration");
    await apply.waitForEnabled();
    await apply.click();
    await apply.waitForEnabled({ reverse: true });
    assert.equal(await (await field("Baud rate")).getValue(), "250000");
    await browser.keys(Key.Escape);
    await $("[role=dialog]").waitForExist({ reverse: true });
    await $(
      "button[aria-label^='Connection parameters 250000']",
    ).waitForExist();
    const draft = await sendDraft();
    await draft.setValue("M1B-NATIVE-TX");
    await clickEnabled("button=Send");
    await browser.waitUntil(() =>
      browser.execute(() => {
        const rows = [
          ...document.querySelectorAll(
            ".workbench-stream-row[data-direction=tx]",
          ),
        ];
        return (
          rows.filter((row) => row.textContent.includes("M1B-NATIVE-TX"))
            .length === 1 &&
          rows.some((row) => row.textContent.includes("accepted"))
        );
      }),
    );
    await draft.setValue("UNSENT AFTER RESTART");
    await saveDrafts();
  });

  it("reattaches and subscribes after the owned Host restarts without replaying the draft", async () => {
    const previous = await nativeValue("host_attachment");
    const directory = process.env.STARTER_E2E_DATA_ROOT;
    const id = randomUUID();
    const request = join(directory, "host-restart-request.json");
    writeFileSync(request + ".tmp", JSON.stringify({ id, action: "restart" }));
    renameSync(request + ".tmp", request);
    let response;
    await browser.waitUntil(() => {
      try {
        response = JSON.parse(
          readFileSync(join(directory, "host-restart-response.json"), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
          return false;
        throw error;
      }
      return response.id === id;
    });
    assert.equal(response.ok, true, response.error);
    assert.equal(response.hostId, previous.attachment.hostId);
    assert.ok(
      BigInt(response.instanceEpoch) >
        BigInt(previous.attachment.instanceEpoch),
    );
    const retry = await $("button=Retry");
    await retry.waitForEnabled();
    await retry.click();
    await retry.waitForExist({ reverse: true });
    assert.equal(
      (await nativeValue("host_attachment")).attachment.instanceEpoch,
      response.instanceEpoch,
    );
    const draft = await sendDraft();
    assert.equal(await draft.getValue(), "UNSENT AFTER RESTART");
    await openVirtual();
    assert.equal(await draft.getValue(), "UNSENT AFTER RESTART");
    const before = await $("[role=log]").getText();
    assert.equal(before.includes("UNSENT AFTER RESTART"), false);
    await draft.setValue("M1B-NEW-HOST");
    await clickEnabled("button=Send");
    await browser.waitUntil(async () =>
      (await $("[role=log]").getText()).includes("M1B-NEW-HOST"),
    );
    await saveDrafts();
    await clickEnabled("button=Close session");
    await $("button[aria-label='Open virtual:echo']").waitForEnabled();
  });
}
