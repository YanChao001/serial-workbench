import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { fieldsetDisabled, useFieldsetDisabled } from "./use-fieldset-disabled";
import "@/styles/business-dropdowns.css";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};
type OptionsSelectProps<T extends string> = Pick<
  ComponentProps<typeof SelectTrigger>,
  "id" | "disabled" | "aria-invalid" | "aria-describedby" | "className"
> & {
  value: T;
  onValueChange(value: T): void;
  options: readonly SelectOption<T>[];
  label?: string;
};

/** 枚举选项统一使用应用弹层，选值由给定选项收窄，不伪造原生 change 事件。 */
export function OptionsSelect<T extends string>({
  value,
  onValueChange,
  options,
  label,
  disabled = false,
  className,
  ...props
}: OptionsSelectProps<T>) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const inheritedDisabled = useFieldsetDisabled(trigger);
  const [open, setOpen] = useState(false);
  const blocked = disabled || inheritedDisabled;
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked]);
  return (
    <Select
      value={value}
      disabled={blocked}
      open={open && !blocked}
      onOpenChange={(next) =>
        setOpen(next && !disabled && !fieldsetDisabled(trigger.current))
      }
      onValueChange={(raw) => {
        if (disabled || fieldsetDisabled(trigger.current)) return;
        const option = options.find(
          (item) => item.value === raw && !item.disabled,
        );
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        {...props}
        ref={trigger}
        size="sm"
        aria-label={label}
        className={cn("options-select", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="options-select-content">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
