import { setTimeout as delay } from "node:timers/promises";

/** 新窗口导航可能丢失一次求值；仅在原观察预算内重新读取当前文档。 */
export async function waitForNativeDocument(client, label) {
  const { script } = await client.getTimeouts();
  const timeout = client.options.waitforTimeout;
  const deadline = performance.now() + timeout;
  let cause;
  try {
    while (performance.now() < deadline) {
      await client.setTimeout({
        script: Math.max(
          1,
          Math.min(1000, Math.floor(deadline - performance.now())),
        ),
      });
      try {
        const ready = await client.execute((expectedLabel) => {
          const internals = globalThis.__TAURI_INTERNALS__;
          return Boolean(
            document.querySelector("#root main") &&
            typeof internals?.invoke === "function" &&
            internals.metadata?.currentWindow?.label === expectedLabel,
          );
        }, label);
        if (ready && performance.now() <= deadline) return;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "script timeout")
          throw error;
        cause = error;
      }
      await delay(
        Math.min(
          client.options.waitforInterval,
          Math.max(0, deadline - performance.now()),
        ),
      );
    }
    throw new Error(
      `Native document ${label} did not initialize within ${timeout}ms`,
      { cause },
    );
  } finally {
    // 后续可能修改原生状态的脚本仍使用原超时，并且保持一次投递。
    await client.setTimeout({ script });
  }
}
