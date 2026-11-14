import { useSynchronizedTheme } from "@/hooks/use-theme-switch";

/** 两种窗口布局共用主题同步，不等待页面截图或动效完成。 */
export function ThemeEffects() {
  useSynchronizedTheme();
  return null;
}
