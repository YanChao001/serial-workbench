import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const phase = process.env.STARTER_E2E_PHASE;
const referenceDirectory =
  phase === "terminal-automated"
    ? process.env.STARTER_E2E_TERMINAL_DIR
    : phase === "chart-automated"
      ? process.env.STARTER_E2E_CHART_DIR
      : null;

if (
  !process.env.STARTER_E2E_BINARY ||
  !process.env.STARTER_E2E_DATA_ROOT ||
  !/^\d+$/.test(process.env.STARTER_E2E_PORT ?? "") ||
  Number(process.env.STARTER_E2E_PORT) < 1 ||
  Number(process.env.STARTER_E2E_PORT) > 65535 ||
  ![
    "fresh",
    "persisted",
    "centered",
    "previews",
    "terminal-automated",
    "chart-automated",
  ].includes(phase) ||
  (referenceDirectory !== null && !isAbsolute(referenceDirectory ?? ""))
)
  throw new Error(
    "请通过 pnpm test:e2e --interactive 或 pnpm docs:capture --interactive 运行隔离窗口。",
  );
const outputDir = resolve(
  referenceDirectory ?? join("artifacts", "e2e"),
  phase,
);
mkdirSync(outputDir, { recursive: true });

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: Number(process.env.STARTER_E2E_PORT),
  path: "/",
  automationProtocol: "webdriver",
  specs: [`./e2e/specs/${phase}.spec.mjs`],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "wdio:enforceWebDriverClassic": true,
    },
  ],
  logLevel: "warn",
  outputDir,
  waitforTimeout: 15000,
  connectionRetryTimeout: 90000,
  // execute 超时前可能已经执行 Native 副作用，不能由驱动再次投递同一脚本。
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  // 同阶段复用设置与工作区；首个失败后停止，避免后续连锁超时掩盖根因。
  mochaOpts: { ui: "bdd", timeout: 90000, bail: true },
  async afterTest(test, _context, { passed }) {
    if (!passed) {
      const { browser } = await import("@wdio/globals");
      await browser.saveScreenshot(
        join(outputDir, `${test.title.replace(/[^a-z0-9]+/gi, "-")}.png`),
      );
    }
  },
};
