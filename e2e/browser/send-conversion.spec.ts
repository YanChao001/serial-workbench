/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";

for (const language of ["en", "zh"] as const) {
  test(`send conversion preserves BOM, NUL, UTF-8 and one configured ending (${language})`, async ({
    page,
  }, info) => {
    const chinese = language === "zh";
    const words = {
      send: chinese ? "发送" : "Send",
      text: chinese ? "文本" : "Text",
      count: chinese ? "发送字节数" : "Bytes to send",
      ending: chinese ? "行尾" : "Line ending",
      open: chinese ? "打开 Virtual serial" : "Open Virtual serial",
      close: chinese ? "关闭会话" : "Close session",
      failure: chinese
        ? "这些字节不是有效的 UTF-8，已保留 HEX 草稿。"
        : "Enter complete hexadecimal byte pairs",
    };
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setViewportSize(
      chinese ? { width: 880, height: 600 } : { width: 1120, height: 744 },
    );
    await seedWorkbenchFixture(page, {
      language,
      theme: chinese ? "dark" : "light",
      sidebarCollapsed: true,
      sharedSettings: {
        background: { kind: "preset", value: "plain" },
        terminal: {
          receiveMode: "text",
          sendMode: "text",
          lineEnding: { kind: "crlf" },
        },
      },
    });
    await page.goto("./#/");
    await page.getByRole("button", { name: words.open, exact: true }).click();
    await expect(
      page.getByRole("button", { name: words.close, exact: true }),
    ).toBeEnabled();
    const sender = page.getByRole("region", { name: words.send, exact: true });
    const input = sender.locator("textarea.workbench-draft");
    const hex = sender.getByRole("radio", { name: "HEX", exact: true });
    const text = sender.getByRole("radio", { name: words.text, exact: true });
    const count = sender.getByRole("note", { name: words.count, exact: true });
    const body = "\uFEFF串口\nA";
    const bodyHex = "EF BB BF E4 B8 B2 E5 8F A3 0A 41";
    const bodyWithNulHex = "EF BB BF 00 E4 B8 B2 E5 8F A3 0A 41";
    await input.fill(body);
    await expect(count).toHaveText("13 B");
    await hex.click();
    await expect(input).toHaveValue(bodyHex);
    await text.click();
    await expect(input).toHaveValue(body);
    await hex.click();
    await input.fill(bodyWithNulHex);
    await text.click();
    await expect(input).toHaveValue("\uFEFF\u0000串口\nA");
    await hex.click();
    await expect(input).toHaveValue(bodyWithNulHex);
    await expect(count).toHaveText("14 B");
    expect(
      await page.evaluate(() => window.workbenchFixture.sentBytes),
    ).toEqual([]);
    const geometry = await count.evaluate((label) => {
      const frame = label.closest(".workbench-draft-frame")!;
      const input = frame.querySelector("textarea")!;
      const outer = frame.getBoundingClientRect(),
        body = input.getBoundingClientRect(),
        note = label.getBoundingClientRect();
      return {
        tabIndex: (label as HTMLElement).tabIndex,
        interactive: !!label.closest("button,a,[role='button']"),
        frame: {
          y: outer.y,
          bottom: outer.bottom,
          right: outer.right,
          height: outer.height,
        },
        bodyBottom: body.bottom,
        note: { y: note.y, bottom: note.bottom, right: note.right },
        pointerEvents: getComputedStyle(label).pointerEvents,
      };
    });
    expect(geometry.tabIndex).toBe(-1);
    expect(geometry.interactive).toBe(false);
    expect(geometry.pointerEvents).toBe("none");
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.note.y + 0.5);
    expect(geometry.note.bottom).toBeLessThan(geometry.frame.bottom);
    expect(geometry.note.right).toBeLessThan(geometry.frame.right - 8);
    await count.click({ force: true });
    await expect(
      sender.locator(".workbench-byte-preview,.workbench-preview-trigger"),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("utf8-hex-draft.png") });
    const invalid = chinese ? "E2 82" : "0Z";
    await input.fill(invalid);
    await text.click();
    await expect(hex).toBeChecked();
    await expect(input).toHaveValue(invalid);
    const notice = page.getByRole("alert").filter({ hasText: words.failure });
    await expect(notice).toHaveCount(1);
    await expect(notice).toBeVisible();
    const clearance = async () => {
      const bottom = await notice.evaluate((element) => {
        const toast = element.closest("[data-sonner-toast]");
        if (!toast) throw new Error("Missing notification frame");
        return toast.getBoundingClientRect().bottom;
      });
      const composer = await sender.boundingBox();
      if (!composer) throw new Error("Missing composer frame");
      return bottom - composer.y;
    };
    await expect.poll(clearance).toBeLessThanOrEqual(-5.5);
    const frame = sender.locator(".workbench-draft-frame");
    const initial = await frame.boundingBox();
    if (!initial) throw new Error("Missing resizable draft");
    await page.mouse.move(
      initial.x + initial.width - 3,
      initial.y + initial.height - 3,
    );
    await page.mouse.down();
    await page.mouse.move(
      initial.x + initial.width - 3,
      initial.y + initial.height + 29,
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await frame.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initial.height + 12);
    await expect.poll(clearance).toBeLessThanOrEqual(-5.5);
    // 更改后恢复行尾会重新渲染发送区；持续的同一转换故障仍只有一条通知。
    await sender
      .getByRole("combobox", { name: words.ending, exact: true })
      .click();
    await page.getByRole("option", { name: "LF", exact: true }).click();
    await sender
      .getByRole("combobox", { name: words.ending, exact: true })
      .click();
    await page.getByRole("option", { name: "CRLF", exact: true }).click();
    await expect(notice).toHaveCount(1);
    await expect(input).toHaveValue(invalid);
    expect(
      await page.evaluate(() => window.workbenchFixture.sentBytes),
    ).toEqual([]);
    await page.screenshot({
      path: info.outputPath("invalid-draft-preserved.png"),
    });
    await input.fill(bodyWithNulHex);
    const send = sender.getByRole("button", { name: words.send, exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.length))
      .toBe(1);
    expect(
      await page.evaluate(() => window.workbenchFixture.sentBytes),
    ).toEqual([
      Buffer.from([
        0xef, 0xbb, 0xbf, 0, 0xe4, 0xb8, 0xb2, 0xe5, 0x8f, 0xa3, 0x0a, 0x41,
        0x0d, 0x0a,
      ]).toString("base64"),
    ]);
    await expect(input).toHaveValue(bodyWithNulHex);
    expect(runtimeErrors).toEqual([]);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
    await writeFile(
      info.outputPath("send-conversion-geometry.json"),
      JSON.stringify(geometry, null, 2),
    );
  });
}
