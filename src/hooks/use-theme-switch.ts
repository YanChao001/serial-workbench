import { useTheme } from "next-themes";
import { useSettings } from "@/providers/settings";
import { useCallback, useEffect, useRef } from "react";
import { THEMES, THEME_STORAGE_KEY, type AppTheme } from "@/lib/settings-model";
import { isTauri } from "@/lib/tauri";
import { flushSync } from "react-dom";
import { useMotionActivity } from "./use-motion-activity";
import { startThemeReveal } from "./theme-reveal";

/** 接受后的共享主题即时应用；整页 View Transition 会阻断原页面命中。 */
export function useSynchronizedTheme() {
  const { theme, setTheme } = useTheme();
  const { settings, persistence } = useSettings();
  const native = isTauri();
  useEffect(() => {
    // 主题缓存仅用于首屏，运行时由 SettingsSync 接受的 revision 决定。
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) event.stopImmediatePropagation();
    };
    window.addEventListener("storage", onStorage, true);
    return () => window.removeEventListener("storage", onStorage, true);
  }, []);
  useEffect(() => {
    if (native && persistence === "loading") return;
    if (theme !== settings.theme)
      startThemeReveal(() => setTheme(settings.theme), false);
  }, [theme, settings.theme, persistence, setTheme, native]);
}

/** 设置、命令和标题栏共用即时提交；连续点击以最新意图决定下一个主题。 */
export function useThemeSwitch() {
  const { setTheme: applyTheme, resolvedTheme } = useTheme();
  const { settings, update } = useSettings();
  const { active: motionActive } = useMotionActivity();
  const visual = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => visual.current?.(), []);
  useEffect(() => {
    if (!motionActive) visual.current?.();
  }, [motionActive]);
  const requested = useRef(resolvedTheme);
  useEffect(() => {
    requested.current =
      settings.theme === "system" ? resolvedTheme : settings.theme;
  }, [settings.theme, resolvedTheme]);
  const commitTheme = useCallback(
    (value: AppTheme) => {
      const previousTheme = requested.current;
      requested.current =
        value === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : value;
      visual.current = startThemeReveal(
        () => {
          flushSync(() => {
            update({ theme: value });
            applyTheme(value);
          });
        },
        motionActive && requested.current !== previousTheme,
      );
    },
    [update, applyTheme, motionActive],
  );
  const setTheme = useCallback(
    (value: string) => {
      if (THEMES.includes(value as AppTheme)) commitTheme(value as AppTheme);
    },
    [commitTheme],
  );
  const toggle = useCallback(
    () => commitTheme(requested.current === "dark" ? "light" : "dark"),
    [commitTheme],
  );
  return { theme: settings.theme, setTheme, resolvedTheme, toggle };
}
