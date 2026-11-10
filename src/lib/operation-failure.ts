export function operationFailureKey(operation: {
  executionHostId: string;
  operationId: string;
}): string {
  return JSON.stringify([
    "operation-failure",
    operation.executionHostId,
    operation.operationId,
  ]);
}

/** 仅接纳契约允许的稳定身份；未知异常不以原始长文本充当事件身份。 */
export function operationFailureEventKey(reason: unknown): string | undefined {
  const direct = failureIdentity(reason);
  if (direct) return direct;
  if (!isRecord(reason) || !isRecord(reason.details)) return;
  // Native 的 HostError 保留 OS details；HostRequestError 再包住错误信封。
  return (
    failureIdentity(reason.details.operationFailure) ??
    (isRecord(reason.details.details)
      ? failureIdentity(reason.details.details.operationFailure)
      : undefined)
  );
}

function failureIdentity(reason: unknown): string | undefined {
  if (
    !isRecord(reason) ||
    typeof reason.executionHostId !== "string" ||
    typeof reason.operationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(reason.executionHostId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(reason.operationId)
  )
    return;
  return operationFailureKey({
    executionHostId: reason.executionHostId,
    operationId: reason.operationId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
