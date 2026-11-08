import type {
  DeviceDescriptor,
  SessionSnapshot,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import { useRef } from "react";
import {
  Plug,
  Unplug,
  Settings2,
  MoreHorizontal,
  Terminal,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkbenchLabels } from "./labels";
import type { WorkbenchTool, WorkspaceLayoutProps } from "./workspace-layout";
export function WorkbenchConnection({
  labels,
  toolLabels,
  workspaceName,
  devices,
  deviceId,
  device,
  session,
  configuration,
  opening,
  readOnly = false,
  disabled,
  devicesStale,
  canClose,
  canSave,
  canTakeover,
  canReplay,
  toolsAvailable,
  onDeviceChange,
  onTool,
  onOpen,
  onClose,
  onSave,
  onRefresh,
  onTakeover,
  onReplay,
}: {
  labels: WorkbenchLabels;
  toolLabels: WorkspaceLayoutProps["toolLabels"];
  workspaceName: string;
  devices: readonly DeviceDescriptor[];
  deviceId: string;
  device?: DeviceDescriptor;
  session?: SessionSnapshot;
  configuration: SerialConfiguration;
  opening: string | null;
  readOnly?: boolean;
  disabled: boolean;
  devicesStale: boolean;
  canClose: boolean;
  canSave: boolean;
  canTakeover: boolean;
  canReplay: boolean;
  toolsAvailable: boolean;
  onDeviceChange: (id: string) => void;
  onTool: (
    tool: WorkbenchTool | "tasks" | "metrics",
    returnPoint?: HTMLElement | null,
  ) => void;
  onOpen: () => void;
  onClose: () => void;
  onSave: () => void;
  onRefresh: () => void;
  onTakeover: () => void;
  onReplay: () => void;
}) {
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const parameterSummary = `${configuration.baudRate} / ${configuration.dataBits} ${configuration.parity}`;
  const parameterPurpose = toolLabels?.parameters ?? labels.status;
  return (
    <header className="workbench-connection" data-surface="transparent">
      <Button
        size="sm"
        variant="ghost"
        className="workbench-workspace-name"
        disabled={!toolsAvailable}
        onClick={(event) => onTool("workspace", event.currentTarget)}
      >
        <Terminal aria-hidden="true" />
        <span>{workspaceName}</span>
      </Button>
      <Select
        value={deviceId}
        onValueChange={onDeviceChange}
        disabled={disabled || devices.length === 0}
      >
        <SelectTrigger
          size="sm"
          className="workbench-device-select"
          aria-label={toolLabels?.chooseDevice ?? labels.devices}
        >
          <Plug aria-hidden="true" />
          <SelectValue placeholder={labels.noDevices} />
        </SelectTrigger>
        <SelectContent position="popper">
          {devices.map((value) => (
            <SelectItem key={value.deviceId} value={value.deviceId}>
              {value.systemName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="sm"
        disabled={!toolsAvailable || readOnly}
        aria-label={
          parameterSummary
            ? `${parameterPurpose} ${parameterSummary}`
            : parameterPurpose
        }
        onClick={(event) => onTool("parameters", event.currentTarget)}
      >
        <Settings2 aria-hidden="true" />
        <span className="workbench-parameter-summary">{parameterSummary}</span>
      </Button>
      {session?.state === "open" && session.deviceId === deviceId ? (
        <Button
          size={readOnly ? "icon-sm" : "sm"}
          variant="outline"
          aria-label={readOnly ? labels.closeSession : undefined}
          title={readOnly ? labels.closeSession : undefined}
          disabled={!canClose}
          onClick={onClose}
        >
          <Unplug aria-hidden="true" />
          {!readOnly && labels.closeSession}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={opening !== null || disabled || !device || devicesStale}
          aria-label={labels.open + " " + (device?.systemName ?? "")}
          onClick={onOpen}
        >
          <Plug aria-hidden="true" />
          {opening ? labels.opening : labels.open}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!canSave}
        aria-label={toolLabels?.saveCurrentLayout ?? labels.saveDrafts}
        onClick={onSave}
      >
        <Save aria-hidden="true" />
        <span className="workbench-tool-label">
          {toolLabels?.saveCurrentLayout ?? labels.saveDrafts}
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuTrigger}
            size="icon-sm"
            variant="ghost"
            aria-label={toolLabels?.more ?? labels.expand}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={disabled} onSelect={onRefresh}>
            {labels.refresh}
          </DropdownMenuItem>
          {toolsAvailable &&
            (
              [
                "devices",
                "workspace",
                "parameters",
                "transfer",
                "captureTools",
                "diagnostics",
              ] as const
            ).map((tool) => (
              <DropdownMenuItem
                key={tool}
                disabled={readOnly && tool === "parameters"}
                onSelect={() => onTool(tool, menuTrigger.current)}
              >
                {toolLabels?.[tool] ?? tool}
              </DropdownMenuItem>
            ))}
          <DropdownMenuItem
            onSelect={() => onTool("tasks", menuTrigger.current)}
          >
            {labels.tasks}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => onTool("metrics", menuTrigger.current)}
          >
            {labels.metrics}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canTakeover} onSelect={onTakeover}>
            {labels.takeover}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canReplay} onSelect={onReplay}>
            {labels.openReplay}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
