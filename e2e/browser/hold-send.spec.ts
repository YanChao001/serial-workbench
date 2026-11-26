import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("holding sends only in the active workbench and preserves the draft layout", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 610 });
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    manualSendReceipts: true,
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  const send = page.getByRole("region", { name: "Send", exact: true });
  const draft = send.getByRole("textbox", { name: "Send draft" });
  const hold = send.getByRole("button", { name: "Hold to repeat sending" });
  const single = send.getByRole("button", { name: "Send", exact: true });
  await draft.fill("at");
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Character remapping", exact: true })
    .click();
  const mapping = page.getByRole("dialog", {
    name: "Character remapping",
    exact: true,
  });
  await mapping
    .getByRole("radio", { name: "Send preview", exact: true })
    .click();
  await mapping
    .getByRole("combobox", { name: "Letter case", exact: true })
    .click();
  await page.getByRole("option", { name: "Uppercase", exact: true }).click();
  await mapping
    .getByRole("button", { name: "Apply to send", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(mapping).toBeHidden();
  const written = () =>
    page.evaluate(() => window.workbenchFixture.sentBytes.length);

  for (const width of [420, 1240]) {
    await page.setViewportSize({ width, height: 610 });
    const [editor, normalButton, holdButton] = await Promise.all([
      send.locator(".workbench-draft-frame").boundingBox(),
      single.boundingBox(),
      hold.boundingBox(),
    ]);
    if (!editor || !normalButton || !holdButton)
      throw new Error("Missing composer bounds");
    expect(normalButton.y).toBe(editor.y);
    expect(holdButton.y).toBe(editor.y);
    expect(normalButton.height).toBe(editor.height);
    expect(holdButton.height).toBe(editor.height);
    expect(holdButton.x + holdButton.width).toBeLessThan(normalButton.x);
    expect(normalButton.x + normalButton.width).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 420, height: 610 });
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await hold.click();
  await page.clock.runFor(400);
  expect(await written()).toBe(0);
  const button = await hold.boundingBox();
  if (!button) throw new Error("Missing narrow hold button");
  await page.mouse.move(
    button.x + button.width / 2,
    button.y + button.height / 2,
  );
  await page.mouse.down();
  await page.clock.runFor(350);
  await expect.poll(written).toBe(1);
  await page.clock.runFor(180);
  await expect.poll(written).toBe(2);
  await expect(hold).toHaveAttribute("aria-busy", "true");
  await send.screenshot({ path: info.outputPath("hold-send-narrow.png") });
  await page.mouse.move(button.x - 90, button.y - 15);
  await page.mouse.up();
  await page.clock.runFor(500);
  expect(await written()).toBe(2);

  await hold.focus();
  await page.keyboard.down("Space");
  await page.clock.runFor(350);
  await expect.poll(written).toBe(3);
  await draft.focus();
  await page.clock.runFor(500);
  expect(await written()).toBe(3);
  await page.keyboard.up("Space");

  await page.evaluate(() => {
    window.workbenchFixture.manualSendAcceptedBytes = 1;
  });
  await hold.focus();
  await page.keyboard.down("Enter");
  await page.clock.runFor(350);
  await expect.poll(written).toBe(4);
  await expect(hold).not.toHaveAttribute("aria-busy");
  await page.clock.runFor(500);
  expect(await written()).toBe(4);
  await page.keyboard.up("Enter");
  await expect(draft).toHaveValue("at");
  const inputs = await page.evaluate(() =>
    window.workbenchFixture.invocations
      .filter(({ actionId }) => actionId === "session.tx")
      .map(({ params }) => params.sourceText),
  );
  expect(inputs).toHaveLength(4);
  for (const input of inputs)
    expect(input).toMatchObject({
      utf8Base64: "YXQ=",
      mapping: { letterCase: "upper" },
    });
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    Array(4).fill("QVQ="),
  );
});
