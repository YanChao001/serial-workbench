import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { WorkbenchLabels } from "./labels";
import {
  MAX_HIGHLIGHT_PATTERN,
  MAX_HIGHLIGHT_RULES,
  type StreamHighlightRule,
} from "./stream-highlight";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: () => void;
  rules: readonly StreamHighlightRule[];
  onRulesChange: (rules: StreamHighlightRule[]) => void;
  invalid?: readonly string[];
  notice?: string;
  labels: WorkbenchLabels;
};

export function StreamHighlightEditor({
  open,
  onOpenChange,
  restoreFocus,
  rules,
  onRulesChange,
  invalid,
  notice,
  labels,
}: Props) {
  function patch(index: number, change: Partial<StreamHighlightRule>) {
    onRulesChange(
      rules.map((rule, position) =>
        position === index ? { ...rule, ...change } : rule,
      ),
    );
  }

  function move(index: number, target: number) {
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(target, 0, rule!);
    onRulesChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogTitle>{labels.highlightRules}</DialogTitle>
        <DialogDescription>{labels.highlightHelp}</DialogDescription>
        {notice && <p role="status">{notice}</p>}
        <ol className="grid gap-2">
          {rules.map((rule, index) => (
            <li key={rule.id}>
              <fieldset className="grid gap-2 rounded-md border p-2">
                <legend className="px-1">
                  {labels.highlightRule} {index + 1}
                </legend>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(enabled) => patch(index, { enabled })}
                    />
                    {labels.highlightEnabled}
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={labels.highlightUp}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={labels.highlightDown}
                      disabled={index === rules.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={labels.highlightRemove}
                      onClick={() =>
                        onRulesChange(
                          rules.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={rule.mode}
                    onValueChange={(mode) => {
                      if (mode === "keyword" || mode === "regex")
                        patch(index, { mode });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={labels.highlightMode}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keyword">
                        {labels.highlightKeyword}
                      </SelectItem>
                      <SelectItem value="regex">
                        {labels.highlightRegex}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    className="min-w-28 flex-1"
                    aria-label={labels.highlightPattern}
                    aria-invalid={invalid?.includes(rule.id) || undefined}
                    maxLength={MAX_HIGHLIGHT_PATTERN}
                    value={rule.pattern}
                    onChange={(event) =>
                      patch(index, { pattern: event.target.value })
                    }
                  />
                </div>
                {invalid?.includes(rule.id) && (
                  <p role="status">{labels.highlightInvalid}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={rule.bold}
                      onCheckedChange={(bold) => patch(index, { bold })}
                    />
                    {labels.highlightBold}
                  </label>
                  {(
                    [
                      ["foreground", labels.highlightForeground, "#b84615"],
                      ["background", labels.highlightBackground, "#ffeb99"],
                    ] as const
                  ).map(([property, label, fallback]) => (
                    <div key={property} className="flex items-center gap-1.5">
                      <label className="flex items-center gap-2">
                        <Switch
                          checked={!!rule[property]}
                          onCheckedChange={(checked) =>
                            patch(index, {
                              [property]: checked ? fallback : undefined,
                            })
                          }
                        />
                        {label}
                      </label>
                      {rule[property] && (
                        <Input
                          className="h-7 w-9 p-0.5"
                          aria-label={label}
                          type="color"
                          value={rule[property]}
                          onChange={(event) =>
                            patch(index, { [property]: event.target.value })
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          disabled={rules.length >= MAX_HIGHLIGHT_RULES}
          onClick={() =>
            onRulesChange([
              ...rules,
              {
                id: crypto.randomUUID(),
                enabled: true,
                mode: "keyword",
                pattern: "",
                bold: true,
              },
            ])
          }
        >
          {labels.highlightAdd}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
