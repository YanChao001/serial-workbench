import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { openDeepLink } from "../helpers.mjs";
import { hostQuery, nativeValue } from "../settings.mjs";

async function openTool(name) {
  const direct = await $(
    ".workbench-connection button[aria-label=" + JSON.stringify(name) + "]",
  );
  if (await direct.isDisplayed()) {
    await direct.waitForEnabled();
    await direct.click();
  } else {
    await $("button[aria-label='Workspace menu']").click();
    // 原生驱动的 HTMLElement.click() 不生成 pointerdown；用真实键盘入口展开菜单。
    await browser.keys(Key.ArrowDown);
    const item = await $(
      "//*[@role='menuitem'][normalize-space()='" + name + "']",
    );
    await item.waitForDisplayed();
    await item.click();
  }
  await $("[role=dialog]").waitForDisplayed();
}
const field = (name) =>
  $(
    "//input[@id=//label[normalize-space()='" +
      name +
      "']/@for] | " +
      "//label[normalize-space()='" +
      name +
      "']//input",
  );
const sendDraft = () =>
  $("//textarea[@id=//label[normalize-space()='Send draft']/@for]");
async function clickEnabled(selector) {
  const button = await $(selector);
  await button.waitForEnabled();
  await button.click();
  return button;
}
async function saveDrafts() {
  const button = await clickEnabled("button[aria-label='Save drafts']");
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
  await $("button[aria-label='Close session']").waitForEnabled();
}

async function closeVirtualWithoutReaderFault() {
  const { attachment } = await nativeValue("host_attachment");
  async function query(actionId, target, params = {}) {
    const reply = await nativeValue("host_request", {
      request: {
        method: "action.query",
        params: {
          protocolVersion: attachment.protocolVersion,
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          actorId: attachment.actorId,
          requestId: randomUUID(),
          actionId,
          target,
          params,
          revealTarget: { pageId: "workbench" },
        },
      },
    });
    assert.equal(reply.ok, true, `${actionId}: ${reply.error?.code}`);
    return reply.result;
  }
  const scopes = await hostQuery("state.scopes", "host");
  assert.equal(scopes.kind, "scopes");
  const sessions = scopes.value.scopes.filter(
    (scope) => scope.target.kind === "session",
  );
  assert.equal(sessions.length, 1, "The restarted owned Host has one session");
  const target = sessions[0].target;
  const beforeSession = await query("session.get", target);
  assert.equal(beforeSession.kind, "session");
  assert.equal(beforeSession.value.deviceId, "virtual:echo");
  assert.equal(beforeSession.value.state, "open");
  const baseline = await nativeValue("get_diagnostics_report");
  assert.equal(typeof baseline.recentLogs, "string");
  const rawFailures = (logs) =>
    [...logs.matchAll(/"scope"\s*:\s*"Host raw reader"/g)].length;
  const beforeRawFailures = rawFailures(baseline.recentLogs);
  const probe = `__SWB_E2E_CLOSE_${randomUUID()}`;
  await browser.execute((key) => {
    const selector =
      ".workbench-notification, .workbench-stream-error[role=alert]";
    const baseline = new Map(
      [...document.querySelectorAll(selector)].map((node) => [
        node,
        node.textContent,
      ]),
    );
    const notices = new Set();
    const capture = () => {
      for (const node of document.querySelectorAll(selector)) {
        const text = node.textContent.trim();
        if (text && baseline.get(node) !== node.textContent)
          notices.add(text.slice(0, 300));
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    globalThis[key] = { observer, notices, capture };
  }, probe);
  const evidence = {
    beforeRawFailures,
    sessionId: beforeSession.value.sessionId,
    sessionEpoch: beforeSession.value.sessionEpoch,
    closedConfirmed: false,
    samples: 0,
    observedMs: 0,
    passed: false,
  };
  try {
    await clickEnabled("button[aria-label='Close session']");
    await $("button[aria-label='Open virtual:echo']").waitForEnabled();
    await browser.waitUntil(async () => {
      const result = await query("session.get", target);
      assert.equal(result.kind, "session");
      assert.equal(result.value.sessionId, beforeSession.value.sessionId);
      assert.equal(result.value.sessionEpoch, beforeSession.value.sessionEpoch);
      return result.value.state === "closed";
    });
    evidence.closedConfirmed = true;
    // Closed projection retires the product reader synchronously. Observe real
    // diagnostics for two seconds as well; this is not a lifecycle completion API.
    const started = Date.now();
    do {
      const report = await nativeValue("get_diagnostics_report");
      assert.equal(typeof report.recentLogs, "string");
      assert.ok(
        report.recentLogs.startsWith(baseline.recentLogs),
        "Diagnostic log rotated; the close-error comparison is inconclusive",
      );
      evidence.afterRawFailures = rawFailures(report.recentLogs);
      assert.equal(evidence.afterRawFailures, beforeRawFailures);
      const notices = await browser.execute((key) => {
        globalThis[key].capture();
        return [...globalThis[key].notices];
      }, probe);
      assert.deepEqual(notices, [], "Normal close raised a workbench notice");
      evidence.samples++;
      evidence.observedMs = Date.now() - started;
    } while (evidence.observedMs < 2000);
    evidence.passed = true;
  } finally {
    await browser.execute((key) => {
      globalThis[key]?.observer.disconnect();
      delete globalThis[key];
    }, probe);
    const directory = join("artifacts", "e2e", process.env.STARTER_E2E_PHASE);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "normal-close-reader-observation.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
}

function streamPayloadState(payload) {
  return browser.execute((text) => {
    const hex = [...new TextEncoder().encode(text)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const rows = [...document.querySelectorAll(".workbench-stream-row")].filter(
      (row) => {
        const content = row.querySelector(".workbench-stream-content");
        if (!content) return false;
        const payloads = [...content.querySelectorAll(".workbench-payload")];
        return payloads.some((value) =>
          content.dataset.mode === "hex"
            ? value.textContent.replace(/\s/g, "").toLowerCase().includes(hex)
            : value.textContent.includes(text),
        );
      },
    );
    const tx = rows.filter((row) => row.dataset.direction === "tx");
    return {
      rows: rows.length,
      txRows: tx.length,
      acceptedTxRows: tx.filter((row) =>
        row.querySelector(".workbench-tx-receipt [data-outcome='accepted']"),
      ).length,
    };
  }, payload);
}

export function workbenchChecks() {
  it("edits and clones saved views through the real workspace menu and preserves independent drafts", async () => {
    await openDeepLink("/");
    await openVirtual();
    const typography = await browser.execute(async () => {
      await document.fonts.ready;
      const draft = document.querySelector(".workbench-draft");
      if (!draft) throw new Error("Send surface is unavailable");
      const style = getComputedStyle(draft);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Canvas text measurement is unavailable");
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        family: style.fontFamily,
        size: style.fontSize,
        userAgent: navigator.userAgent,
        narrow: context.measureText("iiiiiiii").width,
        wide: context.measureText("WWWWWWWW").width,
      };
    });
    const typographyDirectory = join(
      "artifacts",
      "e2e",
      process.env.STARTER_E2E_PHASE,
    );
    mkdirSync(typographyDirectory, { recursive: true });
    writeFileSync(
      join(typographyDirectory, "terminal-font-metrics.json"),
      JSON.stringify(typography, null, 2),
    );
    assert.ok(typography.narrow > 0, JSON.stringify(typography));
    assert.ok(
      Math.abs(typography.narrow - typography.wide) < 0.05,
      JSON.stringify(typography),
    );
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
    await browser.waitUntil(() =>
      browser.execute(() => {
        const tables = document.querySelectorAll(
          "[role=dialog] table[aria-label='Configuration receipt']",
        );
        return [...tables].some((table) => {
          const rows = [...table.querySelectorAll("tbody tr")];
          const complete = [
            ...table.closest("article").children[0].querySelectorAll("span"),
          ].some((state) => state.textContent.trim() === "Completed");
          return (
            complete &&
            rows.length > 0 &&
            rows.every((row) => {
              const cells = [...row.children].map((cell) =>
                cell.textContent.trim(),
              );
              return cells[2] === "Applied" && cells[1] === cells[3];
            }) &&
            rows.some(
              (row) =>
                row.children[0]?.textContent.trim() === "Baud rate" &&
                row.children[3]?.textContent.trim() === "250000",
            )
          );
        });
      }),
    );
    assert.equal(await (await field("Baud rate")).getValue(), "250000");
    await browser.keys(Key.Escape);
    await $("[role=dialog]").waitForExist({ reverse: true });
    await $("button[aria-label='Connection parameters']").waitForExist();
    const draft = await sendDraft();
    await draft.setValue("M1B-NATIVE-TX");
    await clickEnabled("button[aria-label='Send']");
    await browser.waitUntil(async () => {
      const state = await streamPayloadState("M1B-NATIVE-TX");
      return state.txRows === 1 && state.acceptedTxRows === 1;
    });
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
    const retry = await $(
      "button[aria-label='Retry local service connection']",
    );
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
    assert.equal((await streamPayloadState("UNSENT AFTER RESTART")).rows, 0);
    await draft.setValue("M1B-NEW-HOST");
    await clickEnabled("button[aria-label='Send']");
    await browser.waitUntil(
      async () => (await streamPayloadState("M1B-NEW-HOST")).rows > 0,
    );
    await saveDrafts();
    await closeVirtualWithoutReaderFault();
  });
}
