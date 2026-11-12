import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeIcon, SettingsIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/providers/i18n";
import { CommandsProvider, useCommands } from "@/providers/commands";
import { zhCN } from "@/i18n/zh-CN";
import { SettingsProvider, STORAGE_KEY } from "@/providers/settings";
import { DEFAULT_SETTINGS, settingsDocument } from "@/lib/settings-model";
import { browserClientStateStore } from "@/lib/client-settings";
import type { AppNavigationItem, AppRoute } from "@/routes";
import { AppSidebar } from "./app-sidebar";

vi.mock("@/routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes")>()),
  APP_ROUTES: [],
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  minimizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  quitApp: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("@/hooks/use-theme-switch", () => ({
  useThemeSwitch: () => ({
    resolvedTheme: "light",
    setTheme: vi.fn(),
    toggle: vi.fn(),
  }),
}));
const routes: AppRoute[] = [
  {
    path: "/",
    labelKey: "nav.overview",
    group: "experience",
    icon: HomeIcon,
    component: () => null,
    exact: true,
  },
];
const footerRoute: AppNavigationItem = {
  path: "/preferences",
  labelKey: "nav.settings",
  group: "system",
  icon: SettingsIcon,
  navigationPlacement: "footer",
};
function PaletteState() {
  const { paletteOpen } = useCommands();
  return <output data-testid="palette-state">{String(paletteOpen)}</output>;
}

function renderSidebar(
  entries: readonly AppNavigationItem[] = routes,
  initial = "/",
  children: ReactNode = null,
) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SettingsProvider>
        <I18nProvider>
          <CommandsProvider>
            <TooltipProvider>
              <AppSidebar routes={entries} />
              <PaletteState />
              {children}
            </TooltipProvider>
          </CommandsProvider>
        </I18nProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}
describe("persisted application sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const client = browserClientStateStore();
    const initial = client.read();
    client.save(
      {
        ...initial.state,
        preferences: { ...initial.state.preferences, sidebarCollapsed: false },
      },
      initial.revision,
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(settingsDocument(DEFAULT_SETTINGS)),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("preserves navigation layout classes through the Radix tooltip slot", () => {
    renderSidebar();
    const link = screen.getByRole("link", { name: zhCN["nav.overview"] });
    expect(link).toHaveClass("flex", "items-center");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link.className).not.toContain("=>");
  });

  it("adjusts width by keyboard within bounds and persists it", async () => {
    renderSidebar();
    const separator = screen.getByRole("separator", { name: "调整侧栏宽度" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "232");
    fireEvent.keyDown(separator, { key: "End" });
    const write = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(write).not.toHaveBeenCalled();
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.keyDown(separator, { key: "Home" });
    write.mockClear();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(write).not.toHaveBeenCalled();
    expect(separator).toHaveAttribute("aria-valuenow", "180");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "224");
    await waitFor(() =>
      expect(
        browserClientStateStore().read().state.preferences.sidebarWidth,
      ).toBe(224),
    );
    write.mockRestore();
  });
  it.each([undefined, "footer"] as const)(
    "waits for hover intent, cancels fly-by entry and preloads keyboard focus without navigating for %s placement",
    (navigationPlacement) => {
      vi.useFakeTimers();
      const preload = vi.fn();
      renderSidebar([
        routes[0]!,
        {
          ...routes[0]!,
          path: "/desktop",
          labelKey: "nav.settings",
          preload,
          navigationPlacement,
        },
      ]);
      const link = screen.getByRole("link", { name: zhCN["nav.settings"] });
      expect(preload).not.toHaveBeenCalled();
      fireEvent.pointerEnter(link);
      expect(preload).not.toHaveBeenCalled();
      fireEvent.pointerLeave(link);
      act(() => vi.advanceTimersByTime(200));
      expect(preload).not.toHaveBeenCalled();
      fireEvent.pointerEnter(link);
      act(() => vi.advanceTimersByTime(150));
      expect(preload).toHaveBeenCalledOnce();
      fireEvent.focus(link);
      expect(preload).toHaveBeenCalledTimes(2);
      expect(link).not.toHaveAttribute("aria-current");
      expect(
        screen.getByRole("link", { name: zhCN["nav.overview"] }),
      ).toHaveAttribute("aria-current", "page");
    },
  );
  it.each([undefined, "footer"] as const)(
    "cancels pending route preloads for %s placement when the sidebar unmounts",
    (navigationPlacement) => {
      vi.useFakeTimers();
      const preload = vi.fn();
      const view = renderSidebar([
        { ...routes[0]!, preload, navigationPlacement },
      ]);
      fireEvent.pointerEnter(
        screen.getByRole("link", { name: zhCN["nav.overview"] }),
      );
      view.unmount();
      act(() => vi.advanceTimersByTime(200));
      expect(preload).not.toHaveBeenCalled();
    },
  );
  it("keeps collapsed navigation named and restores the saved width", async () => {
    const view = renderSidebar();
    fireEvent.keyDown(screen.getByRole("separator"), {
      key: "ArrowRight",
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "48px" });
    expect(
      screen.getByRole("link", { name: zhCN["nav.overview"] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: zhCN["nav.overview"] }),
    ).toHaveClass("px-3");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() =>
      expect(browserClientStateStore().read().state.preferences).toMatchObject({
        sidebarCollapsed: true,
        sidebarWidth: 256,
      }),
    );
    view.unmount();
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "256",
    );
  });

  it("折叠不激活展开时的隐藏提示，键盘聚焦一次只显示当前一条", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderSidebar([
      routes[0]!,
      {
        ...routes[0]!,
        path: "/desktop",
        labelKey: "nav.settings",
        group: "system",
      },
    ]);
    const first = screen.getByRole("link", { name: zhCN["nav.overview"] });
    const second = screen.getByRole("link", { name: zhCN["nav.settings"] });
    fireEvent.focus(first);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(first);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      zhCN["nav.overview"],
    );
    fireEvent.focus(second);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      zhCN["nav.settings"],
    );
    // 上一项晚到的关闭不能清除当前项；切页则立即卸载提示，防止退出动画残留。
    fireEvent.blur(first);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    await act(async () => fireEvent.click(second));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("展开时为截断的导航名称提供鼠标和键盘可达的全文提示", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderSidebar();
    const control = screen.getByRole("link", { name: zhCN["nav.overview"] });
    const label = control.querySelector(".app-sidebar-label")!;
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 101 },
      scrollWidth: { configurable: true, value: 155 },
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.pointerEnter(control);
      fireEvent.pointerMove(control, { pointerType: "mouse" });
      await act(() => vi.advanceTimersByTimeAsync(999));
      expect(screen.queryByRole("tooltip")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        zhCN["nav.overview"],
      );
    } finally {
      vi.useRealTimers();
    }
    fireEvent.pointerLeave(control);
    fireEvent.focus(control);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(zhCN["nav.overview"]);
    expect(control).not.toHaveAttribute("title");
  });

  it("展开时不为完整名称显示提示，滚动和调宽会清除旧的截断判断", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderSidebar();
    const link = screen.getByRole("link", { name: zhCN["nav.overview"] });
    const label = link.querySelector(".app-sidebar-label")!;
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 101 },
      scrollWidth: { configurable: true, value: 101 },
    });
    fireEvent.focus(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.blur(link);
    Object.defineProperty(label, "scrollWidth", {
      configurable: true,
      value: 155,
    });
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(document.getElementById("app-sidebar-navigation")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.wheel(document.getElementById("app-sidebar-navigation")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    Object.defineProperty(label, "clientWidth", {
      configurable: true,
      value: 200,
    });
    fireEvent.focus(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("展开过渡结束后移除已经能完整显示的名称提示", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderSidebar();
    const link = screen.getByRole("link", { name: zhCN["nav.overview"] });
    const label = link.querySelector(".app-sidebar-label")!;
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 101 },
      scrollWidth: { configurable: true, value: 155 },
    });
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    Object.defineProperty(label, "clientWidth", {
      configurable: true,
      value: 200,
    });
    const finished = new Event("transitionend", { bubbles: true });
    Object.defineProperty(finished, "propertyName", { value: "width" });
    fireEvent(screen.getByRole("complementary"), finished);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("拖动仅预览宽度，释放后只持久化最终宽度，并处理取消和捕获丢失", async () => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
    renderSidebar();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const sidebar = screen.getByRole("complementary");
    const separator = screen.getByRole("separator");
    separator.setPointerCapture = vi.fn();
    separator.hasPointerCapture = vi.fn(() => true);
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { button: 0, pointerId: 2, clientX: 224 });
    expect(sidebar).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 264 });
    expect(sidebar).toHaveStyle({ width: "264px" });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 284 });
    expect(sidebar).toHaveStyle({ width: "284px" });
    expect(write).not.toHaveBeenCalled();
    expect(
      browserClientStateStore().read().state.preferences.sidebarWidth,
    ).toBe(224);
    fireEvent.pointerUp(separator, { pointerId: 2 });
    expect(sidebar).toHaveAttribute("data-resizing", "false");
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(2);
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(
      browserClientStateStore().read().state.preferences.sidebarWidth,
    ).toBe(284);

    write.mockClear();
    fireEvent.pointerDown(separator, { button: 0, pointerId: 3, clientX: 284 });
    fireEvent.pointerMove(separator, { pointerId: 3, clientX: 344 });
    expect(sidebar).toHaveStyle({ width: "344px" });
    fireEvent.pointerCancel(separator, { pointerId: 3 });
    expect(sidebar).toHaveStyle({ width: "284px" });
    expect(write).not.toHaveBeenCalled();

    fireEvent.pointerDown(separator, { button: 0, pointerId: 4, clientX: 284 });
    fireEvent.pointerMove(separator, { pointerId: 4, clientX: 900 });
    expect(sidebar).toHaveStyle({ width: "360px" });
    fireEvent.lostPointerCapture(separator, { pointerId: 4 });
    expect(sidebar).toHaveAttribute("data-resizing", "false");
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(
      browserClientStateStore().read().state.preferences.sidebarWidth,
    ).toBe(360);
    write.mockRestore();
  });

  it("keeps text in place for fading and exposes reduced-motion preference", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        settingsDocument({ ...DEFAULT_SETTINGS, motion: "reduced" }),
      ),
    );
    renderSidebar();
    const sidebar = screen.getByRole("complementary");
    const label = screen
      .getByRole("link", { name: zhCN["nav.overview"] })
      .querySelector("span");
    expect(sidebar).toHaveAttribute("data-motion", "reduced");
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(
      screen
        .getByRole("link", { name: zhCN["nav.overview"] })
        .querySelector("span"),
    ).toBe(label);
    expect(label).not.toHaveClass("sr-only");
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
  });

  it("clears the immediate-resize state when collapsing removes the drag handle", async () => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
    renderSidebar();
    const sidebar = screen.getByRole("complementary");
    const separator = screen.getByRole("separator");
    separator.setPointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { button: 0, pointerId: 2, clientX: 224 });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" })),
    );
    expect(sidebar).toHaveAttribute("data-resizing", "false");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "展开侧栏" })),
    );
    expect(sidebar).toHaveAttribute("data-resizing", "false");
  });

  it("groups visible routes by metadata and omits empty groups", () => {
    const view = renderSidebar();
    expect(
      within(
        screen.getByRole("group", { name: zhCN["navGroup.experience"] }),
      ).getByRole("link"),
    ).toHaveAttribute("href", "/");
    expect(
      screen.queryByRole("group", { name: zhCN["navGroup.system"] }),
    ).not.toBeInTheDocument();
    view.unmount();
    renderSidebar([
      footerRoute,
      routes[0]!,
      {
        ...routes[0]!,
        path: "/desktop",
        labelKey: "nav.settings",
        group: "system",
      },
    ]);
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toHaveLength(2);
    expect(
      screen.getByRole("group", { name: zhCN["navGroup.system"] }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation"))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/", "/desktop"]);
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(["/", "/desktop", "/preferences"]);
  });

  it("keeps footer routes named and active with an expanded label and a collapsed keyboard tooltip", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderSidebar([routes[0]!, footerRoute], "/preferences/general");
    const link = screen.getByRole("link", { name: zhCN["nav.settings"] });
    expect(link).toHaveAttribute("href", "/preferences");
    expect(link).toHaveAttribute("aria-label", zhCN["nav.settings"]);
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link.textContent).toBe(zhCN["nav.settings"]);
    expect(
      within(screen.getByRole("navigation")).queryByRole("link", {
        name: zhCN["nav.settings"],
      }),
    ).not.toBeInTheDocument();
    fireEvent.focus(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("link", { name: zhCN["nav.settings"] })).toBe(link);
    expect(link.textContent).toBe(zhCN["nav.settings"]);
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      zhCN["nav.settings"],
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("link", { name: zhCN["nav.overview"] })),
    );
    expect(link).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens the real command palette with Ctrl+K in either sidebar state without a footer action", async () => {
    renderSidebar();
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`^${zhCN["navContext.commands"]}`),
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("palette-state")).toHaveTextContent("false");
    await act(async () =>
      fireEvent.keyDown(document, { key: "k", ctrlKey: true }),
    );
    expect(screen.getByTestId("palette-state")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`^${zhCN["navContext.commands"]}`),
      }),
    ).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.keyDown(document, { key: "k", ctrlKey: true }),
    );
    expect(screen.getByTestId("palette-state")).toHaveTextContent("false");
    expect(screen.queryByText("Tauri 2 · React 19")).not.toBeInTheDocument();
  });
});
