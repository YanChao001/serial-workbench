import type { Operation } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";

export async function requestOperationCancel(
  host: Pick<HostContextValue, "checkAction" | "invoke" | "waitForOperation">,
  operation: Operation,
  signal?: AbortSignal,
) {
  const input = {
    actionId: "operation.cancel",
    target: {
      hostId: operation.executionHostId,
      kind: "operation",
      id: operation.operationId,
    },
    params: { reason: "user" },
  };
  const check = await host.checkAction(input, signal);
  signal?.throwIfAborted();
  if (!check.allowed) throw { code: "PERMISSION_DENIED" };
  const accepted = await host.invoke(
    { ...input, executionMode: "independent" },
    signal,
  );
  const receipt = await host.waitForOperation(accepted, signal);
  signal?.throwIfAborted();
  if (
    receipt.actionId !== input.actionId ||
    receipt.executionHostId !== operation.executionHostId ||
    receipt.target.hostId !== input.target.hostId ||
    receipt.target.kind !== input.target.kind ||
    receipt.target.id !== operation.operationId
  )
    throw { code: "CONTRACT_MISMATCH" };
  if (receipt.state !== "succeeded")
    throw { code: receipt.error?.code ?? "OPERATION_FAILED" };
  if (
    receipt.result?.kind !== "cancellation_requested" ||
    receipt.result.value.operationId !== operation.operationId
  )
    throw { code: "CONTRACT_MISMATCH" };
}
