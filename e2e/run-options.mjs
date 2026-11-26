export const waylandLaunchScenarios = [
  "approve",
  "cancel",
  "deny",
  "reload",
  "replace",
  "unavailable",
];

/** 原生窗口测试会主动激活窗口，必须在启动构建或进程前明确选择前台运行。 */
export function parseE2EOptions(args) {
  const modes = {
    "terminal-manual": ["terminal-manual"],
    "terminal-automated": ["terminal-automated"],
    "chart-automated": ["chart-automated"],
    "browser-takeover": ["browser-takeover"],
    "wayland-global-send": ["wayland-global-send"],
    lan: ["lan-owner", "lan-caller"],
  };
  const specialized = Object.keys(modes).filter((mode) =>
    args.includes(`--${mode}`),
  );
  if (
    specialized.length > 1 ||
    args.some(
      (arg) =>
        ![
          "--interactive",
          "--skip-build",
          "--with-node-runtime",
          ...Object.keys(modes).map((mode) => `--${mode}`),
        ].includes(arg),
    )
  )
    throw new Error(
      "Usage: pnpm test:e2e --interactive [--skip-build] [--with-node-runtime] [--terminal-manual | --terminal-automated | --chart-automated | --browser-takeover | --wayland-global-send | --lan].",
    );
  if (!args.includes("--interactive"))
    throw new Error(
      "真实桌面 E2E 会显示、激活和切换窗口，可能打断当前输入；默认不启动。\n" +
        "日常界面检查请运行 pnpm test:ui。需要前台验收时，显式运行 pnpm test:e2e --interactive。",
    );
  return {
    skipBuild: args.includes("--skip-build"),
    withNodeRuntime:
      specialized.some((mode) => /^(terminal|chart)-/.test(mode)) ||
      args.includes("--with-node-runtime"),
    phases: modes[specialized[0]] ?? ["fresh", "persisted", "centered"],
  };
}
