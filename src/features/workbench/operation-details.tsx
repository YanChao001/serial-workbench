import type { ReactNode } from "react";
import type { Operation, OperationSummary } from "@serial-workbench/contracts";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { WorkbenchIconButton } from "./workbench-icon-button";

export function OperationDetails({
  operation,
  label,
  children,
}: {
  operation: Operation | OperationSummary;
  label: string;
  children?: ReactNode;
}) {
  // 正文和请求参数只可通过独立的授权读取入口获取，不随摘要写入详情。
  const details = JSON.stringify(
    {
      operationId: operation.operationId,
      actorId: operation.actorId,
      actionId: operation.actionId,
      target: operation.target,
      state: operation.state,
      progress: operation.progress,
      acceptedAt: operation.acceptedAt,
      startedAt: operation.startedAt,
      settledAt: operation.settledAt,
      errorCode:
        "error" in operation
          ? operation.error?.code
          : "errorCode" in operation
            ? operation.errorCode
            : undefined,
    },
    null,
    2,
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkbenchIconButton label={label}>
          <Info aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="workbench-detail-popover">
        <Textarea
          aria-label={label}
          value={details}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          className="workbench-log-details"
        />
        {children}
      </PopoverContent>
    </Popover>
  );
}
