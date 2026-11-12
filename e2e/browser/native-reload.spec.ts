/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { reloadDocument } from "../reload-document.ts";

test("native reload readiness waits for the previous document to be replaced", async ({
  page,
}) => {
  let requested!: () => void;
  let release!: () => void;
  const reloadRequested = new Promise<void>((resolve) => (requested = resolve));
  const freshDocument = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route("**/native-reload-fixture", async (route) => {
    const generation = ++requests;
    await route.fulfill({
      contentType: "text/html",
      body: `<html><body data-generation="${generation}"><main>Ready</main></body></html>`,
    });
  });
  await page.goto("./native-reload-fixture");
  let navigation: Promise<unknown> | undefined;
  const observedDocuments: string[] = [];
  const driver = {
    execute: (script, marker) => page.evaluate(script, marker),
    async refresh() {
      // 模拟宿主先返回、再调度导航；浏览器仍真正替换整个文档。
      navigation = freshDocument.then(() => page.reload());
      requested();
    },
    async $(selector) {
      return {
        async waitForExist({ reverse }) {
          await page.locator(selector).waitFor({
            state: reverse ? "detached" : "attached",
          });
        },
      };
    },
  } satisfies Parameters<typeof reloadDocument>[0];
  let settled: Promise<void> | undefined;
  try {
    settled = reloadDocument(driver).then(async () => {
      observedDocuments.push(
        (await page.locator("body").getAttribute("data-generation")) ??
          "missing",
      );
    });
    await reloadRequested;
    await expect(page.locator("body")).toHaveAttribute("data-generation", "1");
    // 驱动已返回，但旧文档继续存在；有意保持该窗口，不能提前执行就绪后调用。
    await page.waitForTimeout(100);
    expect(observedDocuments).toEqual([]);
    release();
    await settled;
    expect(observedDocuments).toEqual(["2"]);
    expect(requests).toBe(2);
  } finally {
    release();
    await navigation?.catch(() => undefined);
    await settled?.catch(() => undefined);
  }
});
