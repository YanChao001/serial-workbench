import { Activity, Suspense, useState, type ReactNode } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { PageLoading } from "@/components/page-loading";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { APP_ROUTES } from "@/routes";

/** 仅保留访问过的已注册页面；持续接收页面的任务归当前窗口所有。 */
export function CachedOutlet() {
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const key = APP_ROUTES.find((route) =>
    route.exact
      ? pathname === route.path
      : pathname === route.path || pathname.startsWith(`${route.path}/`),
  )?.path;
  const [pages, setPages] = useState(() =>
    key
      ? new Map<string, ReactNode>([[key, outlet]])
      : new Map<string, ReactNode>(),
  );
  if (key && !pages.has(key)) setPages(new Map(pages).set(key, outlet));
  return (
    <>
      {[...pages].map(([path, cached]) => {
        const content = (
          <Suspense fallback={<PageLoading />}>
            <RouteErrorBoundary>
              {path === key ? outlet : cached}
            </RouteErrorBoundary>
          </Suspense>
        );
        return APP_ROUTES.find((route) => route.path === path)?.keepRunning ? (
          <div
            key={path}
            style={{ display: path === key ? "contents" : "none" }}
            inert={path !== key}
            aria-hidden={path !== key || undefined}
          >
            {content}
          </div>
        ) : (
          <Activity key={path} mode={path === key ? "visible" : "hidden"}>
            {content}
          </Activity>
        );
      })}
      {!key && (
        <Suspense fallback={<PageLoading />}>
          <RouteErrorBoundary>{outlet}</RouteErrorBoundary>
        </Suspense>
      )}
    </>
  );
}
