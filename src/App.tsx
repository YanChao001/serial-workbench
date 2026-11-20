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
import { ClientDraftsProvider } from "@/providers/client-drafts";
import { CommandsProvider } from "@/providers/commands";
import { CommandPalette } from "@/components/command-palette";
import { DesktopEffects } from "@/components/desktop-effects";
import { APP_ROUTES } from "@/routes";
import { UnsavedWorkProvider } from "@/providers/unsaved-work";
import { RecoveryGate } from "@/components/recovery-gate";
import { DEFAULT_SETTINGS, THEME_STORAGE_KEY } from "@/lib/settings-model";
import { ThemeEffects } from "@/components/theme-effects";
import { OperationFailureObserver } from "@/features/workbench/operation-failure-notices";
import { BrowserPairingScreen } from "@/features/browser/browser-pairing-screen";
import { BrowserTakeoverNotice } from "@/features/browser/browser-takeover-notice";
import { useBrowserPairing } from "@/features/browser/use-browser-pairing";
import { LanWorkbench } from "@/features/lan/lan-workbench";
import { getLocalHostClient } from "@/lib/host-client";

function AppEffects() {
  useExternalLinks();
  useRevealWindow();
  useDesktopContextMenu();
  return null;
}
export default function App() {
  const browser = useBrowserPairing();
  return (
    <HostProvider
      enabled={browser.clientId ? browser.paired : undefined}
      connect={browser.clientId ? browser.connect : getLocalHostClient}
    >
      <ClientDraftsProvider>
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
                <OperationFailureObserver />
                <BrowserTakeoverNotice />
                <TooltipProvider>
                  {/* HashRouter 保留自定义协议和浏览器子路径的刷新入口。 */}
                  {browser.clientId && !browser.paired ? (
                    <BrowserPairingScreen pair={browser.pair} />
                  ) : (
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
                            {APP_ROUTES.map(
                              ({ path, component: Page, index }) => (
                                <Route
                                  key={path}
                                  index={index}
                                  path={index ? undefined : path}
                                  element={
                                    index ? (
                                      <LanWorkbench>
                                        <Page />
                                      </LanWorkbench>
                                    ) : (
                                      <Page />
                                    )
                                  }
                                />
                              ),
                            )}
                            <Route
                              path="*"
                              element={<Navigate to="/" replace />}
                            />
                          </Route>
                        </Routes>
                      </CommandsProvider>
                    </HashRouter>
                  )}
                  <Toaster
                    position="bottom-right"
                    offset={{ bottom: "var(--workbench-toast-bottom, 24px)" }}
                    mobileOffset={{
                      bottom: "var(--workbench-toast-bottom, 16px)",
                    }}
                  />
                </TooltipProvider>
              </ThemeProvider>
            </UnsavedWorkProvider>
          </I18nProvider>
        </SettingsProvider>
      </ClientDraftsProvider>
    </HostProvider>
  );
}
