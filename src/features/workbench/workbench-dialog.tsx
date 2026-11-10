import type { ComponentProps } from "react";
import type { Target, Operation } from "@serial-workbench/contracts";
import type { HostContextValue, HostState } from "@/providers/host-context";
import type { WorkbenchLabels } from "./labels";
import { CapturePanel } from "./capture-panel";
import { OperationPanel } from "./operation-panel";
import { MetricsPanel, type MetricsReader } from "./metrics-panel";
import type { ReceiptReader } from "./transfer-receipts";

import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UnsavedWorkScope, useRequestLeave } from "@/providers/unsaved-work";

function focusToolContent(content: HTMLElement) {
  const candidates = content.querySelectorAll<HTMLElement>(
    ".workbench-dialog-body :is(button, input, select, textarea, a[href], [tabindex], [contenteditable])",
  );
  for (const candidate of candidates) {
    if (
      candidate.tabIndex < 0 ||
      candidate.matches(
        ":disabled, input[type=hidden], .workbench-icon-button",
      ) ||
      candidate.closest("[hidden], [inert]") ||
      getComputedStyle(candidate).visibility !== "visible"
    )
      continue;
    let hidden = false;
    for (
      let ancestor: HTMLElement | null = candidate;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (getComputedStyle(ancestor).display === "none") {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) {
      if (candidate instanceof HTMLInputElement) candidate.select();
      return;
    }
  }
  // 只读工具聚焦滚动区域；辅助图标仍留给主动 Tab，避免提示先消费 Esc。
  const body = content.querySelector<HTMLElement>(".workbench-dialog-body");
  (body ?? content).focus({ preventScroll: true });
}

/** Tool dismissal uses the same registered work and negotiation as leaving the page. */
export function WorkbenchDialog({
  open,
  title,
  scopeKey,
  closeLabel,
  returnFocus,
  onRequestClose,
  children,
}: {
  open: boolean;
  title: string;
  scopeKey: string;
  closeLabel: string;
  returnFocus: RefObject<HTMLElement | null>;
  onRequestClose: () => void;
  children: ReactNode | ((requestReplace: () => Promise<boolean>) => ReactNode);
}) {
  const id = useId();
  const scope = `${id}:${scopeKey}`;
  const requestLeave = useRequestLeave();
  const content = useRef<HTMLDivElement | null>(null);
  const pending = useRef<AbortController | null>(null);
  const latest = useRef({ scope, open, onRequestClose });
  latest.current = { scope, open, onRequestClose };
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [scope, open],
  );
  async function negotiate() {
    if (pending.current) return false;
    const controller = new AbortController();
    pending.current = controller;
    try {
      const allowed = await requestLeave(scope, controller.signal);
      return (
        allowed &&
        !controller.signal.aborted &&
        latest.current.scope === scope &&
        latest.current.open
      );
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  async function close() {
    if (await negotiate()) latest.current.onRequestClose();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) void close();
      }}
    >
      <DialogContent
        ref={content}
        tabIndex={-1}
        className="workbench-dialog"
        aria-describedby={undefined}
        closeLabel={closeLabel}
        onOpenAutoFocus={(event) => {
          if (!content.current) return;
          event.preventDefault();
          focusToolContent(content.current);
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="workbench-dialog-body" tabIndex={0}>
          <UnsavedWorkScope scope={scope}>
            {typeof children === "function" ? children(negotiate) : children}
          </UnsavedWorkScope>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function WorkbenchPanels({
  kind,
  state,
  labels,
  disabled,
  capture,
  readMetrics,
  readSessionMetrics,
  metricsTarget,
  observationKey,
  readFileReceipts,
  watchActions,
  onCancelOperation,
}: {
  kind: string | null;
  state: HostState;
  labels: WorkbenchLabels;
  disabled: boolean;
  capture: Omit<
    ComponentProps<typeof CapturePanel>,
    "operations" | "summaries" | "labels" | "disabled"
  >;
  readMetrics?: MetricsReader;
  readSessionMetrics?: HostContextValue["sessionMetrics"];
  metricsTarget?: Target;
  observationKey?: string;
  readFileReceipts?: ReceiptReader;
  watchActions?: HostContextValue["watchActions"];
  onCancelOperation?: (
    operation: Operation,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}) {
  if (kind === "capture")
    return (
      <CapturePanel
        {...capture}
        operations={state.operations}
        summaries={state.operationSummaries}
        labels={labels}
        disabled={disabled}
      />
    );
  if (kind === "tasks")
    return (
      <OperationPanel
        operations={state.operations}
        labels={labels}
        readFileReceipts={readFileReceipts}
        watchActions={watchActions}
        onCancelOperation={onCancelOperation}
        disabled={disabled}
      />
    );
  if (kind === "metrics" && readMetrics && state.status === "ready")
    return (
      <MetricsPanel
        read={readMetrics}
        readSession={readSessionMetrics}
        target={metricsTarget}
        contextKey={observationKey}
        labels={labels}
      />
    );
  return null;
}
