import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  LayoutDashboardIcon,
  SettingsIcon,
  MonitorIcon,
  ActivityIcon,
  DownloadIcon,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey as DictKey } from "@/i18n/zh-CN";

type PageComponent = ComponentType | LazyExoticComponent<ComponentType>;

export const NAVIGATION_GROUPS = [
  { id: "experience", labelKey: "navGroup.experience" },
  { id: "system", labelKey: "navGroup.system" },
] as const satisfies readonly { id: string; labelKey: DictKey }[];

export type NavigationGroup = (typeof NAVIGATION_GROUPS)[number]["id"];

/**
 * 路由与侧边导航的唯一数据源。
 * 加页面时只改这里，`App` 的路由表和 `AppShell` 的导航会自动跟着变。
 */
export type AppRoute = {
  /** 路由路径，首页是 "/" */
  path: string;
  /** 导航与页面标题的 i18n key */
  labelKey: DictKey;
  /** 展示分组只影响导航，不改变 URL 与命令注册。 */
  group: NavigationGroup;
  icon: LucideIcon;
  component: PageComponent;
  /** 内容区布局；默认文档流，工作台占满可用高度并在内部滚动。 */
  contentLayout?: "document" | "workspace";
  /** 导航意图只预载模块，不挂载页面或执行数据 / 原生操作。 */
  preload?: () => void;
  /**
   * 作为父路由的默认页，只有首页该为 true。
   * 它和 `exact` 是两件事：前者决定路由结构，后者只影响导航高亮。
   */
  index?: boolean;
  /** 导航高亮是否精确匹配。父级路径（如 "/settings"）通常不需要 */
  exact?: boolean;
  hidden?: boolean;
  /** 固定在侧栏底部的全局入口，默认随主导航分组展示。 */
  navigationPlacement?: "footer";
};
export type AppNavigationItem = Pick<
  AppRoute,
  | "path"
  | "labelKey"
  | "group"
  | "icon"
  | "exact"
  | "preload"
  | "navigationPlacement"
> & { label?: string };

function lazyPage(load: () => Promise<{ default: ComponentType }>) {
  return {
    component: lazy(load),
    preload: () => {
      // import 自身复用模块缓存；预载失败交给实际导航时的错误边界展示。
      void load().catch(() => {});
    },
  };
}

export const APP_ROUTES: AppRoute[] = [
  {
    path: "/",
    labelKey: "nav.overview",
    group: "experience",
    icon: LayoutDashboardIcon,
    ...lazyPage(() => import("@/pages/overview")),
    contentLayout: "workspace",
    index: true,
    exact: true,
  },
  {
    path: "/recovery",
    labelKey: "nav.diagnostics",
    group: "system",
    icon: ActivityIcon,
    ...lazyPage(() => import("@/pages/recovery")),
    hidden: true,
  },
  {
    path: "/desktop",
    labelKey: "nav.settings",
    group: "system",
    icon: MonitorIcon,
    ...lazyPage(() => import("@/pages/desktop")),
    hidden: true,
  },
  {
    path: "/diagnostics",
    hidden: true,
    labelKey: "nav.diagnostics",
    group: "system",
    icon: ActivityIcon,
    ...lazyPage(() => import("@/pages/diagnostics")),
  },
  {
    path: "/updates",
    labelKey: "nav.settings",
    group: "system",
    icon: DownloadIcon,
    ...lazyPage(() => import("@/pages/updates")),
    hidden: true,
  },
  {
    path: "/settings",
    labelKey: "nav.settings",
    group: "system",
    navigationPlacement: "footer",
    icon: SettingsIcon,
    ...lazyPage(() => import("@/pages/settings")),
  },
];

/** 按当前路径读取页面元数据。 */
export function matchRoute(pathname: string): AppRoute {
  const matched = APP_ROUTES.find((route) =>
    route.exact
      ? pathname === route.path
      : pathname === route.path || pathname.startsWith(`${route.path}/`),
  );
  if (matched) return matched;

  // 未知路径回落到首页。APP_ROUTES 是编译期常量，这里只防御「被误删成空数组」
  const fallback = APP_ROUTES[0];
  if (!fallback) throw new Error("APP_ROUTES 不能为空");
  return fallback;
}
