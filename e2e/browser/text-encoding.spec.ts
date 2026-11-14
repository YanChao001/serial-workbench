/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import iconv from "iconv-lite";

async function choose(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
function receive(bytes: Uint8Array): unknown[] {
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  return [bytes.slice(0, 1), bytes.slice(1)].map((part, index) => ({
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      eventSeq: String(index + 11),
      payload: {
        bytesBase64: Buffer.from(part).toString("base64"),
        byteStart: String(index),
        byteEnd: String(index + part.length),
      },
    },
  }));
}
for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 880, height: 600 },
] as const)
  test(`encoding controls send exact GBK, reinterpret RX, search and save choices (${sample.language})`, async ({
    page,
  }, info) => {
    const words = sample.language === "zh" ? zhCN : en;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, { ...sample, sidebarCollapsed: true });
    await page.goto("./#/");
    const sender = page.getByRole("region", {
      name: words["workbench.send"],
      exact: true,
    });
    const input = sender.getByRole("textbox", {
      name: words["workbench.draft"],
      exact: true,
    });
    await choose(page, words["workbench.sendEncoding"], "GBK");
    await input.fill("你好");
    await expect(
      sender.getByRole("note", { name: words["workbench.draftByteCount"] }),
    ).toHaveText("4 B");
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect(
      sender.getByRole("combobox", { name: words["workbench.sendEncoding"] }),
    ).toHaveText("GBK");
    await sender.getByRole("radio", { name: "HEX", exact: true }).click();
    await expect(input).toHaveValue("C4 E3 BA C3");
    await sender
      .getByRole("radio", { name: words["workbench.text"], exact: true })
      .click();
    await expect(input).toHaveValue("你好");
    await sender
      .getByRole("button", { name: words["workbench.send"], exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.at(-1)))
      .toBe("xOO6ww==");
    await choose(page, words["workbench.receiveEncoding"], "GBK");
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBeGreaterThan(0);
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      receive(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])),
    );
    await expect(
      page.locator('[data-direction="rx"] .workbench-stream-content'),
    ).toHaveText("你好");
    await page
      .getByRole("button", { name: words["workbench.search"], exact: true })
      .click();
    await page
      .getByRole("textbox", { name: words["workbench.search"], exact: true })
      .fill("你好");
    await expect(
      page.locator(".workbench-stream-search").getByRole("status"),
    ).toContainText("1/1");
    await page
      .getByRole("textbox", { name: words["workbench.search"], exact: true })
      .press("Escape");
    await choose(page, words["workbench.receiveEncoding"], "UTF-8");
    await expect(
      page.locator('[data-direction="rx"] .workbench-stream-content'),
    ).not.toHaveText("你好");
    await choose(page, words["workbench.receiveEncoding"], "GBK");
    await page
      .getByRole("button", {
        name: words["workbench.tools.saveCurrentLayout"],
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.workspaceWrites.at(-1)?.views[0]
              ?.sendEncoding,
        ),
      )
      .toBe("gbk");
    expect(
      await page.evaluate(
        () =>
          window.workbenchFixture.workspaceWrites.at(-1)?.views[0]
            ?.receiveEncoding,
      ),
    ).toBe("gbk");
    const codecBox = await sender
      .getByRole("combobox", { name: words["workbench.sendEncoding"] })
      .boundingBox();
    const hexBox = await sender
      .getByRole("radio", { name: "HEX", exact: true })
      .boundingBox();
    expect(codecBox!.x - hexBox!.x - hexBox!.width).toBeLessThan(16);
    expect(Math.abs(codecBox!.y - hexBox!.y)).toBeLessThan(2);
    await page.screenshot({
      path: info.outputPath("text-encoding-controls.png"),
    });
    await input.fill("你好😀");
    await expect(
      sender.getByRole("button", {
        name: words["workbench.send"],
        exact: true,
      }),
    ).toBeDisabled();
    await expect(input).toHaveValue("你好😀");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: words["workbench.unrepresentableEncoding"] }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

test("auto receive detection handles split GBK data and UTF-16 sends include an encoded line ending", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en", sidebarCollapsed: true });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await choose(
    page,
    en["workbench.receiveEncoding"],
    en["workbench.encodingAuto"],
  );
  await expect(
    page.getByRole("combobox", { name: en["workbench.receiveEncoding"] }),
  ).toHaveText(en["workbench.encodingPending"]);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const text =
    "这是串口工作台的中文编码识别测试，我们正在发送接收数据并检查设备连接状态。".repeat(
      5,
    );
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    receive(iconv.encode(text, "gbk")),
  );
  await expect(
    page.getByRole("combobox", { name: en["workbench.receiveEncoding"] }),
  ).toHaveText("Auto · GB18030");
  await expect(
    page.locator('[data-direction="rx"] .workbench-stream-content'),
  ).toHaveText(text);
  await page
    .getByRole("button", {
      name: en["workbench.tools.saveCurrentLayout"],
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.workspaceWrites.at(-1)?.views[0]
            ?.receiveEncoding === null,
      ),
    )
    .toBe(true);
  await choose(page, en["workbench.sendEncoding"], "UTF-16 LE");
  await choose(page, en["workbench.lineEnding"], "CRLF");
  const sender = page.getByRole("region", { name: "Send", exact: true });
  await sender
    .getByRole("textbox", { name: en["workbench.draft"], exact: true })
    .fill("A");
  await expect(
    sender.getByRole("note", { name: en["workbench.draftByteCount"] }),
  ).toHaveText("6 B");
  await sender.getByRole("radio", { name: "HEX", exact: true }).click();
  await expect(
    sender.getByRole("textbox", { name: en["workbench.draft"], exact: true }),
  ).toHaveValue("41 00");
  await expect(
    sender.getByRole("note", { name: en["workbench.draftByteCount"] }),
  ).toHaveText("6 B");
  await sender.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.at(-1)))
    .toBe(Buffer.from([65, 0, 13, 0, 10, 0]).toString("base64"));
});
