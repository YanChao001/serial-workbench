import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { TitleBar } from "@/components/title-bar";
import { WindowBackground } from "@/components/window-background";
import { useSettings } from "@/providers/settings";
import { useCommands } from "@/providers/commands";
import { ImmersiveNavigation } from "@/components/immersive-navigation";
import { APP_ROUTES, matchRoute } from "@/routes";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED_WIDTH } from "@/lib/settings-model";
import { useAppChrome } from "@/hooks/use-app-chrome";
import "@/styles/app-navigation.css";
import { CachedOutlet } from "./cached-outlet";
import { WorkspaceSidebarContext } from "./workspace-sidebar-context";

/** 感知路由的应用布局；页面失败时保留导航能力 */
export function AppShell() {
  const { pathname } = useLocation();
  const contentLayout = matchRoute(pathname).contentLayout ?? "document";
  const { settings } = useSettings();
  const [sidebarPreviewWidth, setSidebarPreviewWidth] = useState<number | null>(
    null,
  );
  const [workspaceSidebar, setWorkspaceSidebar] = useState<number>();
  const sidebar = useMemo(
    () => ({ width: workspaceSidebar, setWidth: setWorkspaceSidebar }),
    [workspaceSidebar],
  );
  const workspaceWidth =
    contentLayout === "workspace" ? workspaceSidebar : undefined;
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
          "--app-sidebar-width": `${settings.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : (sidebarPreviewWidth ?? workspaceWidth ?? settings.sidebarWidth)}px`,
        } as CSSProperties
      }
    >
      <WindowBackground />
      {fullscreen ? <ImmersiveNavigation /> : null}
      <div ref={chrome} id="app-chrome" className="app-chrome">
        <TitleBar />
      </div>
      <AppSidebar
        routes={routes}
        onWidthPreview={setSidebarPreviewWidth}
        workspaceWidth={workspaceWidth}
        onWorkspaceWidthChange={
          workspaceWidth === undefined ? undefined : setWorkspaceSidebar
        }
      />
      <main
        ref={content}
        data-content-layout={contentLayout}
        className="app-main app-scroll-region outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        tabIndex={0}
      >
        <div className="app-page-content" data-content-layout={contentLayout}>
          <WorkspaceSidebarContext.Provider value={sidebar}>
            <CachedOutlet />
          </WorkspaceSidebarContext.Provider>
        </div>
      </main>
    </div>
  );
}
