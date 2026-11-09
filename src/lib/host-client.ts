import { ContractValidationError } from "@serial-workbench/contracts";
import type {
  Call,
  Query,
  StateScopeRef,
  Target,
} from "@serial-workbench/contracts";
import { createHostClient } from "@serial-workbench/host-client";
import { createNativeTransport, nativePort } from "./host-native-transport";
import { readWithAuthorizationRecovery } from "./host-read-recovery";
import type { HostNativePort } from "./host-native-transport";
export { createNativeTransport } from "./host-native-transport";
export type { HostNativePort } from "./host-native-transport";
export { createHostWorkspace } from "@/providers/host-controller";
export async function createHostConnection(port: HostNativePort = nativePort) {
  const desktop = await port.attachment();
  const transport = createNativeTransport(desktop, port);
  const rpcClient = createHostClient(transport);
  // State readers keep the SDK's separate setup budget; only ordinary queries
  // pass through this read-only recovery. Accepted invokes are never replayed.
  const client = {
    ...rpcClient,
    query(value: Query, signal?: AbortSignal) {
      let first = true;
      return readWithAuthorizationRecovery(() => {
        const request = first
          ? value
          : { ...value, requestId: crypto.randomUUID() };
        first = false;
        return rpcClient.query(request, signal);
      }, signal);
    },
  };
  const { attachment } = desktop;
  const hostTarget: Target = {
    hostId: attachment.hostId,
    kind: "host",
    id: attachment.hostId,
  };
  function buildQuery(
    actionId: string,
    target: Target,
    params: Query["params"] = {},
  ): Query {
    return {
      protocolVersion: attachment.protocolVersion,
      hostId: attachment.hostId,
      instanceEpoch: attachment.instanceEpoch,
      actorId: attachment.actorId,
      requestId: crypto.randomUUID(),
      actionId,
      target,
      params,
      revealTarget: { pageId: "workbench" },
    };
  }
  function buildCall(
    actionId: string,
    target: Target,
    params: Call["params"] = {},
    options: Pick<Call, "expectedRevision" | "leaseId" | "executionMode"> = {},
  ): Call {
    return {
      ...buildQuery(actionId, target, params),
      requestContext: attachment.requestContext,
      ...options,
    };
  }
  async function refreshScopes(signal?: AbortSignal): Promise<StateScopeRef[]> {
    const result = await client.query(
      buildQuery("state.scopes", hostTarget),
      signal,
    );
    if (result.kind !== "scopes") throw new ContractValidationError();
    transport.setScopes(result.value.scopes);
    return result.value.scopes;
  }
  const scopes = await refreshScopes();
  return {
    client,
    transport,
    attachment,
    generation: desktop.generation,
    hostTarget,
    buildQuery,
    buildCall,
    refreshScopes,
    scopes,
    dispose: transport.dispose,
  };
}
export type HostConnection = Awaited<ReturnType<typeof createHostConnection>>;
// The provider owns connection lifetime; reattachment is explicit, never an RPC retry.
export function getHostClient(): Promise<HostConnection> {
  return createHostConnection();
}
