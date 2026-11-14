import { DEFAULT_CUSTOM_ACCENT } from "@/lib/accent-colors";
import { useEffect, useId, useRef } from "react";
import type {
  DeviceDescriptor,
  ObjectRef,
  SessionSnapshot,
  WorkspaceView,
} from "@serial-workbench/contracts";
import { PinIcon, Plus, X } from "lucide-react";
import { WorkspaceViewIcon } from "./workspace-view-icon";
import { Button } from "@/components/ui/button";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { WorkbenchLabels } from "./labels";
import { distinctWorkspaceLabels } from "./workspace-model";
export type SessionTab = {
  id: string;
  sessionId?: string;
  /** Last confirmed view source, retained for reconnect/layout only, never access. */
  source?: { device: DeviceDescriptor; session: SessionSnapshot };
  view?: WorkspaceView;
  captureRef?: ObjectRef;
};
export function SessionTabs({
  tabs,
  selected,
  canDuplicate,
  labels,
  name,
  onSelect,
  onDuplicate,
  onClose,
  onEmptyFocus,
}: {
  tabs: readonly SessionTab[];
  selected?: string;
  canDuplicate?: boolean;
  labels: WorkbenchLabels;
  name: (tab: SessionTab) => string;
  onSelect: (id: string) => void;
  onDuplicate: () => void;
  onClose?: (id: string) => void;
  onEmptyFocus?: () => void;
}) {
  const id = useId();
  const names = new Map(
    distinctWorkspaceLabels(
      tabs.map((tab) => ({ value: tab.id, label: name(tab) })),
    ).map((item) => [item.value, item.label]),
  );
  const pendingFocus = useRef<string | null>(null);
  const tablist = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const index = tabs.findIndex((tab) => tab.id === pendingFocus.current);
    pendingFocus.current = null;
    if (index >= 0) document.getElementById(id + "-" + index)?.focus();
    else if (tablist.current) tablist.current.focus();
    else onEmptyFocus?.();
  }, [tabs, id, onEmptyFocus]);
  function close(tabId: string) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    pendingFocus.current =
      remaining[Math.min(index, remaining.length - 1)]?.id ?? "";
    onClose?.(tabId);
  }
  if (!tabs.length) return null;
  return (
    <div className="workbench-toolbar workbench-tabs">
      <div
        ref={tablist}
        tabIndex={-1}
        role="tablist"
        aria-label={labels.sessions}
        className="workbench-tablist"
      >
        {tabs.map((tab, index) => (
          <Button
            variant={tab.id === selected ? "secondary" : "outline"}
            size="sm"
            key={tab.id}
            role="tab"
            aria-selected={tab.id === selected}
            tabIndex={tab.id === selected ? 0 : -1}
            id={`${id}-${index}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Delete" && onClose) {
                event.preventDefault();
                close(tab.id);
                return;
              }
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              onSelect(tabs[next]!.id);
              document.getElementById(`${id}-${next}`)?.focus();
            }}
          >
            {tab.view && (
              <span
                aria-hidden="true"
                className="workbench-view-color"
                style={{
                  backgroundColor:
                    tab.view.color.toUpperCase() === DEFAULT_CUSTOM_ACCENT
                      ? "var(--primary)"
                      : tab.view.color,
                }}
              />
            )}
            {tab.view?.icon ? (
              <WorkspaceViewIcon value={tab.view.icon} />
            ) : null}
            {tab.view?.pinned && (
              <>
                <PinIcon aria-hidden="true" />
                <span className="sr-only">{labels.pinned} </span>
              </>
            )}
            {names.get(tab.id)}
          </Button>
        ))}
      </div>
      <WorkbenchIconButton
        label={labels.duplicateView}
        disabled={!selected || canDuplicate === false}
        onClick={onDuplicate}
      >
        <Plus aria-hidden="true" />
      </WorkbenchIconButton>
      <WorkbenchIconButton
        label={labels.closeView}
        disabled={!selected || !onClose}
        onClick={() => selected && close(selected)}
      >
        <X aria-hidden="true" />
      </WorkbenchIconButton>
    </div>
  );
}
