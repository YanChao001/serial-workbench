import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BookOpenIcon,
  AppWindowIcon,
  Code2Icon,
  CommandIcon,
  DownloadIcon,
  ExpandIcon,
  InfoIcon,
  KeyboardIcon,
  LogOutIcon,
  Maximize2Icon,
  MinimizeIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SettingsIcon,
  SunIcon,
  SunMoonIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { APP_CONFIG } from "@/config/app";
import { commandAvailable, type AppCommand } from "@/commands/types";
import { matchesShortcut, sameShortcut } from "@/commands/shortcuts";
import type { ShortcutBinding } from "@/lib/generated/bindings";
import { SETTINGS_SEARCH_ENTRIES } from "@/commands/settings-search";
import { SETTINGS_ICONS } from "@/lib/settings-icons";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import { useThemeSwitch } from "@/hooks/use-theme-switch";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { nativeErrorText } from "@/lib/native-error";
import {
  closeWindow,
  openSecondaryWindow,
  isTauri,
  minimizeWindow,
  openExternal,
  quitApp,
  toggleMaximizeWindow,
} from "@/lib/tauri";
import { useSettings } from "@/providers/settings";
import { APP_ROUTES, settingsLocation } from "@/routes";
import { ActivityNavigationContext, CommandsContext } from "./commands-context";
import { useGlobalSendShortcut } from "./use-global-send-shortcut";

export function CommandsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { settings, update } = useSettings();
  const { setTheme, toggle } = useThemeSwitch();
  const themeToggle = useRef(toggle);
  useLayoutEffect(() => {
    themeToggle.current = toggle;
  }, [toggle]);
  const t = useLatestTranslator();
  const { fullscreen, change: changeFullscreen } = useFullscreen();
  const [overlay, setOverlay] = useState<"actions" | "shortcuts" | null>(null);
  const setPaletteOpen = useCallback((open: boolean) => {
    setOverlay(open ? "actions" : null);
  }, []);
  const [aboutOpen, setAboutOpen] = useState(false);
  const globalSend = useGlobalSendShortcut(overlay !== null || aboutOpen);
  const [registrations, setRegistrations] = useState<
    Map<symbol, readonly AppCommand[]>
  >(() => new Map());
  const running = useRef(new Set<string>());
  const revealActivityPage = useCallback(
    (pageId: string) => {
      const path = pageId === "workbench" ? "/" : `/${pageId}`;
      if (
        path !== pathname &&
        APP_ROUTES.some((route) => route.path === path && !route.hidden)
      )
        navigate(path, { replace: true });
    },
    [navigate, pathname],
  );

  const builtins = useMemo<AppCommand[]>(
    () => [
      ...APP_ROUTES.filter(
        (route) => route.path !== "/settings" && !route.hidden,
      ).map((route) => ({
        id: `navigate:${route.path}`,
        labelKey: route.labelKey,
        group: "navigation" as const,
        icon: route.icon,
        keywords: [route.path],
        run: () => navigate(route.path),
      })),
      {
        id: "command-palette",
        labelKey: "commands.open",
        group: "navigation",
        icon: CommandIcon,
        shortcuts: [{ key: "k", primary: true, allowInEditable: true }],
        rebindable: true,
        run: () =>
          setOverlay((mode) => (mode === "actions" ? null : "actions")),
      },
      ...SETTINGS_SEARCH_ENTRIES.map((entry) => ({
        id: `settings:${entry.id}`,
        labelKey: entry.labelKey,
        group: "appearance" as const,
        icon: SETTINGS_ICONS[entry.id],
        keywords: [...entry.keywords],
        keywordKeys: entry.searchKeys,
        available: entry.desktopOnly ? isTauri : undefined,
        run: () => navigate(settingsLocation(entry.id)),
      })),
      {
        id: "open-settings",
        labelKey: "title.settings",
        group: "navigation",
        icon: SettingsIcon,
        shortcuts: [{ key: ",", primary: true }],
        rebindable: true,
        run: () =>
          navigate("/settings?focus=search", {
            replace: pathname === "/settings",
          }),
      },
      {
        id: "toggle-sidebar",
        labelKey: "layout.toggleSidebar",
        group: "appearance",
        icon: PanelLeftIcon,
        shortcuts: [{ key: "b", primary: true }],
        rebindable: true,
        run: () => update({ sidebarCollapsed: !settings.sidebarCollapsed }),
      },
      {
        id: "toggle-menu",
        labelKey: "title.toggleMenu",
        group: "appearance",
        icon: PanelTopIcon,
        run: () => update({ menuBar: !settings.menuBar }),
      },
      {
        id: "toggle-fullscreen",
        labelKey: fullscreen ? "title.exitFullscreen" : "title.fullscreen",
        group: "window",
        icon: fullscreen ? MinimizeIcon : ExpandIcon,
        shortcuts: [{ key: "F11", allowInEditable: true }],
        rebindable: true,
        available: () => isTauri() || !!document.fullscreenEnabled,
        run: () => changeFullscreen(),
      },
      {
        id: "exit-fullscreen",
        labelKey: "title.exitFullscreen",
        group: "window",
        icon: MinimizeIcon,
        shortcuts: [{ key: "Escape", allowInEditable: true }],
        available: () => fullscreen,
        run: () => changeFullscreen(false),
      },
      {
        id: "toggle-theme",
        labelKey: "title.toggleTheme",
        group: "appearance",
        icon: SunMoonIcon,
        run: () => themeToggle.current(),
      },
      ...(["light", "dark", "system"] as const).map((theme) => ({
        id: `theme-${theme}`,
        labelKey: `title.${theme}` as const,
        group: "appearance" as const,
        icon:
          theme === "light"
            ? SunIcon
            : theme === "dark"
              ? MoonIcon
              : MonitorIcon,
        run: () => setTheme(theme),
      })),
      {
        id: "minimize-window",
        labelKey: "title.minimize",
        group: "window",
        icon: MinusIcon,
        available: isTauri,
        run: minimizeWindow,
      },
      {
        id: "toggle-maximize",
        labelKey: "title.maximize",
        group: "window",
        icon: Maximize2Icon,
        available: isTauri,
        run: toggleMaximizeWindow,
      },
      {
        id: "close-window",
        labelKey: "title.close",
        group: "window",
        icon: XIcon,
        available: isTauri,
        run: closeWindow,
      },
      {
        id: "quit",
        labelKey: "title.quit",
        group: "window",
        icon: LogOutIcon,
        available: isTauri,
        run: quitApp,
      },
      {
        id: "keyboard-shortcuts",
        labelKey: "commands.shortcuts",
        group: "help",
        icon: KeyboardIcon,
        shortcuts: [{ key: "F1", allowInEditable: true }],
        run: () =>
          setOverlay((mode) => (mode === "shortcuts" ? null : "shortcuts")),
      },
      {
        id: "open-docs",
        labelKey: "title.docs",
        group: "help",
        icon: BookOpenIcon,
        run: () => openExternal(APP_CONFIG.docsUrl),
      },
      {
        id: "open-repo",
        labelKey: "title.repo",
        group: "help",
        icon: Code2Icon,
        run: () => openExternal(APP_CONFIG.repositoryUrl),
      },
      {
        id: "about",
        labelKey: "title.about",
        group: "help",
        icon: InfoIcon,
        run: () => setAboutOpen(true),
      },
      {
        id: "open-desktop",
        labelKey: "commands.openDesktop",
        group: "tools",
        icon: MonitorIcon,
        run: () => navigate("/settings?section=desktop"),
      },
      {
        id: "open-window",
        labelKey: "commands.openWindow",
        group: "tools",
        icon: AppWindowIcon,
        run: () =>
          isTauri()
            ? openSecondaryWindow()
            : navigate("/settings?focus=windows"),
      },
      {
        id: "check-updates",
        labelKey: "commands.checkUpdates",
        group: "tools",
        icon: DownloadIcon,
        run: () => navigate("/settings?section=updates"),
      },
    ],
    [
      navigate,
      pathname,
      fullscreen,
      changeFullscreen,
      setTheme,
      settings.menuBar,
      settings.sidebarCollapsed,
      update,
    ],
  );

  const commands = useMemo(() => {
    const result = new Map(builtins.map((command) => [command.id, command]));
    for (const registration of registrations.values())
      for (const command of registration) result.set(command.id, command);
    return [...result.values()].map((command) => {
      const defaultShortcut = command.shortcuts?.[0];
      if (!command.rebindable || !defaultShortcut) return command;
      const binding = settings.shortcutOverrides?.[command.id];
      return {
        ...command,
        defaultShortcut,
        shortcuts: binding
          ? [{ ...binding, allowInEditable: defaultShortcut.allowInEditable }]
          : command.shortcuts,
      };
    });
  }, [builtins, registrations, settings.shortcutOverrides]);

  const changeShortcut = useCallback(
    (id: string, binding: ShortcutBinding) => {
      const selected = commands.find((command) => command.id === id);
      if (!selected?.defaultShortcut || !commandAvailable(selected)) return;
      const shortcutOverrides: Record<string, ShortcutBinding> = {
        ...settings.shortcutOverrides,
      };
      if (sameShortcut(selected.defaultShortcut, binding))
        delete shortcutOverrides[id];
      else shortcutOverrides[id] = binding;
      update({ shortcutOverrides });
    },
    [commands, settings.shortcutOverrides, update],
  );

  const register = useCallback((items: readonly AppCommand[]) => {
    const token = Symbol("commands");
    setRegistrations((current) => new Map(current).set(token, items));
    return () => {
      setRegistrations((current) => {
        const next = new Map(current);
        next.delete(token);
        return next;
      });
    };
  }, []);

  const execute = useCallback(
    async (id: string) => {
      const command = commands.find((item) => item.id === id);
      if (!command || !commandAvailable(command) || running.current.has(id))
        return false;
      running.current.add(id);
      try {
        const result = command.run();
        if (result) await result;
        return true;
      } catch (error) {
        toast.error(nativeErrorText(error, t));
        return false;
      } finally {
        running.current.delete(id);
      }
    },
    [commands, t],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const [first, second] = commands.filter(
        (item) =>
          commandAvailable(item) &&
          item.shortcuts?.some((shortcut) => matchesShortcut(event, shortcut)),
      );
      if (!first) return;
      event.preventDefault();
      if (!second) void execute(first.id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commands, execute]);

  const value = useMemo(
    () => ({
      commands,
      execute,
      register,
      paletteOpen: overlay !== null,
      shortcutHelp: overlay === "shortcuts",
      changeShortcut,
      globalSend,
      setPaletteOpen,
      aboutOpen,
      setAboutOpen,
      fullscreen,
    }),
    [
      commands,
      execute,
      register,
      overlay,
      changeShortcut,
      globalSend,
      setPaletteOpen,
      aboutOpen,
      fullscreen,
    ],
  );
  return (
    <CommandsContext.Provider value={value}>
      <ActivityNavigationContext.Provider value={revealActivityPage}>
        {children}
      </ActivityNavigationContext.Provider>
    </CommandsContext.Provider>
  );
}

export function useCommands() {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("useCommands requires CommandsProvider");
  return value;
}

/** 注册引用稳定的命令数组；清理时恢复该功能覆盖的命令 */
export function useRegisterCommands(commands: readonly AppCommand[]) {
  const { register } = useCommands();
  useEffect(() => register(commands), [commands, register]);
}
