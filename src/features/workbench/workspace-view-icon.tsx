import { useState } from "react";
import {
  Activity,
  ChevronDown,
  Cpu,
  Plug,
  Radio,
  Terminal,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const ICONS = [
  { value: "terminal", icon: Terminal },
  { value: "plug", icon: Plug },
  { value: "cpu", icon: Cpu },
  { value: "radio", icon: Radio },
  { value: "activity", icon: Activity },
  { value: "wrench", icon: Wrench },
] as const;

export type WorkspaceViewIconLabels = Record<
  (typeof ICONS)[number]["value"],
  string
>;

export function WorkspaceViewIcon({ value }: { value: string }) {
  const preset = ICONS.find((item) => item.value === value);
  if (preset)
    return <preset.icon aria-hidden="true" className="size-4 shrink-0" />;
  return value ? (
    <span aria-hidden="true" className="min-w-0 truncate">
      {value}
    </span>
  ) : null;
}

export function WorkspaceViewIconPicker({
  value,
  onValueChange,
  disabled,
  label,
  defaultLabel,
  customLabel,
  customPlaceholder,
  optionLabels,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
  label: string;
  defaultLabel: string;
  customLabel: string;
  customPlaceholder: string;
  optionLabels?: WorkspaceViewIconLabels;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const selected = ICONS.find((item) => item.value === value);
  const name = selected
    ? (optionLabels?.[selected.value] ??
      (selected.value === "terminal" ? defaultLabel : selected.value))
    : value
      ? customLabel
      : defaultLabel;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setCustom(selected ? "" : value);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          className="workbench-workspace-icon-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceViewIcon value={value || "terminal"} />
            <span className="truncate">{name}</span>
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="workbench-workspace-icon-picker"
      >
        <div
          role="group"
          aria-label={label}
          className="workbench-workspace-icon-options"
        >
          {ICONS.map((item) => (
            <Button
              key={item.value}
              type="button"
              variant="outline"
              disabled={disabled}
              aria-pressed={value === item.value}
              onClick={() => {
                onValueChange(item.value);
                setOpen(false);
              }}
            >
              <item.icon aria-hidden="true" className="size-4" />
              {optionLabels?.[item.value] ??
                (item.value === "terminal" ? defaultLabel : item.value)}
            </Button>
          ))}
        </div>
        <label className="grid min-w-0 gap-1.5 text-sm">
          {customLabel}
          <Input
            value={custom}
            placeholder={customPlaceholder}
            disabled={disabled}
            onChange={(event) => {
              setCustom(event.target.value);
              onValueChange(event.target.value || "terminal");
            }}
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}
