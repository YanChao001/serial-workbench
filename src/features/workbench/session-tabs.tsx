import { useEffect, useId, useRef } from "react";
import type { ObjectRef, WorkspaceView } from "@serial-workbench/contracts";
import { PinIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
export type SessionTab = {
  id: string;
  sessionId?: string;
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
}: {
  tabs: readonly SessionTab[];
  selected?: string;
  canDuplicate?: boolean;
  labels: WorkbenchLabels;
  name: (tab: SessionTab) => string;
  onSelect: (id: string) => void;
  onDuplicate: () => void;
  onClose?: (id: string) => void;
}) {
  const id = useId();
  const pendingFocus = useRef<string | null>(null);
  const tablist = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const index = tabs.findIndex((tab) => tab.id === pendingFocus.current);
    pendingFocus.current = null;
    if (index >= 0) document.getElementById(id + "-" + index)?.focus();
    else tablist.current?.focus();
  }, [tabs, id]);
  function close(tabId: string) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    pendingFocus.current =
      remaining[Math.min(index, remaining.length - 1)]?.id ?? "";
    onClose?.(tabId);
  }
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
            variant={tab.id === selected ? "secondary" : "ghost"}
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
                style={{ backgroundColor: tab.view.color }}
              />
            )}
            {tab.view?.icon === "terminal" ? (
              <TerminalIcon aria-hidden="true" />
            ) : tab.view?.icon ? (
              <span aria-hidden="true">{tab.view.icon}</span>
            ) : null}
            {tab.view?.pinned && (
              <>
                <PinIcon aria-hidden="true" />
                <span className="sr-only">{labels.pinned} </span>
              </>
            )}
            {name(tab)}
            {!tab.view &&
            tab.sessionId &&
            tabs.filter((candidate) => candidate.sessionId === tab.sessionId)
              .length > 1
              ? ` (${index + 1})`
              : ""}
          </Button>
        ))}
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={!selected || canDuplicate === false}
        onClick={onDuplicate}
      >
        {labels.duplicateView}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!selected || !onClose}
        onClick={() => selected && close(selected)}
      >
        {labels.closeView}
      </Button>
    </div>
  );
}
