import { STORAGE_KEY } from "@/lib/settings-model";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/providers/i18n";
import { DEFAULT_SETTINGS, SettingsProvider } from "@/providers/settings";
import Settings from "./settings";
import { defaults } from "@serial-workbench/contracts";
import {
  DEFAULT_CLIENT_STATE,
  browserClientStateStore,
} from "@/lib/client-settings";
import type { SettingsBackend } from "@/lib/settings-sync";
import type {
  ClientStateSnapshot,
  ClientPreferences,
} from "@/lib/generated/bindings";
import { settingsDocument } from "@/lib/settings-model";
import * as desktop from "@/lib/tauri";
import { toast } from "sonner";
import userEvent from "@testing-library/user-event";
import { searchSettings } from "@/commands/settings-search";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import {
  UnsavedWorkProvider,
  UnsavedWorkScope,
  useRequestLeave,
} from "@/providers/unsaved-work";

const host = vi.hoisted(() => ({
  read: vi.fn<SettingsBackend["read"]>(),
  save: vi.fn<SettingsBackend["save"]>(),
  subscribe: vi.fn<SettingsBackend["subscribe"]>(),
  revision: "1",
}));
vi.mock("@/lib/host-settings", () => ({
  createHostSettingsBackend: () => ({
    ...host,
    markExplicitEdit() {},
    dispose() {},
  }),
}));
vi.mock("@/providers/host-context", async () => {
  const { createContext } = await import("react");
  return {
    HostContext: createContext({
      connection: { attachment: { hostId: "host", instanceEpoch: "1" } },
      state: { status: "ready", error: null },
    }),
  };
});
const clientSnapshot = (
  preferences: Partial<ClientPreferences> = {},
): ClientStateSnapshot => ({
  formatVersion: "0.1",
  revision: "1",
  state: {
    ...DEFAULT_CLIENT_STATE,
    preferences: { ...DEFAULT_CLIENT_STATE.preferences, ...preferences },
  },
});

function LeaveSettings({ onLeave }: { onLeave: (allowed: boolean) => void }) {
  const requestLeave = useRequestLeave();
  return (
    <button onClick={() => void requestLeave("settings-test").then(onLeave)}>
      Leave settings
    </button>
  );
}

function SettingsView({
  initial = "/settings",
  onLeave,
}: {
  initial?: string;
  onLeave?: (allowed: boolean) => void;
}) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <SettingsProvider>
        <I18nProvider>
          {onLeave ? (
            <UnsavedWorkProvider>
              <UnsavedWorkScope scope="settings-test">
                <Settings />
                <LeaveSettings onLeave={onLeave} />
              </UnsavedWorkScope>
            </UnsavedWorkProvider>
          ) : (
            <Settings />
          )}
        </I18nProvider>
      </SettingsProvider>
    </MemoryRouter>
  );
}

vi.mock("@/pages/diagnostics", () => ({
  DiagnosticsContent: () => <div data-testid="settings-diagnostics" />,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("@/lib/tauri", () => ({
  isTauri: vi.fn(() => false),
  getAppInfo: vi.fn(),
  openExternal: vi.fn(),
  getWindowGeometry: vi.fn(),
  setWindowSize: vi.fn(),
  resetWindowGeometry: vi.fn(),
  onWindowResized: vi.fn(),
  onWindowMoved: vi.fn(),
  readClientState: vi.fn(),
  saveClientState: vi.fn(),
  applyHostSettingsEffects: vi.fn(),
  getDesktopStatus: vi.fn(),
  getAutostartEnabled: vi.fn(),
  setAutostartEnabled: vi.fn(),
  openSecondaryWindow: vi.fn(),
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  getUpdateSnapshot: vi.fn(),
  onUpdateProgress: vi.fn(),
  relaunchApp: vi.fn(),
  onLifecycleRequest: vi.fn(async () => () => {}),
  onLifecycleFinished: vi.fn(async () => () => {}),
  onLifecycleExecuting: vi.fn(async () => () => {}),
  setWindowWorkState: vi.fn(async () => {}),
  respondLifecycle: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

const geometry: desktop.WindowGeometry = {
  width: 1120,
  height: 740,
  minWidth: 880,
  minHeight: 600,
  maxWidth: 1920,
  maxHeight: 1040,
  defaultWidth: 1120,
  defaultHeight: 740,
};

function confirmReset() {
  fireEvent.click(screen.getByRole("button", { name: "重置偏好" }));
  return within(screen.getByRole("dialog"));
}

describe("设置页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktop.isTauri).mockReturnValue(false);
    vi.mocked(desktop.getAppInfo).mockResolvedValue({
      version: "0.1.0",
      tauriVersion: "2.0.0",
    });
    vi.mocked(desktop.getDesktopStatus).mockResolvedValue({
      autostartSupported: true,
      trayAvailable: true,
      secondaryOpen: false,
      runInBackground: false,
    });
    vi.mocked(desktop.getAutostartEnabled).mockResolvedValue(false);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue(geometry);
    vi.mocked(desktop.setWindowSize).mockImplementation(
      async (width, height) => ({ ...geometry, width, height }),
    );
    vi.mocked(desktop.resetWindowGeometry).mockResolvedValue(geometry);
    vi.mocked(desktop.onWindowResized).mockResolvedValue(vi.fn());
    vi.mocked(desktop.onWindowMoved).mockResolvedValue(vi.fn());
    host.revision = "1";
    host.read.mockResolvedValue({ revision: "1", value: defaults.settings });
    host.subscribe.mockResolvedValue(() => {});
    host.save.mockImplementation(async (value, revision) => {
      host.revision = String(BigInt(revision) + 1n);
      return { revision: host.revision, value };
    });
    vi.mocked(desktop.readClientState).mockResolvedValue(clientSnapshot());
    vi.mocked(desktop.saveClientState).mockImplementation(
      async (state, revision) => ({
        formatVersion: "0.1",
        revision: String(BigInt(revision) + 1n),
        state,
      }),
    );
    vi.mocked(desktop.applyHostSettingsEffects).mockImplementation(
      async () => ({
        hostId: "host",
        instanceEpoch: "1",
        revision: host.revision,
        effects: {
          trayLanguage: true,
          networkMode: true,
          runInBackground: true,
        },
      }),
    );
    sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(settingsDocument(DEFAULT_SETTINGS)),
    );
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });
  it("终端排版使用生成默认，四字段经键盘保存并保留其他终端设置", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    host.read.mockResolvedValue({
      revision: "1",
      value: {
        ...defaults.settings,
        terminal: {
          receiveMode: "hex",
          sendMode: "hex",
          lineEnding: { kind: "crlf" },
        },
      },
    });
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    const family = screen.getByRole("textbox", { name: "终端字体" });
    const size = screen.getByRole("spinbutton", { name: "终端字号（px）" });
    const height = screen.getByRole("spinbutton", { name: "终端行高（%）" });
    const ligatures = screen.getByRole("switch", { name: "终端连字" });
    expect(family).toHaveValue("ui-monospace");
    expect(size).toHaveValue(14);
    expect(height).toHaveValue(150);
    expect(ligatures).not.toBeChecked();
    expect(family).toHaveAccessibleDescription(/本机.*等宽/);
    const user = userEvent.setup();
    await user.click(family);
    await user.clear(family);
    await user.type(family, "Cascadia Code, monospace");
    expect(host.save).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(1));
    await user.click(size);
    await user.clear(size);
    await user.type(size, "18");
    await user.tab();
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(2));
    expect(height).toHaveFocus();
    await user.clear(height);
    await user.type(height, "180");
    await user.tab();
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(3));
    expect(ligatures).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(4));
    expect(host.save.mock.calls.at(-1)?.[0].terminal).toEqual({
      receiveMode: "hex",
      sendMode: "hex",
      lineEnding: { kind: "crlf" },
      typography: {
        fontFamily: "Cascadia Code, monospace",
        fontSize: 18,
        lineHeightPercent: 180,
        ligatures: true,
      },
    });
    expect(screen.getByRole("combobox", { name: "字体" })).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "字号" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["终端字号（px）", "8", 8],
    ["终端字号（px）", "48", 48],
    ["终端行高（%）", "100", 100],
    ["终端行高（%）", "300", 300],
  ])("终端排版接受边界 %s %s", async (label, value, expected) => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    const input = screen.getByRole("spinbutton", { name: label });
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    await waitFor(() => expect(host.save).toHaveBeenCalledOnce());
    expect(
      host.save.mock.calls[0]?.[0].terminal.typography?.[
        label === "终端字号（px）" ? "fontSize" : "lineHeightPercent"
      ],
    ).toBe(expected);
  });

  it.each([
    ["终端字体", ""],
    ["终端字体", "   "],
    ["终端字体", "a\u007fb"],
    ["终端字体", "😀".repeat(129)],
    ["终端字号（px）", ""],
    ["终端字号（px）", "0"],
    ["终端字号（px）", "7"],
    ["终端字号（px）", "49"],
    ["终端字号（px）", "14.5"],
    ["终端行高（%）", "99"],
    ["终端行高（%）", ""],
    ["终端行高（%）", "0"],
    ["终端行高（%）", "301"],
    ["终端行高（%）", "150.5"],
  ])("非法终端排版 %s %s 保留草稿且零保存，可复原", async (label, value) => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    const input = screen.getByLabelText(label, { exact: true });
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "应用终端排版" })).toBeDisabled();
    expect(host.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复原终端排版" }));
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(host.save).not.toHaveBeenCalled();
  });

  it("外部更新刷新未编辑字段，保留本地草稿并合并最新终端设置", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    let changed!: Parameters<SettingsBackend["subscribe"]>[0];
    host.subscribe.mockImplementation(async (listener) => {
      changed = listener;
      return () => {};
    });
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    const family = screen.getByRole("textbox", { name: "终端字体" });
    fireEvent.change(family, { target: { value: "Draft Mono" } });
    act(() =>
      changed({
        revision: "2",
        value: {
          ...defaults.settings,
          terminal: {
            receiveMode: "hex",
            sendMode: "text",
            lineEnding: { kind: "lf" },
            typography: {
              fontFamily: "External Mono",
              fontSize: 24,
              lineHeightPercent: 200,
              ligatures: true,
            },
          },
        },
      }),
    );
    expect(family).toHaveValue("Draft Mono");
    expect(
      screen.getByRole("spinbutton", { name: "终端字号（px）" }),
    ).toHaveValue(24);
    expect(
      screen.getByRole("spinbutton", { name: "终端行高（%）" }),
    ).toHaveValue(200);
    expect(screen.getByRole("switch", { name: "终端连字" })).toBeChecked();
    expect(host.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用终端排版" }));
    await waitFor(() => expect(host.save).toHaveBeenCalledOnce());
    expect(host.save.mock.calls[0]).toEqual([
      expect.objectContaining({
        terminal: {
          receiveMode: "hex",
          sendMode: "text",
          lineEnding: { kind: "lf" },
          typography: {
            fontFamily: "Draft Mono",
            fontSize: 24,
            lineHeightPercent: 200,
            ligatures: true,
          },
        },
      }),
      "2",
    ]);
  });

  it("终端排版搜索中英可达且深链聚焦区域", () => {
    for (const [dict, query] of [
      [zhCN, "终端行高"],
      [en, "terminal ligatures"],
    ] as const)
      expect(
        searchSettings(query, createTranslator(dict)).map((entry) => entry.id),
      ).toContain("terminalTypography");
    render(<SettingsView initial="/settings?focus=terminalTypography" />);
    expect(screen.getByRole("group", { name: "终端排版" })).toHaveFocus();
  });

  it("终端排版草稿经实际离页协商阻止非法保存，取消保留且明确放弃才复原", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    const onLeave = vi.fn();
    render(<SettingsView onLeave={onLeave} />);
    await screen.findByText("当前尺寸 1120 × 740");
    const input = screen.getByRole("spinbutton", { name: "终端字号（px）" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("终端排版")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toBeVisible());
    expect(host.save).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue(null);
    expect(onLeave).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "放弃并继续",
      }),
    );
    await waitFor(() => expect(onLeave).toHaveBeenLastCalledWith(true));
    expect(input).toHaveValue(14);
    expect(host.save).not.toHaveBeenCalled();
  });

  it("终端排版未失焦的合法草稿可经实际离页协商提交", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    const onLeave = vi.fn();
    render(<SettingsView onLeave={onLeave} />);
    await screen.findByText("当前尺寸 1120 × 740");
    fireEvent.change(screen.getByRole("textbox", { name: "终端字体" }), {
      target: { value: "😀".repeat(128) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "保存并继续",
      }),
    );
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith(true));
    await waitFor(() => expect(host.save).toHaveBeenCalledOnce());
    expect(host.save.mock.calls[0]?.[0].terminal.typography?.fontFamily).toBe(
      "😀".repeat(128),
    );
  });
  it("诊断恢复使用可聚焦的设置分组，并保留浏览器提示", () => {
    render(<SettingsView initial="/settings?section=recovery" />);
    const recovery = screen.getByRole("group", { name: "诊断与恢复" });
    expect(recovery).toHaveAttribute("id", "settings-recovery");
    expect(recovery).toHaveFocus();
    expect(
      within(recovery).getByText(
        "请在 Serial Workbench 桌面应用中使用此功能。",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Tauri|Tailwind|shadcn/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("应用模式")).not.toBeInTheDocument();
  });
  it("网络位于设置末段并提供连接深链，浏览器禁用修改且按需说明连接由浏览器控制", async () => {
    render(<SettingsView initial="/settings?focus=networkMode" />);
    expect(screen.getByText("网络", { exact: true })).toBeVisible();
    expect(
      screen
        .getAllByText(/^(应用更新|网络|关于与资源)$/)
        .map((element) => element.textContent),
    ).toEqual(["应用更新", "网络", "关于与资源"]);
    expect(document.getElementById("settings-networkMode")).toHaveFocus();
    const connection = screen.getByRole("combobox", { name: "网络连接" });
    expect(connection).toBeDisabled();
    expect(connection).toHaveTextContent("系统代理");
    expect(screen.queryByText(/连接方式由浏览器控制/)).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "了解网络连接" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "浏览器自行管理连接方式，仅桌面版可修改此项。",
    );
    expect(host.save).not.toHaveBeenCalled();
  });

  it("桌面网络连接通过宿主设置保存，可在直连和系统代理间切换", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    const connection = screen.getByRole("combobox", { name: "网络连接" });
    expect(connection).toBeEnabled();
    fireEvent.keyDown(connection, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "直接连接" }));
    await waitFor(() =>
      expect(host.save.mock.calls.at(-1)?.[0]).toMatchObject({
        networkMode: "direct",
      }),
    );
    expect(connection).toHaveTextContent("直接连接");
    fireEvent.keyDown(connection, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "系统代理" }));
    await waitFor(() =>
      expect(host.save.mock.calls.at(-1)?.[0]).toMatchObject({
        networkMode: "system",
      }),
    );
    expect(connection).toHaveTextContent("系统代理");
  });

  it("应用更新直接可见并支持深链定位，浏览器不会调用原生更新", () => {
    render(<SettingsView initial="/settings?section=updates" />);
    expect(screen.getByRole("region", { name: "应用更新" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "启动时检查更新" }),
    ).toBeDisabled();
    expect(screen.getByText(/检查、安装与自动检查仅限桌面版/)).toBeVisible();
    expect(desktop.checkForUpdate).not.toHaveBeenCalled();
    expect(desktop.downloadAndInstallUpdate).not.toHaveBeenCalled();
    expect(desktop.getUpdateSnapshot).not.toHaveBeenCalled();
    expect(desktop.onUpdateProgress).not.toHaveBeenCalled();
  });
  it("把桌面选项放在窗口设置中，浏览器明确限制且别名定位可聚焦", () => {
    render(<SettingsView initial="/settings?section=desktop" />);
    expect(screen.getByRole("region", { name: "窗口与运行" })).toHaveFocus();
    expect(screen.getByText(/窗口大小与系统集成仅桌面版可改/)).toBeVisible();
    expect(screen.getByRole("switch", { name: "登录时启动" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "关闭后后台运行" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "新窗口" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "窗口大小" })).toBeVisible();
  });

  it("提供语言切换入口并将新语言写入文档和存档", () => {
    render(<SettingsView />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "语言" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "English" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("English");
    expect(document.documentElement.lang).toBe("en");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject(
      { value: { language: "en" } },
    );
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("内置图片选择持久化稳定身份且保留独立用户图库", () => {
    render(<SettingsView />);
    const wallpaper = screen.getByRole("radio", {
      name: "使用壁纸：秋日花饰少女",
    });
    expect(wallpaper).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "纯色" }));
    expect(wallpaper).not.toBeChecked();
    fireEvent.click(wallpaper);
    expect(wallpaper).toBeChecked();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      value: { background: { kind: "bundled", id: "bundled:001" } },
    });
    expect(
      screen.queryByRole("button", { name: "删除壁纸：秋日花饰少女" }),
    ).not.toBeInTheDocument();
  });

  it("重置外观时保留用户语言并恢复其余默认偏好", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        settingsDocument({
          ...DEFAULT_SETTINGS,
          language: "en",
          accent: "rose",
          font: "mono",
          motion: "reduced",
          menuBar: false,
          background: { kind: "preset", value: "sakura" },
          backgroundIntensity: 80,
        }),
      ),
    );
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Reset preferences" }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject(
      { value: { accent: "rose", font: "mono" } },
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject(
      { value: { accent: "rose", font: "mono" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset preferences" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Reset preferences",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual(
      settingsDocument({ ...DEFAULT_SETTINGS, language: "en" }),
    );
  });

  it("皮肤与强度即时生效、持久化，并在纯色皮肤下禁用强度", () => {
    const view = () => <SettingsView />;
    const { unmount } = render(view());
    fireEvent.click(screen.getByRole("radio", { name: "纯色" }));
    expect(screen.getByRole("slider", { name: "背景透明度" })).toHaveAttribute(
      "data-disabled",
    );
    fireEvent.click(screen.getByRole("radio", { name: "云朵晴空" }));
    const slider = screen.getByRole("slider", { name: "背景透明度" });
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "60");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(document.documentElement).toHaveAttribute(
      "data-background",
      "sakura",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-background-intensity",
      "0",
    );
    unmount();
    render(view());
    expect(screen.getByRole("radio", { name: "云朵晴空" })).toBeChecked();
    expect(screen.getByRole("slider", { name: "背景透明度" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "背景透明度" }), {
      key: "End",
    });
    expect(screen.getByRole("slider", { name: "背景透明度" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    fireEvent.click(screen.getByRole("radio", { name: "纯色" }));
    expect(screen.getByRole("slider", { name: "背景透明度" })).toHaveAttribute(
      "data-disabled",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-background",
      "plain",
    );
  });

  it("皮肤说明保留无障碍关联，键盘聚焦后才显示补充文案", async () => {
    render(<SettingsView />);
    const skin = screen.getByRole("radio", { name: "云朵晴空" });
    expect(skin).toHaveAccessibleDescription("云朵与小太阳线稿");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(skin);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "云朵与小太阳线稿",
    );
  });

  it("首次读取窗口范围失败保留紧凑恢复入口，重试后恢复预设", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry)
      .mockRejectedValueOnce({ code: "WINDOW_ERROR" })
      .mockResolvedValueOnce(geometry);
    render(<SettingsView />);
    expect(await screen.findByRole("alert")).toBeVisible();
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("当前尺寸 1120 × 740");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toBeEnabled();
  });

  it("浏览器预览禁用原生尺寸预设，显示环境限制且允许保存启动位置偏好", async () => {
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    expect(
      presets.getByRole("button", { name: "紧凑 960 × 640" }),
    ).toBeDisabled();
    expect(
      presets.getByRole("button", { name: "标准 默认尺寸" }),
    ).toBeDisabled();
    expect(
      presets.getByRole("button", { name: "舒适 1280 × 800" }),
    ).toBeDisabled();
    expect(
      presets.getByRole("button", { name: "宽敞 1440 × 900" }),
    ).toBeDisabled();
    for (const button of presets.getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(
      within(document.getElementById("settings-window")!).queryByRole(
        "spinbutton",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "应用窗口大小" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("窗口大小仅桌面版可改，浏览器预览不支持。"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("窗口大小与系统集成仅桌面版可改，浏览器不支持。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "了解窗口大小" }),
    ).not.toBeInTheDocument();
    expect(desktop.getWindowGeometry).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "记住上次位置" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "居中" }));
    await waitFor(() =>
      expect(
        browserClientStateStore().read().state.preferences.windowPosition,
      ).toBe("center"),
    );
    expect(desktop.setWindowSize).not.toHaveBeenCalled();
    expect(desktop.resetWindowGeometry).not.toHaveBeenCalled();
  });

  it("选择预设立即应用，显示原生返回的实际尺寸且不强制匹配预设", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.setWindowSize).mockResolvedValue({
      ...geometry,
      width: 1272,
      height: 792,
    });
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    await waitFor(() =>
      expect(
        presets.getByRole("button", {
          name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
        }),
      ).toBeEnabled(),
    );
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    );
    expect(await screen.findByText("当前尺寸 1272 × 792")).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
    expect(desktop.setWindowSize).toHaveBeenCalledExactlyOnceWith(1280, 800);
    for (const button of presets.getAllByRole("button"))
      expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("窗口监听就绪后读取尺寸，覆盖监听注册期间的变化", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    let finishResize!: (stop: () => void) => void;
    let finishMove!: (stop: () => void) => void;
    vi.mocked(desktop.onWindowResized).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishResize = resolve;
        }),
    );
    vi.mocked(desktop.onWindowMoved).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMove = resolve;
        }),
    );
    render(<SettingsView />);
    expect(desktop.getWindowGeometry).not.toHaveBeenCalled();
    await act(async () => finishResize(vi.fn()));
    expect(desktop.getWindowGeometry).not.toHaveBeenCalled();
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1280,
      height: 800,
    });
    await act(async () => finishMove(vi.fn()));
    expect(screen.getByText("当前尺寸 1280 × 800")).toBeVisible();
    expect(desktop.getWindowGeometry).toHaveBeenCalledOnce();
  });

  it("禁用超出屏幕范围的固定档位，标准尺寸随屏幕范围适配", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1000,
      height: 700,
      maxWidth: 1000,
      maxHeight: 700,
    });
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    await waitFor(() =>
      expect(
        presets.getByRole("button", { name: /^紧凑 960 × 640(?: |$)/ }),
      ).toBeEnabled(),
    );
    expect(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    ).toBeDisabled();
    expect(
      presets.getByRole("button", { name: /^宽敞 1440 × 900(?: |$)/ }),
    ).toBeDisabled();
    expect(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    ).toHaveAccessibleDescription("超出当前屏幕可用范围");
    const disabledReason = presets.getByRole("group", { name: "舒适" });
    expect(disabledReason).toHaveAttribute("tabindex", "0");
    fireEvent.focus(disabledReason);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "超出当前屏幕可用范围",
    );
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toHaveTextContent("1000 × 700");
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toHaveTextContent("已适应当前屏幕");
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toBeEnabled();
    fireEvent.click(
      presets.getByRole("button", { name: /^宽敞 1440 × 900(?: |$)/ }),
    );
    expect(desktop.setWindowSize).not.toHaveBeenCalled();
  });

  it("全部固定档位越界时标准仍可选，并使用适配后的尺寸", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 920,
      height: 590,
      minHeight: 500,
      maxWidth: 920,
      maxHeight: 590,
    });
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    const standard = presets.getByRole("button", {
      name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
    });
    await waitFor(() => expect(standard).toBeEnabled());
    for (const name of [
      /^紧凑 960 × 640/,
      /^舒适 1280 × 800/,
      /^宽敞 1440 × 900/,
    ])
      expect(presets.getByRole("button", { name })).toBeDisabled();
    expect(standard).toHaveTextContent("920 × 590");
    fireEvent.click(standard);
    await waitFor(() =>
      expect(desktop.setWindowSize).toHaveBeenCalledExactlyOnceWith(920, 590),
    );
  });

  it("标准尺寸使用品牌配置，并消除与固定预设重复的选项", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1280,
      height: 800,
      defaultWidth: 1280,
      defaultHeight: 800,
    });
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    await waitFor(() =>
      expect(
        presets.getByRole("button", {
          name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
        }),
      ).toBeEnabled(),
    );
    expect(presets.getAllByRole("button")).toHaveLength(3);
    expect(
      presets.queryByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    ).not.toBeInTheDocument();
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toHaveTextContent("1280 × 800");
    expect(
      presets.getByRole("button", {
        name: /^标准 (?:\d+ × \d+|默认尺寸)(?: |$)/,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("手动调整窗口后刷新当前尺寸，不自动选择最接近的预设", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    let resized!: () => void;
    vi.mocked(desktop.onWindowResized).mockImplementation(async (handler) => {
      resized = handler;
      return vi.fn<() => void>();
    });
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1070,
      height: 705,
    });
    act(() => resized());
    await screen.findByText("当前尺寸 1070 × 705");
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    for (const button of presets.getAllByRole("button"))
      expect(button).toHaveAttribute("aria-pressed", "false");
    expect(desktop.setWindowSize).not.toHaveBeenCalled();
  });

  it("应用尺寸期间阻止重复操作，失败通过toast提供刷新且不插入错误横幅", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    let rejectSize!: (error: unknown) => void;
    vi.mocked(desktop.setWindowSize).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSize = reject;
        }),
    );
    render(<SettingsView />);
    const presets = within(screen.getByRole("group", { name: "窗口大小" }));
    await waitFor(() =>
      expect(
        presets.getByRole("button", { name: /^紧凑 960 × 640(?: |$)/ }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      presets.getByRole("button", { name: /^紧凑 960 × 640(?: |$)/ }),
    );
    fireEvent.click(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    );
    expect(desktop.setWindowSize).toHaveBeenCalledExactlyOnceWith(960, 640);
    expect(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    ).toBeDisabled();
    await act(async () => rejectSize({ code: "WINDOW_ERROR" }));
    expect(toast.error).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("当前尺寸 1120 × 740")).toBeVisible();
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1000,
      height: 700,
      maxWidth: 1000,
      maxHeight: 700,
    });
    const refresh = vi.mocked(toast.error).mock.calls.at(-1)?.[1]?.action as
      { label: string; onClick(): void } | undefined;
    expect(refresh?.label).toBe("刷新");
    await act(async () => refresh?.onClick());
    await screen.findByText("当前尺寸 1000 × 700");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      presets.getByRole("button", { name: /^舒适 1280 × 800(?: |$)/ }),
    ).toBeDisabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("启动位置通过普通设置同步保存，不移动已打开的窗口", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    fireEvent.click(screen.getByRole("radio", { name: "居中" }));
    await waitFor(() => expect(desktop.saveClientState).toHaveBeenCalled());
    expect(
      vi.mocked(desktop.saveClientState).mock.calls.at(-1)?.[0].preferences,
    ).toMatchObject({
      windowPosition: "center",
    });
    expect(screen.getByRole("radio", { name: "居中" })).toBeChecked();
    expect(desktop.setWindowSize).not.toHaveBeenCalled();
    expect(desktop.resetWindowGeometry).not.toHaveBeenCalled();
  });

  it("恢复默认大小并保留当前位置，等待偏好持久化成功后才关闭确认框", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.readClientState).mockResolvedValue(
      clientSnapshot({ windowPosition: "center" }),
    );
    let finishSave!: (snapshot: ClientStateSnapshot) => void;
    vi.mocked(desktop.saveClientState).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1120 × 740");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "居中" })).toBeChecked(),
    );
    const dialog = confirmReset();
    expect(dialog.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "重置偏好" }));
    await waitFor(() => expect(desktop.saveClientState).toHaveBeenCalledOnce());
    expect(desktop.resetWindowGeometry).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
    expect(vi.mocked(desktop.saveClientState).mock.calls[0]?.[0]).toMatchObject(
      {
        preferences: { windowPosition: "remember" },
      },
    );
    await act(async () => finishSave({ ...clientSnapshot(), revision: "2" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("radio", { name: "记住上次位置" })).toBeChecked();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("原生重置失败时保留确认和实际尺寸，不写入偏好", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1280,
      height: 800,
    });
    vi.mocked(desktop.resetWindowGeometry).mockRejectedValue({
      code: "WINDOW_ERROR",
    });
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1280 × 800");
    const dialog = confirmReset();
    fireEvent.click(dialog.getByRole("button", { name: "重置偏好" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(desktop.resetWindowGeometry).toHaveBeenCalledExactlyOnceWith(false);
    expect(host.save).not.toHaveBeenCalled();
    expect(desktop.saveClientState).not.toHaveBeenCalled();
    expect(screen.getByText("当前尺寸 1280 × 800")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("偏好保存失败保留确认框，尺寸仍显示已成功重置的实际值", async () => {
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    vi.mocked(desktop.getWindowGeometry).mockResolvedValue({
      ...geometry,
      width: 1280,
      height: 800,
    });
    vi.mocked(desktop.saveClientState).mockRejectedValue({
      code: "STORAGE_IO",
    });
    render(<SettingsView />);
    await screen.findByText("当前尺寸 1280 × 800");
    const dialog = confirmReset();
    fireEvent.click(dialog.getByRole("button", { name: "重置偏好" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("当前尺寸 1120 × 740")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
