import { expect, test } from "@playwright/test";
import {
  pairingCode,
  pairingMode,
  takeoverNotice,
} from "../browser-takeover-locators";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("desktop settings lets a person pair and revoke browser access", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await seedWorkbenchFixture(page, { language: "en", theme: "dark" });
  await page.goto("./#/settings?focus=browserAccess");
  const configure = page.getByRole("button", {
    name: "Configure browser access",
  });
  await configure.click();
  const dialog = page.getByRole("dialog", { name: "Browser access" });
  const mode = page.locator("xpath=" + pairingMode);
  await expect(mode).toHaveText("View only");
  await mode.click();
  await page.getByRole("option", { name: "View and operate" }).click();
  const pair = dialog.getByRole("button", { name: "Generate pairing code" });
  const code = page.locator("xpath=" + pairingCode);
  const copy = dialog.getByRole("button", { name: "Copy", exact: true });
  const revoke = dialog.getByRole("button", {
    name: "Turn off browser access",
  });
  await expect(dialog.getByText("Browser access is off.")).toBeVisible();
  await pair.press("Enter");
  await expect(code).toHaveValue("a".repeat(43));
  await expect(code).toBeFocused();
  await expect(
    dialog.getByText("Current access: View and operate"),
  ).toBeVisible();
  const wideCode = await code.boundingBox();
  const wideCopy = await copy.boundingBox();
  if (!wideCode || !wideCopy) throw new Error("Missing wide pairing controls");
  expect(wideCopy.x).toBeGreaterThan(wideCode.x + wideCode.width);
  expect(Math.abs(wideCopy.y - wideCode.y)).toBeLessThan(2);
  expect(Math.abs(wideCopy.height - wideCode.height)).toBeLessThan(2);
  await expect(
    dialog.getByRole("link", { name: "Open in browser" }),
  ).toHaveAttribute("href", "http://127.0.0.1:9240");
  await expect(dialog.getByText("browser-hidden-fixture")).toHaveCount(0);
  await page.setViewportSize({ width: 420, height: 360 });
  const narrowCode = await code.boundingBox();
  const narrowCopy = await copy.boundingBox();
  if (!narrowCode || !narrowCopy)
    throw new Error("Missing narrow pairing controls");
  expect(narrowCopy.y).toBeGreaterThan(narrowCode.y + narrowCode.height);
  await expect(revoke).toBeInViewport();
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect(
    dialog.getByText("Pairing code", { exact: true }),
  ).toBeInViewport({
    ratio: 1,
  });
  await expect(
    dialog.getByText("Current access: View and operate"),
  ).toBeInViewport();
  expect(
    await page.evaluate(() => window.workbenchFixture.copiedLanInfo),
  ).toEqual(["a".repeat(43)]);
  await expect(revoke).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("desktop-browser-pairing.png"),
  });

  await page.keyboard.press("Escape");
  await expect(configure).toBeFocused();
  await configure.click();
  await expect(mode).toHaveText("View and operate");
  await expect(
    dialog.getByRole("textbox", { name: "Pairing code" }),
  ).toHaveCount(0);
  await mode.click();
  await page.getByRole("option", { name: "View only" }).click();
  await expect(mode).toHaveText("View only");
  await expect(
    dialog.getByText("Current access: View and operate"),
  ).toBeVisible();
  await revoke.press("Enter");
  await expect(dialog.getByText("Browser access is off.")).toBeVisible();
  await expect(mode).toBeFocused();
  await expect(pair).toBeEnabled();
});

test("late pairing and clipboard receipts cannot populate a new visit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 540 });
  await seedWorkbenchFixture(page, { language: "zh", theme: "light" });
  await page.goto("./#/settings?focus=browserAccess");
  const configure = page.getByRole("button", { name: "配置浏览器访问" });
  await expect(configure).toBeEnabled();
  await page.evaluate(() => {
    const native = (
      window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (!native) throw new Error("Missing desktop fixture");
    const invoke = native.invoke.bind(native);
    let firstPair = true;
    let firstCopy = true;
    native.invoke = async (command, args) => {
      const intent = args?.intent as { kind?: string } | undefined;
      let signal;
      if (
        command === "host_browser_access" &&
        intent?.kind === "pair" &&
        firstPair
      ) {
        firstPair = false;
        signal = "release-browser-pair";
      } else if (
        command === "plugin:clipboard-manager|write_text" &&
        firstCopy
      ) {
        firstCopy = false;
        signal = "release-browser-copy";
      }
      const gate = signal
        ? new Promise<void>((resolve) => {
            addEventListener(signal, () => resolve(), { once: true });
          })
        : undefined;
      const result = await invoke(command, args);
      await gate;
      return result;
    };
  });
  const dialog = page.getByRole("dialog", { name: "浏览器访问", exact: true });
  const code = dialog.getByRole("textbox", { name: "配对码", exact: true });
  await configure.click();
  await dialog.getByRole("button", { name: "生成配对码" }).click();
  await expect(
    dialog.getByRole("button", { name: "正在生成…" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(configure).toBeFocused();
  await configure.click();
  await page.evaluate(() => dispatchEvent(new Event("release-browser-pair")));
  await expect(dialog.getByText("当前访问权限：仅查看")).toBeVisible();
  await expect(code).toHaveCount(0);
  const pairAgain = dialog.getByRole("button", {
    name: "重新配对",
    exact: true,
  });
  await pairAgain.click();
  await expect(code).toHaveValue("a".repeat(43));
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.copiedLanInfo.length),
    )
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect(configure).toBeFocused();
  await configure.click();
  await pairAgain.click();
  await expect(code).toHaveValue("a".repeat(43));
  await page.evaluate(async () => {
    dispatchEvent(new Event("release-browser-copy"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const copy = dialog.getByRole("button", { name: "复制", exact: true });
  await expect(copy).toHaveText("复制");
  await copy.click();
  await expect(copy).toHaveText("已复制");
});

test("desktop shows the exact port and MCP client before approving a browser takeover", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 500 });
  const clientId = "bench-assistant-with-a-long-identifier-" + "x".repeat(64);
  await seedWorkbenchFixture(page, {
    currentPage: "settings",
    pendingTakeover: {
      takeoverId: "fixture-browser-takeover",
      clientId,
      deviceId: "device",
      target: {
        hostId: "workbench-gui-host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      },
    },
  });
  await page.goto("./#/settings");
  const notice = page.locator(
    "xpath=" + takeoverNotice("Virtual serial", clientId),
  );
  await expect(notice).toBeVisible();
  await expect(
    notice.getByText("Virtual serial", { exact: true }),
  ).toBeVisible();
  await expect(notice.getByText(clientId, { exact: true })).toBeVisible();
  await expect(
    notice.getByText(
      "Confirming stops the listed client from writing to this port.",
    ),
  ).toBeVisible();
  expect(
    await notice.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(notice.getByRole("button", { name: "Decline" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-takeover-approval.png"),
  });
  await page.evaluate(() => {
    const native = (
      window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (!native) throw new Error("Missing desktop fixture");
    const invoke = native.invoke.bind(native);
    let first = true;
    native.invoke = async (command, args) => {
      if (first && command === "host_decide_browser_takeover") {
        first = false;
        await new Promise<void>((resolve) => {
          addEventListener("finish-takeover-attempt", () => resolve(), {
            once: true,
          });
        });
        throw { code: "OPERATION_FAILED" };
      }
      return invoke(command, args);
    };
  });
  const approve = notice.getByRole("button", { name: "Confirm takeover" });
  const decline = notice.getByRole("button", { name: "Decline" });
  await approve.press("Enter");
  await expect(notice.getByRole("status")).toHaveText(
    "Waiting for the desktop decision to finish…",
  );
  await expect(approve).toBeDisabled();
  await expect(decline).toBeDisabled();
  await page.evaluate(() =>
    dispatchEvent(new Event("finish-takeover-attempt")),
  );
  await expect(notice.getByRole("alert")).toBeVisible();
  await expect(approve).toBeFocused();
  expect(
    await page.evaluate(() => window.workbenchFixture.browserTakeoverDecisions),
  ).toEqual([]);
  await approve.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.browserTakeoverDecisions),
    )
    .toEqual([{ takeoverId: "fixture-browser-takeover", approve: true }]);
});

test("a takeover with an unavailable port only offers decline", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    pendingTakeover: {
      takeoverId: "fixture-missing-device",
      clientId: "bench-assistant",
      deviceId: "disconnected-device",
      target: {
        hostId: "workbench-gui-host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      },
    },
  });
  await page.goto("./#/settings");
  const notice = page.getByRole("group", {
    name: "Browser requests write access",
  });
  await expect(
    notice.getByText("The requested port is unavailable."),
  ).toBeVisible();
  await expect(
    notice.getByRole("button", { name: "Confirm takeover" }),
  ).toBeDisabled();
  await notice.getByRole("button", { name: "Decline" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.browserTakeoverDecisions),
    )
    .toEqual([{ takeoverId: "fixture-missing-device", approve: false }]);
});
