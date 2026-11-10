import type {
  DeviceDescriptor,
  SessionSnapshot,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Plug,
  Unplug,
  Settings2,
  MoreHorizontal,
  Terminal,
  Save,
  Usb,
  FileUp,
  Clapperboard,
  Stethoscope,
  ListTodo,
  Gauge,
  RotateCw,
  ScrollText,
} from "lucide-react";
import { WorkbenchIconButton } from "./workbench-icon-button";
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
  recovery,
  labels,
  toolLabels,
  workspaceName,
  devices,
  deviceId,
  device,
  session,
  hasSessionView = false,
  viewTabs,
  configuration,
  opening,
  readOnly = false,
  disabled,
  devicesStale,
  canClose,
  canRestoreAccess,
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
  onUnavailableFocus,
  onTakeover,
  onReplay,
}: {
  recovery?: WorkspaceLayoutProps["connectionRecovery"];
  labels: WorkbenchLabels;
  toolLabels: WorkspaceLayoutProps["toolLabels"];
  workspaceName: string;
  devices: readonly DeviceDescriptor[];
  deviceId: string;
  device?: DeviceDescriptor;
  session?: SessionSnapshot;
  hasSessionView?: boolean;
  viewTabs?: ReactNode;
  configuration: SerialConfiguration;
  opening: string | null;
  readOnly?: boolean;
  disabled: boolean;
  devicesStale: boolean;
  canClose: boolean;
  canRestoreAccess: boolean;
  canSave: boolean;
  canTakeover: boolean;
  canReplay: boolean;
  toolsAvailable: boolean;
  onDeviceChange: (id: string) => void;
  onTool: (
    tool: WorkbenchTool | "tasks" | "metrics" | "logs",
    returnPoint?: HTMLElement | null,
  ) => void;
  onOpen: () => void;
  onClose: () => void;
  onSave: () => void;
  onUnavailableFocus?: () => void;
  onRefresh: () => void;
  onTakeover: () => void;
  onReplay: () => void;
}) {
  const [deviceListOpen, setDeviceListOpen] = useState(false);
  const header = useRef<HTMLElement | null>(null);
  const primaryTools = useRef<HTMLDivElement | null>(null);
  const [commonOverflow, setCommonOverflow] = useState(true);
  useEffect(() => {
    const element = header.current;
    if (!element) return;
    const measure = () =>
      setCommonOverflow(
        element.getBoundingClientRect().width === 0 ||
          !primaryTools.current ||
          getComputedStyle(primaryTools.current).display === "none",
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (disabled) setDeviceListOpen(false);
  }, [disabled]);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const parity = { none: "N", even: "E", odd: "O", mark: "M", space: "S" }[
    configuration.parity
  ];
  const stopBits = { one: "1", onePointFive: "1.5", two: "2" }[
    configuration.stopBits
  ];
  const parameterSummary = `${configuration.baudRate} / ${configuration.dataBits}${parity}${stopBits}`;
  const parameterPurpose = toolLabels?.parameters ?? labels.status;
  return (
    <header
      ref={header}
      className="workbench-connection"
      data-surface="transparent"
    >
      <WorkbenchIconButton
        label={toolLabels?.workspace ?? labels.title}
        tooltip={
          workspaceName
            ? `${toolLabels?.workspace ?? labels.title}: ${workspaceName}`
            : (toolLabels?.workspace ?? labels.title)
        }
        className="workbench-workspace-name"
        disabled={!toolsAvailable}
        onClick={(event) => onTool("workspace", event.currentTarget)}
      >
        <Terminal aria-hidden="true" />
      </WorkbenchIconButton>
      <Select
        open={deviceListOpen && !disabled}
        value={deviceId}
        onValueChange={onDeviceChange}
        onOpenChange={(open) => {
          setDeviceListOpen(open);
          if (open) onRefresh();
        }}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className="workbench-device-select"
          aria-label={toolLabels?.chooseDevice ?? labels.devices}
        >
          <Plug aria-hidden="true" />
          <SelectValue placeholder={labels.noDevices} />
        </SelectTrigger>
        <SelectContent
          position="popper"
          onCloseAutoFocus={(event) => {
            if (disabled && onUnavailableFocus) {
              event.preventDefault();
              onUnavailableFocus();
            }
          }}
        >
          {devices.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {labels.noDevices}
            </p>
          )}
          {devices.map((value) => (
            <SelectItem key={value.deviceId} value={value.deviceId}>
              {value.systemName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <WorkbenchIconButton
        disabled={!toolsAvailable || readOnly}
        label={parameterPurpose}
        tooltip={`${parameterPurpose}: ${parameterSummary}`}
        onClick={(event) => onTool("parameters", event.currentTarget)}
      >
        <Settings2 aria-hidden="true" />
      </WorkbenchIconButton>
      {recovery ? (
        <WorkbenchIconButton
          variant="outline"
          label={recovery.label}
          disabled={recovery.busy}
          aria-busy={recovery.busy}
          onClick={recovery.onRetry}
        >
          <RotateCw aria-hidden="true" />
        </WorkbenchIconButton>
      ) : session?.state === "open" &&
        session.deviceId === deviceId &&
        hasSessionView ? (
        <WorkbenchIconButton
          label={labels.closeSession}
          variant="default"
          aria-pressed="true"
          disabled={!canClose || opening !== null}
          onClick={onClose}
        >
          <Unplug aria-hidden="true" />
        </WorkbenchIconButton>
      ) : (
        <WorkbenchIconButton
          variant={session?.state === "open" ? "default" : "outline"}
          aria-pressed={session?.state === "open" ? true : undefined}
          disabled={opening !== null || disabled || !device || devicesStale}
          label={labels.open + " " + (device?.systemName ?? "")}
          tooltip={opening ? labels.opening : labels.open}
          onClick={onOpen}
        >
          <Plug aria-hidden="true" />
        </WorkbenchIconButton>
      )}
      <WorkbenchIconButton
        disabled={!canSave}
        label={toolLabels?.saveCurrentLayout ?? labels.saveDrafts}
        onClick={onSave}
      >
        <Save aria-hidden="true" />
      </WorkbenchIconButton>
      <div ref={primaryTools} className="workbench-primary-tools">
        {(
          [
            ["devices", Usb],
            ["transfer", FileUp],
            ["captureTools", Clapperboard],
            ["diagnostics", Stethoscope],
          ] as const
        ).map(([tool, Icon]) => (
          <WorkbenchIconButton
            key={tool}
            label={toolLabels?.[tool] ?? labels.title}
            disabled={!toolsAvailable}
            onClick={(event) => onTool(tool, event.currentTarget)}
          >
            <Icon aria-hidden="true" />
          </WorkbenchIconButton>
        ))}
        <WorkbenchIconButton
          label={labels.tasks}
          onClick={(event) => onTool("tasks", event.currentTarget)}
        >
          <ListTodo aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={labels.metrics}
          onClick={(event) => onTool("metrics", event.currentTarget)}
        >
          <Gauge aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={labels.logs}
          onClick={(event) => onTool("logs", event.currentTarget)}
        >
          <ScrollText aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
      <div className="workbench-view-tabs">{viewTabs}</div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <WorkbenchIconButton
            ref={menuTrigger}
            label={toolLabels?.more ?? labels.expand}
          >
            <MoreHorizontal aria-hidden="true" />
          </WorkbenchIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="workbench-workspace-menu">
          {canRestoreAccess && (
            <DropdownMenuItem
              disabled={disabled || opening !== null || devicesStale}
              onSelect={onOpen}
            >
              {opening === deviceId
                ? labels.restoringAccess
                : labels.restoreAccess}
            </DropdownMenuItem>
          )}
          {commonOverflow &&
            toolsAvailable &&
            (
              ["devices", "transfer", "captureTools", "diagnostics"] as const
            ).map((tool) => (
              <DropdownMenuItem
                key={tool}
                onSelect={() => onTool(tool, menuTrigger.current)}
              >
                {toolLabels?.[tool] ?? tool}
              </DropdownMenuItem>
            ))}
          {commonOverflow && (
            <>
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
              <DropdownMenuItem
                onSelect={() => onTool("logs", menuTrigger.current)}
              >
                {labels.logs}
              </DropdownMenuItem>
            </>
          )}
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
