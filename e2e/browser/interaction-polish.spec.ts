/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { en } from "../../src/i18n/en";

test("delivers rapid animated theme clicks without selecting title bar text", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  const button = page.getByRole("button", { name: "切换主题", exact: true });
  await button.waitFor();
  await button.evaluate((element) =>
    element.addEventListener("click", () =>
      element.setAttribute(
        "data-probe-clicks",
        String(Number(element.getAttribute("data-probe-clicks") ?? 0) + 1),
      ),
    ),
  );
  const box = await button.boundingBox();
  for (let i = 0; i < 12; i++) {
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(35);
  }
  await expect(button).toHaveAttribute("data-probe-clicks", "12");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
});

test("a default view follows the preset accent after a different custom color was saved", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    sharedSettings: { accent: "lime", customAccent: "#FF0000" },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save current layout", exact: true })
    .click();
  const marker = page.locator(".workbench-view-color").first();
  await expect(marker).toBeVisible();
  const colors = await marker.evaluate((element) => {
    const primary = document.createElement("span");
    primary.style.backgroundColor = "var(--primary)";
    element.append(primary);
    const result = {
      marker: getComputedStyle(element).backgroundColor,
      primary: getComputedStyle(primary).backgroundColor,
    };
    primary.remove();
    return result;
  });
  expect(colors.marker).toBe(colors.primary);
});

test("deleting a saved workspace returns to the default and never lists the archived original again", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en", theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: en["workbench.tools.workspace"], exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: en["workbench.tools.workspace"],
    exact: true,
  });
  await editor
    .getByRole("button", {
      name: en["workbench.tools.newWorkspace"],
      exact: true,
    })
    .click();
  const create = page.getByRole("dialog", {
    name: en["workbench.tools.newWorkspace"],
    exact: true,
  });
  await create
    .getByRole("textbox", {
      name: en["workbench.tools.workspaceName"],
      exact: true,
    })
    .fill("Temporary bench");
  await create
    .getByRole("button", {
      name: en["workbench.tools.createWorkspace"],
      exact: true,
    })
    .click();
  const choose = editor.getByRole("combobox", {
    name: en["workbench.tools.chooseWorkspace"],
    exact: true,
  });
  await expect(choose).toHaveText("Temporary bench");
  await editor
    .getByRole("button", {
      name: en["workbench.tools.removeWorkspace"],
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: en["workbench.tools.removeWorkspace"],
    exact: true,
  });
  await confirmation
    .getByRole("button", {
      name: en["workbench.tools.removeWorkspace"],
      exact: true,
    })
    .click();
  await expect(choose).toHaveText(en["workbench.tools.defaultWorkspace"]);
  await expect(
    editor.getByRole("button", {
      name: en["workbench.tools.removeWorkspace"],
      exact: true,
    }),
  ).toBeDisabled();
  await choose.click();
  await expect(
    page.getByRole("option", { name: "Temporary bench", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.workspaceWrites.some((value) => value.archived),
    ),
  ).toBe(true);
});

for (const pathological of [false, true]) {
  test(
    pathological
      ? "terminates pathological regex without blocking draft editing"
      : "previews advanced search without stealing input focus or moving the receive frame",
    async ({ page }, info) => {
      await page.setViewportSize({ width: 1400, height: 925 });
      await seedWorkbenchFixture(page, {
        language: "en",
        theme: "dark",
        sidebarCollapsed: true,
      });
      await page.goto("./#/");
      await page
        .getByRole("button", { name: "Open Virtual serial", exact: true })
        .click();
      const selectedPort = page.locator(
        '.workbench-device-select [data-slot="select-value"]',
      );
      await expect(selectedPort).toHaveText("Virtual serial");
      expect((await selectedPort.boundingBox())!.width).toBeGreaterThan(60);
      await expect
        .poll(() =>
          page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
        )
        .toBeGreaterThan(0);
      const item = workbenchStreamItems()[2]!;
      if (item.kind !== "source" || item.event.kind !== "rx")
        throw new Error("RX fixture unavailable");
      const text = pathological
        ? "a".repeat(20000) + "!"
        : "Cat cats 中cat cat中 CAT";
      item.event.payload = {
        bytesBase64: Buffer.from(text).toString("base64"),
        byteStart: "0",
        byteEnd: String(Buffer.byteLength(text)),
      };
      await page.evaluate(
        (item: unknown) => window.workbenchFixture.emitRaw([item]),
        item as unknown,
      );
      await expect(page.locator('[data-direction="rx"]')).toBeVisible();
      const frame = await page
        .locator(".workbench-receive-frame")
        .boundingBox();
      await page
        .getByRole("button", { name: en["workbench.search"], exact: true })
        .click();
      const search = page.getByRole("textbox", {
        name: en["workbench.search"],
        exact: true,
      });
      if (pathological)
        await page
          .getByRole("button", {
            name: en["workbench.searchRegex"],
            exact: true,
          })
          .click();
      await search.fill(pathological ? "(a+)+$" : "cat");
      const widget = page.locator(".workbench-stream-search");
      expect((await widget.boundingBox())!.height).toBeLessThan(60);
      await expect(widget.getByRole("status")).toContainText(
        pathological ? en["workbench.searchTimeout"] : "1/5",
      );
      if (!pathological) {
        await expect(search).toBeFocused();
        await page
          .getByRole("button", {
            name: en["workbench.searchWord"],
            exact: true,
          })
          .click();
        await expect(widget.getByRole("status")).toContainText("1/2");
        await widget
          .getByRole("radio", {
            name: `HEX ${en["workbench.search"]}`,
            exact: true,
          })
          .click();
        await search.fill("43 41 54");
        await expect(widget.getByRole("status")).toContainText("1/1");
        await widget
          .getByRole("radio", {
            name: `${en["workbench.text"]} ${en["workbench.search"]}`,
            exact: true,
          })
          .click();
        await search.fill("cat");
        await expect(widget.getByRole("status")).toContainText("1/2");
        expect(
          await page.locator(".workbench-receive-frame").boundingBox(),
        ).toEqual(frame);
        const box = await widget.boundingBox();
        expect(box!.width).toBeLessThan(650);
        await page.screenshot({ path: info.outputPath("compact-search.png") });
      } else {
        const draft = page.getByRole("textbox", {
          name: "Send draft",
          exact: true,
        });
        await draft.fill("still responsive");
        await expect(draft).toHaveValue("still responsive");
      }
    },
  );
}
