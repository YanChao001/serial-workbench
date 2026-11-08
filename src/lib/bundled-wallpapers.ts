import manifest from "../../resources/wallpapers/manifest.json";
const DIRECTORY = "../../resources/wallpapers/";

export type BundledWallpaperId = `bundled:${string}`;
export type BundledWallpaper = {
  id: BundledWallpaperId;
  name: string;
  url: string;
};

/** 清单提供协议身份；文件名只参与排序和显示。 */
export function collectBundledWallpapers(
  assets: Record<string, string>,
  identities: Readonly<Record<string, string>> = manifest,
): BundledWallpaper[] {
  const known = new Set<string>();
  if (Object.keys(assets).length !== Object.keys(identities).length)
    throw new Error("Every bundled wallpaper must have one manifest identity");
  return Object.entries(assets)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, url]) => {
      const filename = path.slice(DIRECTORY.length);
      const id = identities[filename];
      if (!id || !isBundledIdentity(id) || known.has(id))
        throw new Error(`Invalid or duplicate wallpaper identity: ${filename}`);
      known.add(id);
      const basename = filename
        .slice(filename.lastIndexOf("/") + 1)
        .replace(/\.[^.]+$/, "");
      return {
        id,
        name: basename.replace(/^\d+[-_ ]+/, "") || basename,
        url,
      };
    });
}
function isBundledIdentity(value: string): value is BundledWallpaperId {
  return /^bundled:[A-Za-z0-9._:-]+$/.test(value) && value.length <= 128;
}

export const BUNDLED_WALLPAPERS = collectBundledWallpapers(
  import.meta.glob<string>(
    "../../resources/wallpapers/**/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}",
    { eager: true, query: "?url&no-inline", import: "default" },
  ),
);

/** 存档只能选择随包提供的图片，不能引入任意 URL 或本机路径。 */
export function getBundledWallpaper(
  value: unknown,
): BundledWallpaper | undefined {
  return BUNDLED_WALLPAPERS.find((wallpaper) => wallpaper.id === value);
}
