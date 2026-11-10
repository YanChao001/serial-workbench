// 让 expect 支持 toBeInTheDocument 等 DOM 断言
import "@testing-library/jest-dom/vitest";

// jsdom 不实现滚动；让弹层的键盘聚焦路径仍能运行。
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= () => {};
  // jsdom 缺少指针捕获状态；只补状态接口，不模拟真实指针重定向或拖拽布局。
  const capturedPointers = new WeakMap<Element, Set<number>>();
  Element.prototype.hasPointerCapture ??= function (
    this: Element,
    pointerId: number,
  ) {
    return capturedPointers.get(this)?.has(pointerId) ?? false;
  };
  Element.prototype.setPointerCapture ??= function (
    this: Element,
    pointerId: number,
  ) {
    const captured = capturedPointers.get(this) ?? new Set<number>();
    captured.add(pointerId);
    capturedPointers.set(this, captured);
  };
  Element.prototype.releasePointerCapture ??= function (
    this: Element,
    pointerId: number,
  ) {
    capturedPointers.get(this)?.delete(pointerId);
  };
  // Radix 的表单控件测量隐藏输入，jsdom 没有布局观察器。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom 没有媒体查询；具体断点与变更场景由测试自行替换。
  globalThis.matchMedia ??= (media) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}
