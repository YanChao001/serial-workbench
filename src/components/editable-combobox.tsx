import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import { fieldsetDisabled, useFieldsetDisabled } from "./use-fieldset-disabled";
import "@/styles/business-dropdowns.css";

type EditableComboboxProps = Pick<
  ComponentProps<typeof Input>,
  "id" | "disabled" | "aria-invalid" | "aria-describedby" | "inputMode"
> & {
  value: string;
  onValueChange(value: string): void;
  options: readonly string[];
  label: string;
  optionsLabel: string;
};

/** 自由输入和完整预设列表共存；打开列表不按当前输入隐式筛选。 */
export function EditableCombobox({
  value,
  onValueChange,
  options,
  label,
  optionsLabel,
  disabled = false,
  ...props
}: EditableComboboxProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const restoreFocus = useRef(true);
  const inheritedDisabled = useFieldsetDisabled(input);
  const blocked = disabled || inheritedDisabled;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const visible = open && !blocked;
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked]);
  const optionId = (index: number) => `${listId}-${index}`;
  function unavailable() {
    return disabled || fieldsetDisabled(input.current);
  }
  function reveal() {
    if (unavailable()) return;
    const selected = options.indexOf(value);
    setActive(selected < 0 ? 0 : selected);
    restoreFocus.current = true;
    setOpen(true);
  }
  function choose(index: number) {
    const next = options[index];
    if (unavailable() || next === undefined) return;
    onValueChange(next);
    restoreFocus.current = true;
    setOpen(false);
  }
  useEffect(() => {
    if (visible)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [visible, listId, active]);
  return (
    <Popover
      open={visible}
      onOpenChange={(next) => {
        if (next) reveal();
        else setOpen(false);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchor} className="editable-combobox">
          <Input
            {...props}
            ref={input}
            role="combobox"
            aria-label={label}
            aria-expanded={visible}
            aria-controls={visible ? listId : undefined}
            aria-haspopup="listbox"
            aria-autocomplete="none"
            aria-activedescendant={
              visible && options[active] !== undefined
                ? optionId(active)
                : undefined
            }
            disabled={blocked}
            autoComplete="off"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                unavailable()
              )
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!visible) reveal();
                else
                  setActive((index) =>
                    Math.max(
                      0,
                      Math.min(
                        options.length - 1,
                        index + (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    ),
                  );
              } else if (event.key === "Enter" && visible) {
                event.preventDefault();
                choose(active);
              } else if (event.key === "Escape" && visible) {
                event.preventDefault();
                restoreFocus.current = true;
                setOpen(false);
              } else if (event.key === "Tab") {
                restoreFocus.current = false;
                setOpen(false);
              }
            }}
          />
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="editable-combobox-toggle"
              tabIndex={-1}
              disabled={blocked}
              aria-label={optionsLabel}
              aria-haspopup="listbox"
              aria-expanded={visible}
              aria-controls={visible ? listId : undefined}
            >
              <ChevronDown aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        id={listId}
        role="listbox"
        aria-label={optionsLabel}
        align="start"
        className="editable-combobox-options"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus.current && !unavailable())
            input.current?.focus({ preventScroll: true });
        }}
        onInteractOutside={(event) => {
          if (
            event.target instanceof Node &&
            anchor.current?.contains(event.target)
          )
            event.preventDefault();
          else restoreFocus.current = false;
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (composing.current || event.isComposing || event.keyCode === 229)
            return;
          restoreFocus.current = true;
          setOpen(false);
        }}
      >
        {options.map((option, index) => (
          <div
            id={optionId(index)}
            key={option}
            role="option"
            aria-selected={option === value}
            data-highlighted={active === index ? "" : undefined}
            className="editable-combobox-option"
            tabIndex={-1}
            onPointerMove={() => setActive(index)}
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onClick={() => choose(index)}
          >
            <span>{option}</span>
            {option === value ? <Check aria-hidden="true" /> : null}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
