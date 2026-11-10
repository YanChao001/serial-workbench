import type { OperationState, Progress } from "@serial-workbench/contracts";
import type { Translate } from "../../i18n/translate";
import { formatByteSize } from "./metric-format";

export type OperationText = {
  actions: Record<string, string>;
  states: Record<OperationState, string>;
  otherAction: string;
  thisClient: string;
  otherClient: string;
  details: string;
  background: string;
  records: string;
  frames: string;
  failure: (code: string | undefined) => string;
};
export function operationText(
  t: Translate,
  failure: OperationText["failure"],
): OperationText {
  return {
    actions: {
      "device.open": t("workbench.operation.connect"),
      "session.close": t("workbench.closeSession"),
      "session.reconnect": t("workbench.operation.connect"),
      "session.tx": t("workbench.send"),
      "session.configure": t("workbench.tools.parameters"),
      "session.control": t("workbench.tools.controlLines"),
      "session.break": t("workbench.tools.finiteBreak"),
      "session.purge": t("workbench.tools.purge"),
      "tx.drain": t("workbench.tools.drain"),
      "tx.waitBoundary": t("workbench.tools.waitBoundary"),
      "session.takeover": t("workbench.takeover"),
      "settings.save": t("workbench.operation.saveSettings"),
      "workspace.save": t("workbench.tools.save"),
      "favorites.save": t("workbench.tools.favorites"),
      "auth.authorize": t("workbench.operation.authorize"),
      "auth.authenticate": t("workbench.operation.authorize"),
      "transfer.file": t("workbench.tools.sendFile"),
      "capture.start": t("workbench.tools.startCapture"),
      "capture.stop": t("workbench.stopCapture"),
      "capture.verify": t("workbench.tools.verify"),
      "capture.recover": t("workbench.tools.recoverPrefix"),
      "capture.export": t("workbench.tools.exportText"),
      "replay.open": t("workbench.openReplay"),
      "operation.cancel": t("workbench.cancel"),
    },
    states: {
      queued: t("workbench.operation.queued"),
      running: t("workbench.operation.running"),
      cancel_requested: t("workbench.operation.cancelRequested"),
      succeeded: t("workbench.operation.succeeded"),
      failed: t("workbench.operation.failed"),
      cancelled: t("workbench.operation.cancelled"),
      interrupted: t("workbench.operation.interrupted"),
      unknown: t("workbench.operation.unknown"),
    },
    otherAction: t("workbench.tools.operation"),
    thisClient: t("workbench.operation.thisClient"),
    otherClient: t("workbench.operation.otherClient"),
    details: t("common.details"),
    background: t("workbench.operation.background"),
    records: t("workbench.operation.records"),
    frames: t("workbench.operation.frames"),
    failure,
  };
}
export function operationName(actionId: string, text: OperationText): string {
  return Object.hasOwn(text.actions, actionId)
    ? (text.actions[actionId] ?? text.otherAction)
    : text.otherAction;
}
export function operationProgress(
  progress: Progress,
  text: OperationText,
): string {
  if (progress.unit === "bytes")
    return `${formatByteSize(progress.completed)}${progress.total === undefined ? "" : ` / ${formatByteSize(progress.total)}`}`;
  const unit =
    progress.unit === "records"
      ? text.records
      : progress.unit === "frames"
        ? text.frames
        : "";
  return `${progress.completed}${progress.total === undefined ? "" : ` / ${progress.total}`}${unit ? ` ${unit}` : ""}`;
}
export function isBusinessTask(actionId: string): boolean {
  return (
    actionId === "transfer.file" ||
    actionId.startsWith("capture.") ||
    actionId === "replay.open"
  );
}
export function isBackgroundOperation(actionId: string): boolean {
  return (
    actionId.startsWith("auth.") ||
    actionId.startsWith("lease.") ||
    actionId === "settings.save" ||
    actionId === "workspace.save"
  );
}
