/** 只读旧外观层，不捕获真实页面的绘制/命中，连点始终落到原控件。 */
const DURATION_MS = 1050;
const MAX_NODES = 6000;
const MAX_TEXT = 2 * 1024 * 1024;
let active: (() => void) | undefined;

function stylesheetText() {
  let text = "";
  for (const sheet of document.styleSheets) {
    const base = sheet.href ?? document.baseURI;
    for (const rule of sheet.cssRules) {
      text +=
        rule.cssText.replace(
          /url\((['"]?)([^'"()]+)\1\)/g,
          (match: string, _quote: string, value: string) => {
            if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(value)) return match;
            return `url(${JSON.stringify(new URL(value, base).href)})`;
          },
        ) + "\n";
      if (text.length > MAX_TEXT)
        throw new RangeError("Theme stylesheet budget");
    }
  }
  return (
    text +
    "\n*,*::before,*::after{animation:none!important;transition:none!important;pointer-events:none!important;user-select:none!important}"
  );
}

function snapshot() {
  const scene = document.querySelector<HTMLElement>(".app-shell");
  if (!scene) return;
  let nodes = 0;
  let textSize = 0;
  const scroll: { element: Element; top: number; left: number }[] = [];
  const copy = (source: Node): Node | null => {
    if (
      source instanceof HTMLElement &&
      (source.hidden ||
        source.style.display === "none" ||
        ["SCRIPT", "STYLE", "LINK"].includes(source.tagName))
    )
      return null;
    if (++nodes > MAX_NODES) throw new RangeError("Theme scene budget");
    if (source.nodeType === Node.TEXT_NODE)
      textSize += source.textContent?.length ?? 0;
    if (textSize > MAX_TEXT) throw new RangeError("Theme text budget");
    // 视频只保留当前帧，不在视觉层另开媒体播放或资源解析。
    if (source instanceof HTMLVideoElement) {
      const frame = document.createElement("canvas");
      frame.className = source.className;
      frame.style.cssText = source.style.cssText;
      frame.width = Math.min(source.videoWidth, innerWidth);
      frame.height = Math.min(source.videoHeight, innerHeight);
      if (source.readyState >= 2 && frame.width && frame.height)
        frame
          .getContext("2d")
          ?.drawImage(source, 0, 0, frame.width, frame.height);
      return frame;
    }
    const clone = source.cloneNode(false);
    if (
      source instanceof HTMLElement &&
      clone instanceof HTMLElement &&
      source.hasAttribute("data-theme-snapshot-block")
    ) {
      const box = source.getBoundingClientRect();
      // content-visibility 的记忆高度不会随 cloneNode 复制；固定实际尺寸，
      // 避免旧画面重新估算长列表高度后错位或出现空白。
      clone.style.height = `${box.height}px`;
      clone.style.contentVisibility = "visible";
      if (box.bottom < 0 || box.top > innerHeight) {
        return clone;
      }
    }
    for (const child of source.childNodes) {
      const copied = copy(child);
      if (copied) clone.appendChild(copied);
    }
    if (
      source instanceof HTMLInputElement &&
      clone instanceof HTMLInputElement
    ) {
      clone.value = source.value;
      clone.checked = source.checked;
    } else if (
      source instanceof HTMLTextAreaElement &&
      clone instanceof HTMLTextAreaElement
    ) {
      textSize += source.value.length;
      if (textSize > MAX_TEXT) throw new RangeError("Theme draft budget");
      clone.value = source.value;
    } else if (
      source instanceof HTMLSelectElement &&
      clone instanceof HTMLSelectElement
    )
      clone.value = source.value;
    if (
      source instanceof Element &&
      clone instanceof Element &&
      (source.scrollTop || source.scrollLeft)
    )
      scroll.push({
        element: clone,
        top: source.scrollTop,
        left: source.scrollLeft,
      });
    if (
      source instanceof HTMLCanvasElement &&
      clone instanceof HTMLCanvasElement &&
      source.width &&
      source.height
    )
      clone.getContext("2d")?.drawImage(source, 0, 0);
    return clone;
  };
  const copied = copy(scene);
  if (!copied) return;
  const host = document.createElement("div");
  host.dataset.themeReveal = "";
  host.inert = true;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;pointer-events:none;user-select:none;overflow:hidden;contain:strict";
  const shadow = host.attachShadow({ mode: "closed" });
  const styles = document.createElement("style");
  styles.textContent = stylesheetText();
  const root = document.documentElement.cloneNode(false);
  const body = document.body.cloneNode(false);
  if (!(root instanceof HTMLElement)) return;
  const appearance = getComputedStyle(document.documentElement);
  for (const property of appearance)
    if (property.startsWith("--"))
      root.style.setProperty(property, appearance.getPropertyValue(property));
  for (const property of [
    "font-size",
    "font-family",
    "line-height",
    "color-scheme",
  ])
    root.style.setProperty(property, appearance.getPropertyValue(property));
  root.style.width = "100%";
  root.style.height = "100%";
  body.appendChild(copied);
  root.appendChild(body);
  shadow.append(styles, root);
  return { host, scroll };
}

function mask(
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
) {
  return `path(evenodd, "M 0 0 H ${width} V ${height} H 0 Z M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0 Z")`;
}

/** 每次切换都从按钮向外展开；连点替换旧视觉层，主题仍即时提交。 */
export function startThemeReveal(
  commit: () => void,
  enabled: boolean,
): (() => void) | undefined {
  active?.();
  let captured: ReturnType<typeof snapshot>;
  const button = document.querySelector<HTMLElement>("[data-theme-control]");
  const box = button?.getBoundingClientRect();
  const width = innerWidth,
    height = innerHeight;
  const x = box?.width
    ? Math.max(0, Math.min(width, box.x + box.width / 2))
    : width / 2;
  const y = box?.height
    ? Math.max(0, Math.min(height, box.y + box.height / 2))
    : height / 2;
  const from = box ? Math.hypot(box.width, box.height) / 2 + 4 : 0.5;
  const to = Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 2;
  const beginning = mask(width, height, x, y, from);
  if (
    enabled &&
    typeof Element.prototype.animate === "function" &&
    CSS.supports("clip-path", beginning) &&
    !matchMedia("(forced-colors: active)").matches
  ) {
    try {
      captured = snapshot();
    } catch {
      /* 大场景或不可读取样式只降级外观，不延迟主题提交。 */
    }
  }
  if (!captured) {
    commit();
    return;
  }
  const { host, scroll } = captured;
  let animation: Animation | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (active === dispose) active = undefined;
    animation?.cancel();
    host.remove();
    window.removeEventListener("resize", dispose);
    window.removeEventListener("blur", dispose);
    document.removeEventListener("visibilitychange", hidden);
    document.removeEventListener("pointerdown", interact, true);
    document.removeEventListener("keydown", dispose, true);
    document.removeEventListener("wheel", dispose, true);
  };
  const hidden = () => {
    if (document.hidden) dispose();
  };
  const interact = (event: Event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-theme-control]")
    )
      dispose();
  };
  active = dispose;
  try {
    commit();
  } catch (error) {
    dispose();
    throw error;
  }
  if (disposed) return;
  try {
    // 先提交真实主题，再加入旧外观，避免旧画面参与主题提交的重复布局。
    // 两步在同一次同步调用内完成，浏览器下一帧才绘制。
    document.body.appendChild(host);
    host.style.clipPath = beginning;
    for (const item of scroll) {
      item.element.scrollTop = item.top;
      item.element.scrollLeft = item.left;
    }
    animation = host.animate(
      [{ clipPath: beginning }, { clipPath: mask(width, height, x, y, to) }],
      {
        duration: DURATION_MS,
        easing: "cubic-bezier(0.4,0,0.2,1)",
        fill: "forwards",
      },
    );
    void animation.finished.then(dispose, dispose);
    window.addEventListener("resize", dispose);
    window.addEventListener("blur", dispose);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("pointerdown", interact, true);
    document.addEventListener("keydown", dispose, true);
    document.addEventListener("wheel", dispose, {
      capture: true,
      passive: true,
    });
  } catch {
    // 装饰层失败不能把已经成功的主题选择改报业务错误。
    dispose();
  }
  return dispose;
}
