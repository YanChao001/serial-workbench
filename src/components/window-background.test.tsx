import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_BACKGROUNDS } from "@/lib/backgrounds";
import type { BackgroundSelection } from "@serial-workbench/contracts";
import type { MediaPort, ResolvedMedia } from "@/lib/media";
import { PatternArtwork, WindowBackground } from "./window-background";

const sources = import.meta.glob<string>("../../resources/skins/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
});
const appearance = vi.hoisted(() => ({
  background: { kind: "preset", value: "starlight" } as BackgroundSelection,
  backgroundIntensity: 50,
  media: undefined as MediaPort | undefined,
}));
vi.mock("@/providers/settings", () => ({
  useSettings: () => ({ settings: appearance, media: appearance.media }),
}));

afterEach(cleanup);

describe("窗口插画", () => {
  it("内置壁纸从构建资源加载，使用构建资源图片", () => {
    appearance.background = { kind: "bundled", id: "bundled:001" };
    const view = render(<WindowBackground />);
    const image = view.container.querySelector("[data-bundled-wallpaper]");
    expect(image).toHaveAttribute("src", expect.stringContaining("001-"));
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(view.container.querySelector("[data-custom-background]")).toBeNull();
    expect(view.container.querySelector("video")).toBeNull();
  });
  it("预览与实际背景加载相同的独立 SVG，装饰不进入阅读和焦点顺序", () => {
    const { container } = render(
      <>
        {BUILTIN_BACKGROUNDS.map((kind) => (
          <PatternArtwork key={kind} kind={kind} preview />
        ))}
        <PatternArtwork kind="sakura" />
        <PatternArtwork kind="starlight" />
      </>,
    );
    const previews = container.querySelectorAll(
      ".pattern-artwork--preview .skin-scene",
    );
    expect(previews).toHaveLength(
      BUILTIN_BACKGROUNDS.filter((kind) => kind !== "plain").length,
    );
    expect(
      new Set(
        [...previews].map((image) => (image as HTMLElement).style.maskImage),
      ).size,
    ).toBe(previews.length);
    for (const kind of ["sakura", "starlight"]) {
      const instances = container.querySelectorAll(
        `[data-pattern="${kind}"] .skin-scene`,
      );
      expect(instances).toHaveLength(2);
      expect((instances[0] as HTMLElement).style.maskImage).toBe(
        (instances[1] as HTMLElement).style.maskImage,
      );
    }
    for (const image of container.querySelectorAll(".skin-scene")) {
      expect(image.closest("[aria-hidden]")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
    expect(
      container.querySelector('[data-pattern="plain"] .skin-scene'),
    ).toBeNull();
    expect(
      container.querySelector("svg, button, a, input, [tabindex]"),
    ).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each(Object.entries(sources))(
    "%s 是有界静态矢量，资源引用留在图片内部",
    (_path, source) => {
      const document = new DOMParser().parseFromString(source, "image/svg+xml");
      expect(document.querySelector("parsererror")).toBeNull();
      const svg = document.documentElement;
      expect(
        svg.querySelectorAll(
          "script, filter, radialGradient, image, foreignObject, animate, animateTransform, [filter]",
        ),
      ).toHaveLength(0);
      expect(svg.querySelectorAll("*").length).toBeLessThan(80);
      expect(new Blob([source]).size).toBeLessThan(16 * 1024);
      for (const reference of svg.querySelectorAll("[href]")) {
        const href = reference.getAttribute("href")!;
        expect(href).toMatch(/^#/);
        expect(svg.querySelector(href)).not.toBeNull();
      }
      expect(source).not.toMatch(
        /(?:data:|https?:\/\/)(?!www\.w3\.org\/2000\/svg)/,
      );
    },
  );

  it("renders authorized media with its fit and releases it on selection changes", async () => {
    appearance.background = {
      kind: "media",
      reference: { hostId: "host", kind: "file", id: "image" },
      fit: "contain",
    };
    const dispose = vi.fn();
    appearance.media = {
      choose: vi.fn(),
      resolve: vi.fn(async () => ({
        url: "blob:authorized",
        mime: "image/webp",
        name: "sky.webp",
        dispose,
      })),
    };
    const { container, rerender } = render(<WindowBackground />);
    await waitFor(() =>
      expect(
        container.querySelector("[data-custom-background]"),
      ).not.toBeNull(),
    );
    const image = container.querySelector("[data-custom-background]")!;
    expect(image).toHaveAttribute("src", "blob:authorized");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveStyle({ objectFit: "contain" });
    expect(screen.queryByRole("img")).toBeNull();
    appearance.background = {
      ...appearance.background,
      reference: { ...appearance.background.reference },
      fit: "cover",
    };
    rerender(<WindowBackground />);
    expect(appearance.media.resolve).toHaveBeenCalledOnce();
    expect(image).toHaveStyle({ objectFit: "cover" });
    appearance.background = { kind: "preset", value: "aurora" };
    rerender(<WindowBackground />);
    expect(container.querySelector("[data-custom-background]")).toBeNull();
    expect(container.querySelector(".pattern-artwork")).toHaveAttribute(
      "data-pattern",
      "aurora",
    );
    expect(
      (container.querySelector(".skin-scene") as HTMLElement).style.maskImage,
    ).toContain("cat-doodles.svg");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases late resources and never displays a previous reference", async () => {
    appearance.background = {
      kind: "media",
      reference: { hostId: "host", kind: "file", id: "late" },
      fit: "cover",
    };
    let finish!: (resource: ResolvedMedia) => void;
    const resolve = vi.fn<MediaPort["resolve"]>(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    appearance.media = { choose: vi.fn(), resolve };
    const view = render(<WindowBackground />);
    view.unmount();
    expect(resolve.mock.calls[0]?.[1]?.aborted).toBe(true);
    const dispose = vi.fn();
    await act(async () =>
      finish({ url: "blob:late", mime: "image/png", name: "late", dispose }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not replace a saved media reference when no service is registered", () => {
    appearance.background = {
      kind: "media",
      reference: { hostId: "host", kind: "file", id: "retained" },
      fit: "cover",
    };
    appearance.media = undefined;
    const view = render(<WindowBackground />);
    expect(view.container.querySelector("img,video")).toBeNull();
    expect(appearance.background.reference.id).toBe("retained");
  });

  it("全窗背景随设置切换，保持独立于内容的装饰层", () => {
    appearance.background = { kind: "preset", value: "starlight" };
    const { container, rerender } = render(<WindowBackground />);
    expect(container.querySelector("[data-window-background]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const before = (container.querySelector(".skin-scene") as HTMLElement).style
      .maskImage;
    appearance.background = { kind: "preset", value: "moonlit" };
    rerender(<WindowBackground />);
    expect(container.querySelector(".pattern-artwork")).toHaveAttribute(
      "data-pattern",
      "moonlit",
    );
    expect(
      (container.querySelector(".skin-scene") as HTMLElement).style.maskImage,
    ).not.toBe(before);
    expect(container.querySelector("button, a, input, [tabindex]")).toBeNull();
  });
});
