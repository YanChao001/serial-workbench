import { useEffect, useState, type RefObject } from "react";

/** Portal 中的选项也遵守宿主表单的 fieldset 禁用状态。 */
export function fieldsetDisabled(control: HTMLElement | null): boolean {
  if (!control) return false;
  for (
    let parent = control.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (!(parent instanceof HTMLFieldSetElement) || !parent.disabled) continue;
    const legend = Array.from(parent.children).find(
      (child) => child instanceof HTMLLegendElement,
    );
    if (!legend?.contains(control)) return true;
  }
  return false;
}

export function useFieldsetDisabled(ref: RefObject<HTMLElement | null>) {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    const update = () => setDisabled(fieldsetDisabled(ref.current));
    const observer = new MutationObserver(update);
    for (
      let parent = ref.current?.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLFieldSetElement)
        observer.observe(parent, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
    }
    update();
    return () => observer.disconnect();
  }, [ref]);
  return disabled;
}
