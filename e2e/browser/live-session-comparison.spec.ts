import { expect, test, type Locator } from "@playwright/test";
import type { StreamItem } from "../../packages/contracts/src/index";
import { session } from "../../src/features/workbench/test-fixtures";
import { zhCN } from "../../src/i18n/zh-CN";
import { seedWorkbenchFixture } from "./workbench.fixture";

const hostId = "workbench-gui-host";
function records(sessionId: string, long: boolean): StreamItem[] {
  const source = { hostId, instanceEpoch: "1", sessionId, sessionEpoch: "1" };
  const size = long ? 4 : 2;
  return Array.from({ length: 76 }, (_, index) => {
    if (!long && index === 40)
      return {
        kind: "reader_gap",
        gap: {
          ...source,
          reason: "network_loss",
          missingEventRange: { start: "41", end: "42" },
          missingByteRanges: [{ direction: "rx", start: "80", end: "82" }],
        },
      };
    return {
      kind: "source",
      event: {
        ...source,
        kind: "rx",
        eventSeq: String(index + 1),
        configurationRevision: "1",
        time: {
          clockId: "fixture-comparison-clock",
          sourceMonoNs: String(index * 10_000_000 + (long ? 0 : 1_000_000)),
          receivedWallTime: "2026-11-10T11:22:33.456Z",
          precision: {
            source: "host_read",
            resolutionNs: "1000",
            syncMethod: "none",
          },
        },
        payload: {
          bytesBase64: long ? "UEVFUg==" : "T0s=",
          byteStart: String(size * index),
          byteEnd: String(size * (index + 1)),
        },
      },
    };
  });
}

async function scrollTo(log: Locator, row: number) {
  await log.evaluate(
    (element, position) => {
      element.scrollTop = position;
    },
    (row - 1) * 56,
  );
}

test("live comparison links two authorized scroll positions and keeps the other position when evidence is missing", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, {
    secondDevice: {
      deviceId: "peer-device",
      hostId,
      systemName: "Peer serial",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities: session().capabilities,
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Choose device", exact: true })
    .click();
  await page.getByRole("option", { name: "Peer serial", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Peer serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(2);

  expect(
    await page.evaluate(
      ([a, b]) => [
        window.workbenchFixture.emitRaw(a, "second-session"),
        window.workbenchFixture.emitRaw(b, "session"),
      ],
      [records("second-session", true), records("session", false)] as [
        unknown[],
        unknown[],
      ],
    ),
  ).toEqual([1, 1]);

  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Compare live sessions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Compare live sessions" });
  const left = dialog.getByRole("region", {
    name: "Session A receive records",
  });
  const right = dialog.getByRole("region", {
    name: "Session B receive records",
  });
  await expect(left.getByText("50 45 45 52").first()).toBeVisible();
  await expect(right.getByText("4F 4B").first()).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
  ).toBe(2);
  const boundsLeft = await left.boundingBox();
  const boundsRight = await right.boundingBox();
  expect(boundsRight!.x).toBeGreaterThan(boundsLeft!.x + boundsLeft!.width);
  expect(await left.locator("[data-source-event]").count()).toBeLessThan(30);

  async function choose(name: string) {
    await dialog.getByRole("combobox", { name: "Scroll alignment" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  }
  const positioned = () => right.locator("[data-aligned]");
  await choose("By event number");
  await left.press("PageDown");
  await expect(positioned()).toBeInViewport();
  await scrollTo(left, 21);
  await expect(positioned()).toHaveAttribute("data-source-event", "21");

  await choose("By RX byte offset");
  await scrollTo(left, 26);
  await expect(positioned()).toHaveAttribute("data-source-event", "51");
  await expect(positioned()).toBeInViewport();

  await choose("By time");
  await scrollTo(left, 33);
  await expect(positioned()).toHaveAttribute("data-source-event", "33");
  await expect(dialog.locator(".workbench-live-compare-status")).toContainText(
    "1000000 ns",
  );
  await expect(
    dialog.locator(".workbench-live-compare-status"),
  ).toBeInViewport();
  await dialog.screenshot({
    path: info.outputPath("live-session-comparison-wide.png"),
  });

  await scrollTo(right, 35);
  await expect(left.locator("[data-aligned]")).toHaveAttribute(
    "data-source-event",
    "35",
  );
  await expect(dialog.locator(".workbench-live-compare-status")).toContainText(
    "-1000000 ns",
  );
  const rightPosition = await right.evaluate((el) => el.scrollTop);
  await choose("By event number");
  await scrollTo(left, 41);
  await expect(
    dialog.getByText("No matching record in the other session.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(await right.evaluate((el) => el.scrollTop)).toBe(rightPosition);

  const link = dialog.getByRole("button", { name: "Link scrolling" });
  await link.click();
  await expect(link).toHaveAttribute("aria-pressed", "false");
  await scrollTo(left, 1);
  await left.locator('[data-source-event="1"] button').click();
  await expect(dialog.getByText("RX bytes [0, 4)")).toBeVisible();
  await expect(dialog.locator("pre")).toHaveText("50 45 45 52");
  expect(await right.evaluate((el) => el.scrollTop)).toBe(rightPosition);

  await page.setViewportSize({ width: 420, height: 460 });
  const narrowLeft = await left.boundingBox();
  const narrowRight = await right.boundingBox();
  expect(narrowRight!.y).toBeGreaterThan(narrowLeft!.y + narrowLeft!.height);
  await dialog.screenshot({
    path: info.outputPath("live-session-comparison-narrow.png"),
  });

  await right.locator('[data-source-event="35"] button').click();
  await expect(dialog.locator("pre")).toHaveText("4F 4B");
  const ended = await page.evaluate(() => {
    window.workbenchFixture.deniedRawSessions.push("session");
    return window.workbenchFixture.endRaw(
      {
        code: "PERMISSION_DENIED",
        message: "Content access revoked",
        retryable: false,
      },
      "session",
    );
  });
  expect(ended).toBe(1);
  await expect(
    right.getByText(
      "Receive records for this session are currently unavailable.",
    ),
  ).toBeVisible();
  await expect(right.getByText("4F 4B").first()).toHaveCount(0);
  await expect(dialog.locator("pre")).toHaveCount(0);
  await expect(left.locator('[data-source-event="1"]')).toBeVisible();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});

test("Chinese narrow workbench explains how to choose two live sessions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 460 });
  await seedWorkbenchFixture(page, { language: "zh", theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: zhCN["workbench.tools.more"], exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", {
      name: zhCN["workbench.tools.liveComparison"],
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: zhCN["workbench.tools.liveComparison"],
  });
  await expect(
    dialog.getByText(zhCN["liveCompare.needSessions"], { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", {
      name: zhCN["liveCompare.left"],
      exact: true,
    }),
  ).toBeDisabled();
  await dialog.screenshot({
    path: info.outputPath("live-session-comparison-empty-zh.png"),
  });
});
