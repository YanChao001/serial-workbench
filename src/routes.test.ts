// @vitest-environment node
import { describe, expect, it } from "vitest";
import { APP_ROUTES, matchRoute } from "./routes";

describe("路由配置与匹配", () => {
  it("路径唯一且首页唯一", () => {
    expect(new Set(APP_ROUTES.map(({ path }) => path)).size).toBe(
      APP_ROUTES.length,
    );
    expect(
      APP_ROUTES.filter(({ index }) => index).map(({ path }) => path),
    ).toEqual(["/"]);
  });

  it("按路径段匹配子页面，未知路径返回首页", () => {
    expect(matchRoute("/settings/appearance").path).toBe("/settings");
    expect(matchRoute("/desktop").group).toBe("system");
    expect(matchRoute("/desktop").hidden).toBe(true);
    expect(matchRoute("/updates")).toMatchObject({
      hidden: true,
      labelKey: "nav.settings",
    });
    expect(matchRoute("/desktop-tools").path).toBe("/");
    expect(matchRoute("/unknown").path).toBe("/");
  });
  it("只展示工作区与设置，诊断和恢复保留为设置内入口", () => {
    expect(
      APP_ROUTES.filter((route) => !route.hidden).map((route) => route.path),
    ).toEqual(["/", "/settings"]);
    expect(
      APP_ROUTES.filter(
        (route) => !route.hidden && route.navigationPlacement !== "footer",
      ).map((route) => route.path),
    ).toEqual(["/"]);
    expect(
      APP_ROUTES.filter(
        (route) => !route.hidden && route.navigationPlacement === "footer",
      ).map((route) => route.path),
    ).toEqual(["/settings"]);
    expect(matchRoute("/diagnostics")).toMatchObject({ hidden: true });
    expect(matchRoute("/recovery")).toMatchObject({
      path: "/recovery",
      hidden: true,
    });
  });
  it("移除演示路由，旧链接回到首页", () => {
    for (const path of [
      "/motion",
      "/catalog",
      "/bridge",
      "/components",
      "/database",
      "/tasks",
      "/workbench",
      "/system",
      "/network",
      "/data-studio",
      "/media",
    ])
      expect(matchRoute(path).path).toBe("/");
  });
});
