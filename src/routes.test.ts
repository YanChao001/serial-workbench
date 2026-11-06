// @vitest-environment node
import { describe, expect, it } from "vitest";
import { APP_ROUTES, matchRoute, extensionNavigation } from "./routes";
import type { ExtensionInfo } from "@/lib/tauri";
import { NotebookPenIcon } from "lucide-react";

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
    expect(matchRoute("/desktop").group).toBe("capabilities");
    expect(matchRoute("/desktop").hidden).toBe(true);
    expect(matchRoute("/updates")).toMatchObject({
      hidden: true,
      labelKey: "nav.settings",
    });
    expect(matchRoute("/desktop-tools").path).toBe("/");
    expect(matchRoute("/unknown").path).toBe("/");
  });
  it("只展示首页、插件与设置，诊断和恢复保留为设置内入口", () => {
    expect(
      APP_ROUTES.filter((route) => !route.hidden).map((route) => route.path),
    ).toEqual(["/", "/extensions", "/settings"]);
    expect(
      APP_ROUTES.filter(
        (route) => !route.hidden && route.navigationPlacement !== "footer",
      ).map((route) => route.path),
    ).toEqual(["/", "/extensions"]);
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
  it("按命令类型、侧栏声明和可选授权过滤扩展入口", () => {
    const item: ExtensionInfo = {
      generation: 1,
      origin: { kind: "local" },
      enabled: true,
      grantedPermissions: [],
      package: {
        bytes: 100,
        sha256: "a".repeat(64),
        manifest: {
          formatVersion: 3,
          apiVersion: 2,
          minHostVersion: "0.1.0",
          id: "example.mixed",
          icon: "notebook",
          name: "Mixed",
          author: "Example",
          version: "1.0.0",
          description: "Mixed command types",
          permissions: [],
          optionalPermissions: ["network:https"],
          network: [{ origin: "https://example.com", methods: ["GET"] }],
          commands: [
            {
              id: "offline",
              title: "Offline",
              function: "app",
              inputFormat: "json",
              resultFormat: "view",
              permissions: [],
              ui: { sidebar: true, window: true },
            },
            {
              id: "online",
              title: "Online",
              function: "online",
              inputFormat: "json",
              resultFormat: "view",
              permissions: ["network:https"],
              ui: { sidebar: true, window: false },
            },
            {
              id: "tool",
              title: "Tool",
              function: "tool",
              inputFormat: "text",
              resultFormat: "text",
              permissions: [],
            },
            {
              id: "hidden",
              title: "Hidden",
              function: "hidden",
              inputFormat: "json",
              resultFormat: "view",
              permissions: [],
            },
          ],
        },
      },
    };
    expect(extensionNavigation([item]).map((entry) => entry.path)).toEqual([
      "/extensions/app/example.mixed/offline",
    ]);
    expect(extensionNavigation([item])[0]?.icon).toBe(NotebookPenIcon);
    expect(
      extensionNavigation([item], "/extensions/app/example.mixed/hidden").map(
        (entry) => entry.path,
      ),
    ).toEqual([
      "/extensions/app/example.mixed/offline",
      "/extensions/app/example.mixed/hidden",
    ]);
    expect(
      extensionNavigation([item], "/extensions/app/example.mixed/online").map(
        (entry) => entry.path,
      ),
    ).toEqual(["/extensions/app/example.mixed/offline"]);
    expect(
      extensionNavigation([item], "/extensions/app/example.mixed/tool").map(
        (entry) => entry.path,
      ),
    ).toEqual(["/extensions/app/example.mixed/offline"]);
    expect(
      extensionNavigation([
        { ...item, grantedPermissions: ["network:https"] },
      ]).map((entry) => entry.path),
    ).toEqual([
      "/extensions/app/example.mixed/offline",
      "/extensions/app/example.mixed/online",
    ]);
    expect(extensionNavigation([{ ...item, enabled: false }])).toEqual([]);
    expect(
      extensionNavigation(
        [{ ...item, enabled: false }],
        "/extensions/app/example.mixed/hidden",
      ),
    ).toEqual([]);
  });
});
