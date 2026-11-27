/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { ActionSpec } from "@serial-workbench/contracts";
import { seedWorkbenchFixture } from "./workbench.fixture";

for (const [width, language] of [
  [420, "zh"],
  [1240, "en"],
] as const) {
  test(`send preprocessing previews the exact final bytes at ${width}px`, async ({
    page,
  }, info) => {
    const zh = language === "zh";
    const text = {
      open: zh ? "打开 Virtual serial" : "Open Virtual serial",
      send: zh ? "发送" : "Send",
      ending: zh ? "行尾" : "Line ending",
      checksum: zh ? "发送校验" : "Send checksum",
      algorithm: zh ? "算法" : "Algorithm",
      title: zh ? "发送前预处理" : "Send preprocessing",
      enable: zh ? "启用预处理" : "Enable preprocessing",
      example: zh ? "载入 JSON 示例" : "Load JSON example",
      definition: zh ? "步骤定义" : "Step definition",
      preview: zh ? "生成预览" : "Generate preview",
      error: zh ? "请检查步骤定义" : "Check the step definition",
      final: zh ? "最终 HEX · 18 字节" : "Final HEX · 18 bytes",
    };
    await page.setViewportSize({ width, height: 640 });
    await seedWorkbenchFixture(page, { language, sidebarCollapsed: true });
    await page.goto("./#/");
    await page.getByRole("button", { name: text.open, exact: true }).click();

    const sender = page.getByRole("region", { name: text.send, exact: true });
    const draft = sender.locator("textarea.workbench-draft");
    const send = sender.getByRole("button", { name: text.send, exact: true });
    await draft.fill("A你");
    await sender.getByRole("combobox", { name: text.ending }).click();
    await page.getByRole("option", { name: "CRLF", exact: true }).click();
    await sender
      .getByRole("button", { name: text.checksum, exact: true })
      .click();
    const checksum = page.getByRole("dialog", {
      name: text.checksum,
      exact: true,
    });
    await checksum
      .getByRole("combobox", { name: text.algorithm, exact: true })
      .click();
    await page.getByRole("option", { name: "Sum-8", exact: true }).click();
    await page.keyboard.press("Escape");

    const trigger = sender.getByRole("button", {
      name: text.title,
      exact: true,
    });
    const dialog = page.getByRole("dialog", { name: text.title, exact: true });
    const definition = dialog.getByRole("textbox", {
      name: text.definition,
      exact: true,
    });
    const generate = dialog.getByRole("button", {
      name: text.preview,
      exact: true,
    });
    const sent = () => page.evaluate(() => window.workbenchFixture.sentBytes);
    await trigger.click();
    await expect(definition).toBeFocused();
    await dialog
      .getByRole("switch", { name: text.enable, exact: true })
      .click();
    await definition.fill('[{"kind":"json","field":"data","format":"bad"}]');
    await generate.click();
    await expect(dialog.getByRole("status")).toContainText(text.error);
    await expect(send).toBeDisabled();
    expect(await sent()).toEqual([]);

    await dialog
      .getByRole("button", { name: text.example, exact: true })
      .click();
    await generate.click();
    await expect(
      dialog.getByRole("region", { name: text.final }),
    ).toContainText("0D 0A D6");
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Missing preprocessing layout");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    const resultBounds = await dialog
      .getByRole("region", { name: text.final })
      .boundingBox();
    expect(resultBounds).not.toBeNull();
    if (!resultBounds) throw new Error("Missing final byte region");
    expect(resultBounds.y + resultBounds.height).toBeLessThanOrEqual(
      bounds.y + bounds.height,
    );
    await dialog.screenshot({ path: info.outputPath("send-preprocess.png") });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    await draft.fill("B你");
    await expect(send).toBeDisabled();
    expect(await sent()).toEqual([]);
    await trigger.click();
    await generate.click();
    await expect(
      dialog.getByRole("region", { name: text.final }),
    ).toContainText("0D 0A D7");
    await page.keyboard.press("Escape");
    await send.click();
    const bytes = Buffer.concat([
      Buffer.from('{"data":"B你"}\r\n'),
      Buffer.of(0xd7),
    ]);
    await expect.poll(sent).toEqual([bytes.toString("base64")]);
  });
}

test("send preprocessing uses the current session query and sends only its preview", async ({
  page,
}) => {
  const actionId = "test.preprocess.transform";
  const deniedId = "test.preprocess.writes";
  const revealTarget = { pageId: "workbench", panelId: "send" };
  const action: ActionSpec = {
    actionId,
    kind: "query",
    inputSchema: {},
    outputSchema: {},
    targetKinds: ["session"],
    executionLocation: "resource_host",
    permissions: ["content.read"],
    stateScopes: [],
    eventTypes: [],
    cancellation: "none",
    revealTarget,
  };
  await page.setViewportSize({ width: 1240, height: 720 });
  await seedWorkbenchFixture(page, {
    sidebarCollapsed: true,
    extraActions: [
      action,
      {
        ...action,
        actionId: deniedId,
        permissions: ["device.modify"],
      },
    ],
    extensionQueryResults: {
      [actionId]: { kind: "extension", value: { output: "QgA=" } },
    },
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  const sender = page.getByRole("region", { name: "Send", exact: true });
  const send = sender.getByRole("button", { name: "Send", exact: true });
  const hold = sender.getByRole("button", { name: "Hold to repeat sending" });
  const dialog = page.getByRole("dialog", { name: "Send preprocessing" });
  const definition = dialog.getByRole("textbox", { name: "Step definition" });
  const generate = dialog.getByRole("button", { name: "Generate preview" });
  const requests = () =>
    page.evaluate(
      ([allowed, denied]) => ({
        queries: window.workbenchFixture.queryInputs.filter(
          (query) => query.actionId === allowed || query.actionId === denied,
        ),
        sent: window.workbenchFixture.sentBytes,
      }),
      [actionId, deniedId],
    );
  const step = (id: string) =>
    JSON.stringify([
      {
        kind: "query",
        actionId: id,
        input: "payload",
        output: "output",
        params: { mode: "fixture" },
      },
    ]);

  await sender.locator("textarea.workbench-draft").fill("A");
  await sender.getByRole("button", { name: "Send preprocessing" }).click();
  await dialog.getByRole("switch", { name: "Enable preprocessing" }).click();
  await definition.fill(step(deniedId));
  await generate.click();
  await expect(dialog.getByRole("status")).toContainText("Step 1");
  await expect(send).toBeDisabled();
  await expect(hold).toBeDisabled();
  expect(await requests()).toEqual({ queries: [], sent: [] });

  await definition.fill(step(actionId));
  await generate.click();
  await expect(
    dialog.getByRole("region", { name: "Final HEX · 2 bytes" }),
  ).toHaveText(/42 00/);
  expect(await requests()).toEqual({
    queries: [
      expect.objectContaining({
        actionId,
        revealTarget,
        params: { mode: "fixture", payload: "QQ==" },
        target: expect.objectContaining({
          kind: "session",
          id: "session",
          sessionId: "session",
          sessionEpoch: "1",
        }),
      }),
    ],
    sent: [],
  });
  await page.keyboard.press("Escape");
  await send.click();
  await expect.poll(async () => (await requests()).sent).toEqual(["QgA="]);

  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await hold.focus();
  await page.keyboard.down("Space");
  await page.clock.runFor(350);
  await page.keyboard.up("Space");
  await expect
    .poll(async () => (await requests()).sent)
    .toEqual(["QgA=", "QgA="]);
  expect((await requests()).queries).toHaveLength(1);
});
