import { useEffect, useMemo, useRef } from "react";
import type { OperationSummary } from "@serial-workbench/contracts";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { nativeErrorText } from "@/lib/native-error";
import type { UserLogModule } from "@/lib/user-log";
import {
  operationName,
  operationText,
  type OperationText,
} from "./operation-text";
import {
  notifyWorkbenchFailure,
  operationFailureKey,
} from "./workbench-notice";

export function operationLogModule(actionId: string): UserLogModule {
  if (actionId.startsWith("capture.") || actionId.startsWith("replay."))
    return "capture";
  if (actionId.startsWith("transfer.")) return "transfer";
  if (
    actionId === "device.open" ||
    actionId === "session.close" ||
    actionId === "session.reconnect"
  )
    return "connection";
  if (actionId.startsWith("session.") || actionId.startsWith("tx."))
    return "serial";
  if (actionId === "device.rebind") return "workspace";
  if (actionId.startsWith("workspace.") || actionId.startsWith("favorites."))
    return "workspace";
  if (actionId.startsWith("settings.")) return "settings";
  return "application";
}

function failed(operation: OperationSummary) {
  return (
    operation.state === "failed" ||
    operation.state === "interrupted" ||
    operation.state === "unknown"
  );
}

export function OperationFailureNotices({
  ready,
  scopeKey,
  operations,
  text,
}: {
  ready: boolean;
  scopeKey?: string;
  operations: readonly OperationSummary[];
  text: OperationText;
}) {
  const observed = useRef({
    scopeKey,
    initialized: false,
    states: new Map<string, boolean>(),
  });
  useEffect(() => {
    // 元数据暂时失败/桥接重连不会结束后端 Operation；保留已知待完成身份。
    if (!ready || !scopeKey) return;
    if (observed.current.scopeKey !== scopeKey) {
      observed.current = { scopeKey, initialized: false, states: new Map() };
    }
    const current = observed.current;
    for (const operation of operations) {
      const key = operationFailureKey(operation);
      const failure = failed(operation);
      if (current.initialized && failure && current.states.get(key) !== true) {
        notifyWorkbenchFailure(key, {
          module: operationLogModule(operation.actionId),
          level: operation.state === "failed" ? "error" : "warning",
          code: operation.errorCode,
          context: operationName(operation.actionId, text),
          message: text.failure(operation.errorCode),
        });
      }
      current.states.delete(key);
      current.states.set(key, failure);
    }
    // Host 投影最多 128 项；保留有界近期身份，移出投影不代表出现了新故障。
    while (current.states.size > 512)
      current.states.delete(current.states.keys().next().value!);
    current.initialized = true;
  }, [ready, scopeKey, operations, text]);
  return null;
}

/** 常驻于路由外，只消费 Host 已授权的操作投影，不主动读取操作详情或输入。 */
export function OperationFailureObserver() {
  const host = useHost();
  const { t } = useI18n();
  const text = useMemo(
    () => operationText(t, (code) => nativeErrorText({ code }, t)),
    [t],
  );
  const attachment = host.connection?.attachment;
  // Native 桥接 generation 不是后端 Operation 的代次。
  const scopeKey = attachment
    ? JSON.stringify([attachment.hostId, attachment.instanceEpoch])
    : undefined;
  return (
    <OperationFailureNotices
      ready={host.state.status === "ready"}
      scopeKey={scopeKey}
      operations={host.state.operationSummaries}
      text={text}
    />
  );
}
