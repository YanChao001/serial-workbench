import { ThemeProvider } from "next-themes";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useExternalLinks } from "@/hooks/use-external-links";
import { useRevealWindow } from "@/hooks/use-reveal-window";
import { useDesktopContextMenu } from "@/hooks/use-desktop-context-menu";
import { AppShell } from "@/layouts/app-shell";
import { I18nProvider } from "@/providers/i18n";
import { SettingsProvider } from "@/providers/settings";
import { HostProvider } from "@/providers/host";
import { CommandsProvider } from "@/providers/commands";
import { CommandPalette } from "@/components/command-palette";
import { DesktopEffects } from "@/components/desktop-effects";
import { APP_ROUTES } from "@/routes";
import { UnsavedWorkProvider } from "@/providers/unsaved-work";
import { RecoveryGate } from "@/components/recovery-gate";
import { DEFAULT_SETTINGS, THEME_STORAGE_KEY } from "@/lib/settings-model";
import { ThemeEffects } from "@/components/theme-effects";

function AppEffects() {
  useExternalLinks();
  useRevealWindow();
  useDesktopContextMenu();
  return null;
}
export default function App() {
  return (
    <HostProvider>
      <SettingsProvider>
        <I18nProvider>
          <UnsavedWorkProvider>
            <AppEffects />
            <ThemeProvider
              storageKey={THEME_STORAGE_KEY}
              attribute="class"
              defaultTheme={DEFAULT_SETTINGS.theme}
              enableSystem
              disableTransitionOnChange
              // main.tsx 在挂载前应用主题；当前客户端渲染不需要服务端主题脚本
              scriptProps={{ type: "text/plain" }}
            >
              <ThemeEffects />
              <TooltipProvider delayDuration={200}>
                {/* HashRouter：生产构建下用的是自定义协议，hash 路由不会出现刷新 404 */}
                <HashRouter>
                  <CommandsProvider>
                    <DesktopEffects />
                    <CommandPalette />
                    <Routes>
                      <Route
                        element={
                          <RecoveryGate>
                            <AppShell />
                          </RecoveryGate>
                        }
                      >
                        {APP_ROUTES.map(({ path, component: Page, index }) => (
                          <Route
                            key={path}
                            index={index}
                            path={index ? undefined : path}
                            element={<Page />}
                          />
                        ))}
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Route>
                    </Routes>
                  </CommandsProvider>
                </HashRouter>
                <Toaster position="bottom-right" />
              </TooltipProvider>
            </ThemeProvider>
          </UnsavedWorkProvider>
        </I18nProvider>
      </SettingsProvider>
    </HostProvider>
  );
}
