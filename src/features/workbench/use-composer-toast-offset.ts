import { useLayoutEffect, useRef } from "react";

/** 每个窗口文档仅有一个发送区；右下通知随其实际边界避让，窗口之间不共享样式。 */
export function useComposerToastOffset() {
  const composer = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    const style = document.documentElement.style;
    const property = "--workbench-toast-bottom";
    const previous = style.getPropertyValue(property);
    let current = "";
    const measure = () => {
      const inset =
        Number.parseFloat(getComputedStyle(element).paddingInlineStart) || 8;
      const next = `${Math.max(16, Math.ceil(window.innerHeight - element.getBoundingClientRect().top + inset))}px`;
      if (next !== current) {
        current = next;
        style.setProperty(property, next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      if (style.getPropertyValue(property) === current) {
        if (previous) style.setProperty(property, previous);
        else style.removeProperty(property);
      }
    };
  }, []);
  return composer;
}
