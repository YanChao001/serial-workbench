import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { createTranslator } from "@/i18n/translate";
import { DiagnosticPanel, type DiagnosticLabels } from "./diagnostic-panel";
import { labels, session } from "./test-fixtures";
import { workbenchToolLabels } from "./tool-labels";
afterEach(cleanup);
const diagnosticLabels: DiagnosticLabels = {
  ...workbenchToolLabels(createTranslator(en)).diagnostics,
  ...labels,
  diagnostics: "Diagnostics",
  cannotOpen: "Cannot open",
  inspectEncoding: "Inspect encoding",
  inspectGaps: "Inspect missing data",
  inspectDisconnect: "Inspect disconnection",
  noRecordedGap: "No gap in the current buffer",
};
it("offers four evidence-based guides and reconnects only for an actual disconnected session", () => {
  const refresh = vi.fn(),
    hex = vi.fn(),
    reconnect = vi.fn(),
    metrics = vi.fn();
  const view = render(
    <DiagnosticPanel
      labels={diagnosticLabels}
      items={[]}
      session={session()}
      openError="PERMISSION_DENIED"
      onRefresh={refresh}
      onInspectBytes={hex}
      onInspectMetrics={metrics}
      onReconnect={reconnect}
    />,
  );
  expect(screen.getByText("PERMISSION_DENIED")).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual([
    "Cannot open",
    "Inspect encoding",
    "Inspect missing data",
    "Inspect disconnection",
  ]);
  expect(screen.getByText("No gap in the current buffer")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "HEX" }));
  expect(hex).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Host metrics" }));
  expect(metrics).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(refresh).toHaveBeenCalledOnce();
  view.rerender(
    <DiagnosticPanel
      labels={diagnosticLabels}
      items={[]}
      session={{ ...session(), state: "disconnected" }}
      streamError={new Error("EPOCH_MISMATCH")}
      onRefresh={refresh}
      onReconnect={reconnect}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(reconnect).toHaveBeenCalledOnce();
  expect(screen.getByText("EPOCH_MISMATCH")).toBeInTheDocument();
});

it.each([
  {
    language: "English",
    messages: en,
    refreshName: "Refresh",
    windows: [
      /Start menu/i,
      /Device Manager/i,
      /error code/i,
      /Windows Update/i,
    ],
    mac: [
      /System Information/i,
      /USB/,
      /\/dev\/cu\.\*/,
      /Apple Silicon/i,
      /unlock/i,
    ],
    linux: [/ls -l <device path>/, /id -nG/, /dialout/, /log in again/i],
    manual: /manual checks/i,
    recheck: /refresh.*retry/i,
  },
  {
    language: "简体中文",
    messages: zhCN,
    refreshName: "刷新",
    windows: [/开始菜单/, /设备管理器/, /错误码/, /Windows Update/],
    mac: [/系统信息/, /USB/, /\/dev\/cu\.\*/, /Apple Silicon/, /解锁/],
    linux: [/ls -l <设备路径>/, /id -nG/, /dialout/, /重新登录/],
    manual: /手动检查/,
    recheck: /刷新.*重试/,
  },
])(
  "offers offline manual platform guidance in $language with native keyboard semantics",
  async ({ messages, refreshName, windows, mac, linux, manual, recheck }) => {
    const user = userEvent.setup();
    let refreshes = 0;
    const { container } = render(
      <DiagnosticPanel
        labels={workbenchToolLabels(createTranslator(messages)).diagnostics}
        items={[]}
        openError="PERMISSION_DENIED"
        onRefresh={() => {
          refreshes += 1;
        }}
      />,
    );
    expect(screen.getByText(manual)).toBeInTheDocument();
    for (const { platform, instructions } of [
      { platform: "Windows", instructions: windows },
      { platform: "macOS", instructions: mac },
      { platform: "Linux", instructions: linux },
    ]) {
      const summary = screen.getByText(platform, { selector: "summary" });
      const disclosure = summary.parentElement;
      expect(disclosure?.tagName).toBe("DETAILS");
      expect(disclosure).not.toHaveAttribute("open");
      await user.tab();
      expect(summary).toHaveFocus();
      await user.click(summary);
      expect(disclosure).toHaveAttribute("open");
      const steps = summary.nextElementSibling;
      expect(steps?.tagName).toBe("OL");
      expect(steps?.children.length).toBeGreaterThanOrEqual(3);
      for (const instruction of instructions) {
        expect(disclosure?.textContent).toMatch(instruction);
      }
    }
    expect(screen.getByText(recheck)).toBeInTheDocument();
    expect(container.querySelector("a")).not.toBeInTheDocument();
    expect(refreshes).toBe(0);
    await user.tab();
    expect(screen.getByRole("button", { name: refreshName })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(refreshes).toBe(1);
  },
);
