import type {
  DeviceDescriptor,
  SessionSnapshot,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LanWorkbenchContext } from "@/features/lan/lan-workbench-context";
import {
  Plug,
  Unplug,
  Settings2,
  MoreHorizontal,
  Network,
  Play,
  Save,
  Usb,
  FileUp,
  Clapperboard,
  Brackets,
  Stethoscope,
  ListTodo,
  ListOrdered,
  History,
  Timer,
  Gauge,
  RotateCw,
  ScrollText,
  PanelsTopLeft,
  LoaderCircle,
  X,
  Cable,
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
  unmatchedDeviceName,
  device,
  session,
  viewSessionId,
  viewTabs,
  configuration,
  opening,
  readOnly = false,
  disabled,
  devicesStale,
  canClose,
  canControl,
  canRestoreAccess,
  canSave,
  canReplay,
  toolsAvailable,
  onDeviceChange,
  onTool,
  onOpen,
  onClose,
  onSave,
  onRefresh,
  onUnavailableFocus,
  onReplay,
  onCloseOtherViews,
  onCloseAllViews,
}: {
  recovery?: WorkspaceLayoutProps["connectionRecovery"];
  labels: WorkbenchLabels;
  toolLabels: WorkspaceLayoutProps["toolLabels"];
  workspaceName: string;
  devices: readonly DeviceDescriptor[];
  deviceId: string;
  unmatchedDeviceName?: string;
  device?: DeviceDescriptor;
  session?: SessionSnapshot;
  viewSessionId?: string;
  viewTabs?: ReactNode;
  configuration: SerialConfiguration;
  opening: string | null;
  readOnly?: boolean;
  disabled: boolean;
  devicesStale: boolean;
  canClose: boolean;
  canControl: boolean;
  canRestoreAccess: boolean;
  canSave: boolean;
  canReplay: boolean;
  toolsAvailable: boolean;
  onDeviceChange: (id: string) => void;
  onTool: (
    tool: WorkbenchTool | "tasks" | "metrics" | "logs" | "sendHistory",
    returnPoint?: HTMLElement | null,
  ) => void;
  onOpen: () => void;
  onClose: () => void;
  onSave: () => void;
  onUnavailableFocus?: () => void;
  onRefresh: () => void;
  onReplay: () => void;
  onCloseOtherViews?: () => void;
  onCloseAllViews?: () => void;
}) {
  const lan = useContext(LanWorkbenchContext);
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
  const unmatchedSelection = "unmatched/device";
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
        <PanelsTopLeft aria-hidden="true" />
      </WorkbenchIconButton>
      <Select
        open={deviceListOpen && !disabled}
        value={deviceId || (unmatchedDeviceName ? unmatchedSelection : "")}
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
          data-lan={lan?.route ? "" : undefined}
          aria-label={toolLabels?.chooseDevice ?? labels.devices}
          aria-description={lan?.description}
        >
          <SelectValue
            placeholder={
              devices.length
                ? (toolLabels?.chooseDevice ?? labels.devices)
                : labels.noDevices
            }
          >
            {unmatchedDeviceName
              ? `${unmatchedDeviceName} · ${labels.bindingUnmatched}`
              : devices.find((value) => value.deviceId === deviceId)
                  ?.systemName}
          </SelectValue>
          {lan?.route && (
            <span className="text-xs text-muted-foreground">{lan.source}</span>
          )}
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
          {unmatchedDeviceName && (
            <SelectItem value={unmatchedSelection} disabled>
              {unmatchedDeviceName} · {labels.bindingUnmatched}
            </SelectItem>
          )}
          {devices.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {labels.noDevices}
            </p>
          )}
          {devices.map((value) => (
            <SelectItem
              className="workbench-port-option"
              key={value.deviceId}
              value={value.deviceId}
            >
              <span className="workbench-port-label" title={value.systemName}>
                <span>{value.systemName}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <WorkbenchIconButton
        disabled={!toolsAvailable || readOnly}
        label={parameterPurpose}
        aria-description={parameterSummary}
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
        session.sessionId === viewSessionId ? (
        <WorkbenchIconButton
          label={labels.closeSession}
          tooltip={labels.disconnect}
          variant="default"
          aria-pressed="true"
          disabled={!canClose || opening !== null}
          onClick={onClose}
        >
          <Unplug aria-hidden="true" />
        </WorkbenchIconButton>
      ) : (
        <WorkbenchIconButton
          variant="outline"
          aria-busy={opening === deviceId || undefined}
          disabled={opening !== null || disabled || !device || devicesStale}
          label={labels.open + " " + (device?.systemName ?? "")}
          tooltip={
            opening
              ? labels.opening
              : !device
                ? unmatchedDeviceName
                  ? labels.bindingUnavailable
                  : (toolLabels?.chooseDevice ?? labels.devices)
                : labels.open
          }
          onClick={onOpen}
        >
          {opening === deviceId ? (
            <LoaderCircle
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Plug aria-hidden="true" />
          )}
        </WorkbenchIconButton>
      )}
      <WorkbenchIconButton
        label={toolLabels?.controls ?? labels.receipt}
        disabled={!toolsAvailable || !canControl}
        onClick={(event) => onTool("controls", event.currentTarget)}
      >
        <Cable aria-hidden="true" />
      </WorkbenchIconButton>
      <WorkbenchIconButton
        disabled={!canSave}
        label={toolLabels?.saveCurrentLayout ?? labels.saveDrafts}
        tooltip={
          toolLabels?.saveCurrentLayoutHint ??
          toolLabels?.saveCurrentLayout ??
          labels.saveDrafts
        }
        onClick={onSave}
      >
        <Save aria-hidden="true" />
      </WorkbenchIconButton>
      <div ref={primaryTools} className="workbench-primary-tools">
        {(
          [
            ["devices", Usb],
            ["captureTools", Clapperboard],
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
          {lan && (
            <DropdownMenuItem onSelect={() => lan.open(menuTrigger.current)}>
              <Network aria-hidden="true" />
              {lan.title}
            </DropdownMenuItem>
          )}
          {canRestoreAccess && (
            <DropdownMenuItem
              disabled={disabled || opening !== null || devicesStale}
              onSelect={onOpen}
            >
              <Plug aria-hidden="true" />
              {opening === deviceId
                ? labels.restoringAccess
                : labels.restoreAccess}
            </DropdownMenuItem>
          )}
          {commonOverflow &&
            toolsAvailable &&
            (
              [
                ["devices", Usb],
                ["captureTools", Clapperboard],
              ] as const
            ).map(([tool, Icon]) => (
              <DropdownMenuItem
                key={tool}
                onSelect={() => onTool(tool, menuTrigger.current)}
              >
                <Icon aria-hidden="true" />
                {toolLabels?.[tool] ?? tool}
              </DropdownMenuItem>
            ))}
          {
            <>
              <DropdownMenuItem
                onSelect={() => onTool("diagnostics", menuTrigger.current)}
              >
                <Stethoscope aria-hidden="true" />
                {toolLabels?.diagnostics ?? labels.title}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onTool("transfer", menuTrigger.current)}
              >
                <FileUp aria-hidden="true" />
                {toolLabels?.transfer ?? labels.sendFile}
              </DropdownMenuItem>
              {toolLabels?.framing ? (
                <DropdownMenuItem
                  onSelect={() => onTool("framing", menuTrigger.current)}
                >
                  <Brackets aria-hidden="true" />
                  {toolLabels.framing}
                </DropdownMenuItem>
              ) : null}
              {toolLabels?.repeatSend && (
                <DropdownMenuItem
                  onSelect={() => onTool("repeatSend", menuTrigger.current)}
                >
                  <Timer aria-hidden="true" />
                  {toolLabels.repeatSend}
                </DropdownMenuItem>
              )}
              {toolLabels?.commandSequence && (
                <DropdownMenuItem
                  onSelect={() =>
                    onTool("commandSequence", menuTrigger.current)
                  }
                >
                  <ListOrdered aria-hidden="true" />
                  {toolLabels.commandSequence}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => onTool("sendHistory", menuTrigger.current)}
              >
                <History aria-hidden="true" />
                {labels.sendHistory}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onTool("tasks", menuTrigger.current)}
              >
                <ListTodo aria-hidden="true" />
                {labels.tasks}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onTool("metrics", menuTrigger.current)}
              >
                <Gauge aria-hidden="true" />
                {labels.metrics}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onTool("logs", menuTrigger.current)}
              >
                <ScrollText aria-hidden="true" />
                {labels.logs}
              </DropdownMenuItem>
            </>
          }
          <DropdownMenuItem disabled={!canReplay} onSelect={onReplay}>
            <Play aria-hidden="true" />
            {labels.openReplay}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onCloseOtherViews}
            onSelect={onCloseOtherViews}
          >
            <PanelsTopLeft aria-hidden="true" />
            {labels.closeOtherViews}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onCloseAllViews}
            onSelect={onCloseAllViews}
          >
            <X aria-hidden="true" />
            {labels.closeAllViews}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
