import { isMacOS } from "@/lib/platform";
import type { ShortcutBinding } from "@/lib/generated/bindings";

export type Shortcut = {
  key: string;
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  allowInEditable?: boolean;
};

export const SEND_EDITOR_SHORTCUT: Shortcut = {
  key: "Enter",
  primary: true,
  allowInEditable: true,
};

const FUNCTION_KEYS = new Set(
  Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
);

export function validShortcutBinding({
  key,
  primary,
  alt,
}: ShortcutBinding): boolean {
  return (
    FUNCTION_KEYS.has(key) ||
    ((primary || alt) &&
      (key === "Enter" || (key.length === 1 && /[a-z0-9,./]/.test(key))))
  );
}

export function shortcutFromEvent(
  event: KeyboardEvent,
  mac = isMacOS(),
): ShortcutBinding | undefined {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.getModifierState("AltGraph") ||
    (mac ? event.ctrlKey : event.metaKey)
  )
    return;
  const binding = {
    key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
    primary: mac ? event.metaKey : event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  return validShortcutBinding(binding) ? binding : undefined;
}

export function sameShortcut(left: Shortcut, right: Shortcut): boolean {
  return (
    left.key.toLowerCase() === right.key.toLowerCase() &&
    !!left.primary === !!right.primary &&
    !!left.alt === !!right.alt &&
    !!left.shift === !!right.shift
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    )
  );
}

/** 仅处理尚未消费且未处于输入法组合状态的应用快捷键 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: Shortcut,
  mac = isMacOS(),
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    (!shortcut.allowInEditable && isEditableTarget(event.target))
  )
    return false;
  return (
    event.key.toLowerCase() === shortcut.key.toLowerCase() &&
    (mac ? event.metaKey : event.ctrlKey) === !!shortcut.primary &&
    !(mac ? event.ctrlKey : event.metaKey) &&
    event.altKey === !!shortcut.alt &&
    event.shiftKey === !!shortcut.shift
  );
}

export function formatShortcut(shortcut: Shortcut, mac = isMacOS()): string {
  const key =
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return mac
    ? `${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${shortcut.primary ? "⌘" : ""}${key}`
    : [
        shortcut.primary && "Ctrl",
        shortcut.alt && "Alt",
        shortcut.shift && "Shift",
        key,
      ]
        .filter(Boolean)
        .join("+");
}
