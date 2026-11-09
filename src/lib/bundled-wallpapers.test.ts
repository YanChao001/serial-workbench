import { defaults, parseSharedSettings } from "@serial-workbench/contracts";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_WALLPAPERS,
  collectBundledWallpapers,
  getBundledWallpaper,
} from "./bundled-wallpapers";
const assets = {
  "../../resources/wallpapers/020-山间.webp": "/assets/mountain-hash.webp",
  "../../resources/wallpapers/001-秋日花饰少女.jpg": "/assets/autumn-hash.jpg",
};
const manifest = {
  "001-秋日花饰少女.jpg": "bundled:001",
  "020-山间.webp": "bundled:020",
};
describe("explicit bundled wallpaper identities", () => {
  it("keeps ASCII identities independent of Unicode names and build URLs", () => {
    expect(collectBundledWallpapers(assets, manifest)).toEqual([
      {
        id: "bundled:001",
        name: "秋日花饰少女",
        url: "/assets/autumn-hash.jpg",
      },
      { id: "bundled:020", name: "山间", url: "/assets/mountain-hash.webp" },
    ]);
  });
  it("registers every bundled file once using valid Host identities", () => {
    expect(new Set(BUNDLED_WALLPAPERS.map((w) => w.id)).size).toBe(
      BUNDLED_WALLPAPERS.length,
    );
    for (const wallpaper of BUNDLED_WALLPAPERS) {
      expect(() =>
        parseSharedSettings({
          ...defaults.settings,
          background: { kind: "bundled", id: wallpaper.id },
        }),
      ).not.toThrow();
      expect(getBundledWallpaper(wallpaper.id)).toBe(wallpaper);
    }
  });
  it.each([
    {},
    { ...manifest, "020-山间.webp": "bundled:001" },
    { ...manifest, "missing.png": "bundled:003" },
    { ...manifest, "001-秋日花饰少女.jpg": "bundled:旧身份" },
  ])("rejects incomplete, duplicate or invalid manifests", (entries) => {
    expect(() => collectBundledWallpapers(assets, entries)).toThrow();
  });
  it("resolves only explicit IDs, without legacy filename, URL or path lookup", () => {
    for (const value of [
      "bundled:001-秋日花饰少女.jpg",
      "bundled:missing",
      "../private.jpg",
      "https://example.com/image.jpg",
      "file:///private.jpg",
      null,
    ]) {
      expect(getBundledWallpaper(value)).toBeUndefined();
    }
  });
});
