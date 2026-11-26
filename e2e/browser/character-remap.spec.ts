import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

async function choose(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

test("receive and send previews use their own rules and leave Raw and the send draft intact", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, { language: "en", sidebarCollapsed: true });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const items = workbenchStreamItems().filter(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  await page.evaluate(
    (events) => window.workbenchFixture.emitRaw(events),
    items as unknown[],
  );
  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await receive.getByRole("radio", { name: "HEX", exact: true }).click();
  const hex = receive
    .getByRole("log")
    .locator("[data-direction=rx] [data-hex-source]");
  await expect(hex).toHaveText("4F 4B 0D 0A");
  const sendDraft = page.getByRole("textbox", { name: "Send draft" });
  await sendDraft.fill("ab\nline");

  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Character remapping", exact: true })
    .click({ timeout: 2_000 });
  const dialog = page.getByRole("dialog", {
    name: "Character remapping",
    exact: true,
  });
  const before = dialog.getByRole("textbox", {
    name: "Before mapping",
    exact: true,
  });
  const after = dialog.getByRole("textbox", {
    name: "After mapping",
    exact: true,
  });
  await expect(before).toHaveValue("OK\\r\\n");
  await expect(
    dialog.getByRole("combobox", { name: "Newlines", exact: true }),
  ).toBeFocused();
  await choose(page, "Newlines", "LF");
  await choose(page, "Letter case", "Lowercase");
  await expect(after).toHaveValue("ok\\n");

  await dialog.getByRole("radio", { name: "Send preview" }).click();
  await expect(before).toHaveValue("ab\\nline");
  await expect(after).toHaveValue("ab\\nline");
  await choose(page, "Newlines", "CRLF");
  await choose(page, "Letter case", "Uppercase");
  await dialog.getByRole("button", { name: "Add replacement" }).click();
  await dialog.getByRole("textbox", { name: "Source character" }).fill("a");
  await dialog.getByRole("textbox", { name: "Replacement text" }).fill("z");
  await expect(after).toHaveValue("ZB\\r\\nLINE");
  expect((await before.boundingBox())?.y).toBe((await after.boundingBox())?.y);
  expect((await before.boundingBox())?.width).toBe(
    (await after.boundingBox())?.width,
  );
  await dialog.screenshot({
    path: info.outputPath("character-remap-wide.png"),
  });

  await dialog.getByRole("radio", { name: "Receive preview" }).click();
  await expect(after).toHaveValue("ok\\n");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  await expect(sendDraft).toHaveValue("ab\nline");
  await expect(hex).toHaveText("4F 4B 0D 0A");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("the narrow Chinese preview uses the most recent message and reports duplicate rows", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 410, height: 460 });
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "打开 Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const item = workbenchStreamItems().find(
    (entry) => entry.kind === "source" && entry.event.kind === "rx",
  );
  if (!item || item.kind !== "source" || item.event.kind !== "rx")
    throw new Error("Missing receive fixture");
  const event = item.event;
  const textSample = Buffer.from("\nA\b5=\u007f\u0085", "utf8");
  const events: unknown[] = [
    {
      kind: "source",
      event: {
        ...event,
        eventSeq: "1",
        payload: {
          bytesBase64: "WA0=",
          byteStart: "0",
          byteEnd: "2",
          message: {
            messageId: "first",
            fragmentOffset: "0",
            messageLength: "2",
            messageType: "text",
          },
        },
      },
    },
    {
      kind: "source",
      event: {
        ...event,
        eventSeq: "2",
        payload: {
          bytesBase64: textSample.toString("base64"),
          byteStart: "2",
          byteEnd: String(2 + textSample.length),
          message: {
            messageId: "second",
            fragmentOffset: "0",
            messageLength: String(textSample.length),
            messageType: "text",
          },
        },
      },
    },
    {
      kind: "source",
      event: {
        ...event,
        eventSeq: "3",
        payload: {
          bytesBase64: "YQhi",
          byteStart: String(2 + textSample.length),
          byteEnd: String(5 + textSample.length),
          message: {
            messageId: "binary",
            fragmentOffset: "0",
            messageLength: "3",
            messageType: "binary",
          },
        },
      },
    },
  ];
  await page.evaluate(
    (batch) => window.workbenchFixture.emitRaw(batch),
    events,
  );
  const menu = page.getByRole("button", { name: "工作区菜单", exact: true });
  await menu.press("ArrowDown");
  await page.getByRole("menuitem", { name: "字符重映射", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "字符重映射", exact: true });
  const before = dialog.getByRole("textbox", { name: "映射前", exact: true });
  const after = dialog.getByRole("textbox", { name: "映射后", exact: true });
  await expect(before).toHaveValue("\\nA\\b5=\\u007f\\u0085");
  await choose(page, "退格", "删除前一个字符");
  await expect(after).toHaveValue("\\n5=\\u007f\\u0085");
  const add = dialog.getByRole("button", { name: "添加替换", exact: true });
  await add.click();
  await dialog
    .getByRole("textbox", { name: "源字符", exact: true })
    .first()
    .fill("5");
  await dialog
    .getByRole("textbox", { name: "替换文本", exact: true })
    .first()
    .fill("完成");
  await add.click();
  const duplicate = dialog
    .getByRole("textbox", { name: "源字符", exact: true })
    .last();
  await duplicate.fill("5");
  await expect(duplicate).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("该源字符已有替换规则。")).toBeVisible();
  await expect(after).toHaveValue("");
  await add.click();
  const sources = dialog.getByRole("textbox", { name: "源字符", exact: true });
  await sources.last().fill("ab");
  await expect(sources.nth(1)).toHaveAttribute("aria-invalid", "true");
  await expect(sources.last()).toHaveAttribute("aria-invalid", "true");
  const remove = dialog.getByRole("button", { name: "移除", exact: true });
  await remove.last().press("Enter");
  await expect(sources.last()).toBeFocused();
  await remove.last().press("Enter");
  await expect(sources.first()).toBeFocused();
  await expect(after).toHaveValue("\\n完成=\\u007f\\u0085");
  const left = await before.boundingBox();
  const right = await after.boundingBox();
  expect(left?.x).toBe(right?.x);
  expect(right?.y).toBeGreaterThan(left?.y ?? 0);
  expect(await dialog.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
    410,
  );
  await after.scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: info.outputPath("character-remap-narrow.png"),
  });
});

test("applied receive rules follow live RX, honour freeze, and locate untouched HEX", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, { language: "en", sidebarCollapsed: true });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);

  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (!source || source.kind !== "source" || source.event.kind !== "rx")
    throw new Error("Missing RX fixture");
  const rxEvent = source.event;
  async function emit(sequence: number, byteStart: number, text: string) {
    const bytes = Buffer.from(text);
    const item: unknown = {
      kind: "source",
      event: {
        ...rxEvent,
        eventSeq: String(sequence),
        payload: {
          bytesBase64: bytes.toString("base64"),
          byteStart: String(byteStart),
          byteEnd: String(byteStart + bytes.length),
        },
      },
    };
    await page.evaluate(
      (event) => window.workbenchFixture.emitRaw([event]),
      item,
    );
  }
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Character remapping", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Character remapping",
    exact: true,
  });
  await choose(page, "Newlines", "LF");
  await choose(page, "Backspace", "Erase previous character");
  await choose(page, "Letter case", "Lowercase");
  await dialog
    .getByRole("button", { name: "Apply to receive", exact: true })
    .click({ timeout: 2_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();

  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const mapped = terminal.getByRole("radio", { name: "Mapped", exact: true });
  await expect(mapped).toBeChecked();
  await expect(
    terminal.getByText("Waiting for received text to map."),
  ).toBeVisible();
  await emit(1, 0, "A\r");
  const payload = terminal.locator("[data-rx-mapped-text]");
  await expect(payload).toHaveText("a");

  await terminal.getByRole("button", { name: "Freeze", exact: true }).click();
  await emit(2, 2, "\nBc\bD");
  await expect(
    terminal.getByText("Pending updates: 1", { exact: true }),
  ).toBeVisible();
  await expect(payload).toHaveText("a");
  await terminal.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => payload.textContent()).toBe("a\nbd");
  const row = terminal.getByRole("group", {
    name: "RX bytes [0, 7), events 1–2",
  });
  await expect(row).toBeVisible();
  await terminal.screenshot({
    path: info.outputPath("mapped-receive-wide.png"),
  });
  await page.setViewportSize({ width: 410, height: 460 });
  await expect(
    row.getByRole("button", { name: "Original bytes", exact: true }),
  ).toBeInViewport();
  await expect(
    terminal.getByRole("button", { name: "Display options", exact: true }),
  ).toBeInViewport();
  await terminal.screenshot({
    path: info.outputPath("mapped-receive-narrow.png"),
  });
  await row
    .getByRole("button", { name: "Original bytes", exact: true })
    .click();
  const hexMode = terminal.getByRole("radio", { name: "HEX", exact: true });
  await expect(hexMode).toBeChecked();
  const rawLog = terminal.getByRole("log");
  await expect(rawLog).toBeFocused();
  await expect(rawLog.locator('[data-location-target="true"]')).toContainText(
    "41 0D",
  );
  expect(
    (
      await rawLog
        .locator("[data-direction=rx] [data-hex-source]")
        .allTextContents()
    ).join(" "),
  ).toBe("41 0D 0A 42 63 08 44");
  await mapped.click();
  await expect(payload).toBeVisible();
  const previous = await page.evaluate(
    () => window.workbenchFixture.rawSubscriptions[0],
  );
  expect(previous).toBeDefined();
  const ended = await page.evaluate(() => {
    const fixture = window.workbenchFixture;
    fixture.rawCursorGate = new Promise((resolve) => {
      fixture.releaseRawCursor = resolve;
    });
    return fixture.endRaw(
      {
        code: "PERMISSION_DENIED",
        message: "Content access revoked",
        retryable: false,
      },
      "session",
    );
  });
  expect(ended).toBe(1);
  await expect(mapped).toHaveCount(0);
  await expect(payload).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(0);
  await page.evaluate(() => window.workbenchFixture.releaseRawCursor?.());
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => window.workbenchFixture.rawSubscriptions[0]),
  ).not.toBe(previous);
  await expect(mapped).toHaveCount(0);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("an active mapped tail opens the original HEX page at its start offset", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en", sidebarCollapsed: true });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (!source || source.kind !== "source" || source.event.kind !== "rx")
    throw new Error("Missing RX fixture");
  const rxEvent = source.event;
  const fragments: unknown[] = Array.from({ length: 8 }, (_, index) => {
    const size = 16_384;
    const offset = index * size;
    return {
      kind: "source",
      event: {
        ...rxEvent,
        eventSeq: String(index + 1),
        payload: {
          bytesBase64: Buffer.alloc(size, index < 4 ? 65 : 66).toString(
            "base64",
          ),
          byteStart: String(offset),
          byteEnd: String(offset + size),
          message: {
            messageId: "test-long-text",
            fragmentOffset: String(offset),
            messageLength: "131072",
            messageType: "text",
          },
        },
      },
    };
  });
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    fragments,
  );
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Character remapping", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Character remapping",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Apply to receive", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const row = terminal.getByRole("group", {
    name: "RX bytes [65536, 131072), events 5–8",
  });
  await row
    .getByRole("button", { name: "Original bytes", exact: true })
    .click();
  const log = terminal.getByRole("log");
  await expect(
    log.getByText("Byte offset [65536, 131072) · 2/2"),
  ).toBeVisible();
  await expect(log.locator("[data-hex-source]")).toContainText("42 42 42");
});

test("applied send mapping uses the preview bytes and keeps the original draft", async ({
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
  const draft = page.getByRole("textbox", { name: "Send draft" });
  await draft.fill("ab\nline");
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Character remapping", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Character remapping" });
  await dialog.getByRole("radio", { name: "Send preview" }).click();
  await choose(page, "Newlines", "CRLF");
  await choose(page, "Letter case", "Uppercase");
  await dialog.getByRole("button", { name: "Add replacement" }).click();
  await dialog.getByRole("textbox", { name: "Source character" }).fill("a");
  await dialog.getByRole("textbox", { name: "Replacement text" }).fill("z");
  await dialog.getByRole("button", { name: "Apply to send" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Send mapping active");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  const send = page.getByRole("region", { name: "Send", exact: true });
  await expect(send.getByText("Send mapping active")).toBeVisible();
  await expect(draft).toHaveValue("ab\nline");
  await expect(send.locator(".workbench-draft-bytes")).toHaveText("8 B");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await send.screenshot({ path: info.outputPath("mapped-send-narrow.png") });
  await send.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([Buffer.from("ZB\r\nLINE").toString("base64")]);
  const call = await page.evaluate(() =>
    window.workbenchFixture.invocations.find(
      (item) => item.actionId === "session.tx",
    ),
  );
  expect(call?.params).toMatchObject({
    bytesBase64: "WkINCkxJTkU=",
    sourceText: {
      utf8Base64: "YWIKbGluZQ==",
      encoding: "utf-8",
      mapping: {
        newline: "crlf",
        backspace: "keep",
        letterCase: "upper",
        replacements: [{ source: "a", replacement: "z" }],
      },
    },
    transforms: [
      {
        id: "terminal.character-remap",
        version: "1",
        configurationDigest: /^[a-f0-9]{64}$/,
      },
    ],
  });
  await expect(draft).toHaveValue("ab\nline");
  await page.evaluate(() => {
    window.workbenchFixture.manualSendAcceptedBytes = 1;
  });
  await send.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual(["WkINCkxJTkU=", "WkINCkxJTkU="]);

  const notification = page
    .getByRole("alert")
    .filter({ hasText: "Partially accepted" });
  await expect(notification).toBeVisible();
  for (const width of [420, 1240]) {
    await page.setViewportSize({ width, height: 610 });
    const trigger = send.getByRole("button", { name: "Receipt", exact: true });
    await trigger.click();
    const result = page.getByRole("status", { name: "Receipt", exact: true });
    await expect(result).toBeInViewport();
    await expect(result).toContainText("Partially accepted");
    await expect(result).toContainText("Requested bytes: [8, 16)");
    await expect(result).toContainText("Bytes accepted by backend: [8, 9)");
    await expect(result).toContainText(
      "Bytes not accepted by backend: [9, 16)",
    );
    await expect(notification).toHaveCount(0);
    const popover = page.locator(".workbench-send-receipt");
    await expect(
      popover.getByText("PARTIAL_WRITE", { exact: true }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        popover.evaluate((layer) => layer.scrollHeight <= layer.clientHeight),
      )
      .toBe(true);
    await popover.screenshot({
      path: info.outputPath(`mapped-partial-receipt-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(result).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await expect(draft).toHaveValue("ab\nline");
  expect(
    await page.evaluate(() => window.workbenchFixture.sentBytes.length),
  ).toBe(2);
  await send.getByRole("radio", { name: "HEX", exact: true }).click();
  await expect(send.getByText("Send mapping active")).toHaveCount(0);
  await expect(send.locator(".workbench-draft-bytes")).toHaveText("7 B");
  await send.getByRole("radio", { name: "Text", exact: true }).click();
  await expect(send.getByText("Send mapping active")).toBeVisible();
  await send.getByRole("button", { name: "Clear send mapping" }).click();
  await expect(draft).toBeFocused();
  await expect(send.getByText("Send mapping active")).toHaveCount(0);
  await expect(send.locator(".workbench-draft-bytes")).toHaveText("7 B");
});
