/// <reference lib="dom" />
import { randomUUID } from "node:crypto";

type ReloadBrowser = {
  execute(
    script: (marker: string) => void,
    marker: string,
  ): PromiseLike<unknown>;
  refresh(): PromiseLike<unknown>;
  $(selector: string): PromiseLike<{
    waitForExist(options: { reverse: boolean }): PromiseLike<unknown>;
  }>;
};

export async function reloadDocument(browser: ReloadBrowser): Promise<void> {
  const marker = randomUUID();
  // html 标记随文档替换消失，不受 React 重渲染影响，也不改业务状态。
  await browser.execute((value) => {
    document.documentElement.setAttribute("data-swb-reload-document", value);
  }, marker);
  await browser.refresh();
  const previousDocument = await browser.$(
    'html[data-swb-reload-document="' + marker + '"]',
  );
  await previousDocument.waitForExist({ reverse: true });
}
