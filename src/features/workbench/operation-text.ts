import type { OperationState, Progress } from "@serial-workbench/contracts";
import type { Translate } from "../../i18n/translate";
import { formatByteSize } from "./metric-format";

export type TransferProgressLabels = Record<
  | "bar"
  | "requestedBytes"
  | "readBytes"
  | "acceptedBytes"
  | "unknownBytes"
  | "peerConfirmed"
  | "peerUnconfirmed"
  | "rate"
  | "eta",
  string
>;

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
  transfer: TransferProgressLabels;
  failure: (code: string | undefined) => string;
};
export function operationText(
  t: Translate,
  failure: OperationText["failure"],
): OperationText {
  return {
    actions: {
      "device.open": t("workbench.operation.connect"),
      "session.get": t("workbench.operation.sessionQuery"),
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
      "transfer.paste": t("workbench.ansiPaste"),
      "capture.start": t("workbench.tools.startCapture"),
      "capture.stop": t("workbench.stopCapture"),
      "capture.verify": t("workbench.tools.verify"),
      "capture.recover": t("workbench.tools.recoverPrefix"),
      "capture.export": t("workbench.tools.exportText"),
      "replay.open": t("workbench.openReplay"),
      "replay.peer.open": t("workbench.replayPeer.open"),
      "replay.peer.submit": t("workbench.replayPeer.submit"),
      "replay.peer.close": t("workbench.closeSession"),
      "replay.transmit": t("workbench.replayTransmit.title"),
      "swb.builtin.automation.loopback": t("loopback.title"),
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
    transfer: {
      bar: t("workbench.transferProgress.bar"),
      rate: t("workbench.transferProgress.rate"),
      eta: t("workbench.transferProgress.eta"),
      requestedBytes: t("workbench.requestedBytes"),
      readBytes: t("workbench.transferProgress.readBytes"),
      acceptedBytes: t("workbench.acceptedBytes"),
      unknownBytes: t("workbench.unknownBytes"),
      peerConfirmed: t("workbench.peerConfirmed"),
      peerUnconfirmed: t("workbench.peerUnconfirmed"),
    },
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
export function isTransfer(actionId: string) {
  return actionId === "transfer.file" || actionId === "transfer.paste";
}

export function isBusinessTask(actionId: string): boolean {
  return (
    isTransfer(actionId) ||
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
