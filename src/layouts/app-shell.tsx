import {
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { TitleBar } from "@/components/title-bar";
import { WindowBackground } from "@/components/window-background";
import { useSettings } from "@/providers/settings";
import { useCommands } from "@/providers/commands";
import { ImmersiveNavigation } from "@/components/immersive-navigation";
import { APP_ROUTES } from "@/routes";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED_WIDTH } from "@/lib/settings-model";
import { useAppChrome } from "@/hooks/use-app-chrome";
import "@/styles/app-navigation.css";
import { PageLoading } from "@/components/page-loading";
import { RouteErrorBoundary } from "@/components/route-error-boundary";

/** 感知路由的应用布局；页面失败时保留导航能力 */
export function AppShell() {
  const { pathname } = useLocation();
  const { settings } = useSettings();
  const [sidebarPreviewWidth, setSidebarPreviewWidth] = useState<number | null>(
    null,
  );
  const { fullscreen } = useCommands();
  const routes = APP_ROUTES.filter((route) => !route.hidden);
  const chrome = useAppChrome();
  const content = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    // 仅切换页面时重置滚动；设置搜索可能在当前路径内主动聚焦字段
    // 导航更新不应覆盖该焦点
    if (content.current) {
      content.current.scrollTop = 0;
      content.current.scrollLeft = 0;
    }
  }, [pathname]);

  return (
    <div
      className={cn(
        "app-shell text-foreground",
        !isTauri() && "app-shell-browser",
        fullscreen && "app-shell-immersive",
      )}
      style={
        {
          "--app-sidebar-width": `${settings.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : (sidebarPreviewWidth ?? settings.sidebarWidth)}px`,
        } as CSSProperties
      }
    >
      <WindowBackground />
      {fullscreen ? <ImmersiveNavigation /> : null}
      <div ref={chrome} id="app-chrome" className="app-chrome">
        <TitleBar />
      </div>
      <AppSidebar routes={routes} onWidthPreview={setSidebarPreviewWidth} />
      <main
        ref={content}
        className="app-main app-scroll-region outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        tabIndex={0}
      >
        <div className="app-page-content">
          <Suspense key={pathname} fallback={<PageLoading />}>
            <RouteErrorBoundary>
              <Outlet />
            </RouteErrorBoundary>
          </Suspense>
        </div>
      </main>
    </div>
  );
}
