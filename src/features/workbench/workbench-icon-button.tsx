import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** 工具栏保持图标尺寸稳定，说明在悬停后展示，键盘名称始终可用。 */
export function WorkbenchIconButton({
  label,
  tooltip = label,
  children,
  variant = "ghost",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "aria-label" | "size"> & {
  label: string;
  tooltip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={750} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...props}
            type="button"
            size="icon-sm"
            variant={variant}
            className={cn("workbench-icon-button", className)}
            aria-label={label}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent
          className="workbench-icon-tooltip"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
