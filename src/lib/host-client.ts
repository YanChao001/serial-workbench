import {
  ContractValidationError,
  parseReply,
} from "@serial-workbench/contracts";
import type {
  Call,
  LanRoute,
  Query,
  StateScopeRef,
  Target,
} from "@serial-workbench/contracts";
import {
  createHostClient,
  HostRequestError,
} from "@serial-workbench/host-client";
import type { HostTransport } from "@serial-workbench/host-client";
import {
  abortError,
  createNativeTransport,
  nativePort,
} from "./host-native-transport";
import { readWithAuthorizationRecovery } from "./host-read-recovery";
import { hostLocalAttachment } from "./tauri";
import type { HostNativePort } from "./host-native-transport";
export { createNativeTransport } from "./host-native-transport";
export type { HostNativePort } from "./host-native-transport";
/** 投影目标换代不等于 Host 实例失效；仍保留原错误供模块恢复或明确重试。 */
export class HostProjectionError extends Error {
  readonly code: string;
  constructor(
    readonly cause: HostRequestError,
    readonly scopeId?: string,
  ) {
    super("Host projection synchronization failed");
    this.name = "HostProjectionError";
    this.code = cause.code;
  }
}
type ProjectionProbeConnection = Pick<
  HostConnection,
  "client" | "transport" | "generation" | "buildQuery" | "hostTarget"
> & {
  attachment: Pick<
    HostConnection["attachment"],
    "hostId" | "instanceEpoch" | "actorId" | "clientId"
  >;
};
type ProjectionIdentity = ProjectionProbeConnection["attachment"] & {
  generation: string;
};
const projectionBindings = new WeakMap<
  ProjectionProbeConnection["transport"],
  { identity: ProjectionIdentity; disposed: boolean }
>();
const verifiedProjectionErrors = new WeakMap<
  HostRequestError,
  {
    identity: ProjectionIdentity;
    transport: ProjectionProbeConnection["transport"];
  }
>();
function sameProjectionIdentity(a: ProjectionIdentity, b: ProjectionIdentity) {
  return (
    a.generation === b.generation &&
    a.hostId === b.hostId &&
    a.instanceEpoch === b.instanceEpoch &&
    a.actorId === b.actorId &&
    a.clientId === b.clientId
  );
}
/** 仅复用同一错误事件已取得的原实例证明；新的错误必须独立核验。 */
export async function confirmProjectionHost(
  connection: ProjectionProbeConnection,
  error: HostProjectionError,
  signal?: AbortSignal,
): Promise<HostProjectionError> {
  const binding = projectionBindings.get(connection.transport);
  if (binding?.disposed || signal?.aborted) throw abortError();
  const identity: ProjectionIdentity = binding?.identity ?? {
    hostId: connection.attachment.hostId,
    instanceEpoch: connection.attachment.instanceEpoch,
    actorId: connection.attachment.actorId,
    clientId: connection.attachment.clientId,
    generation: connection.generation,
  };
  const sameAttachment = () =>
    sameProjectionIdentity(identity, {
      ...connection.transport.getAttachment(),
      generation: connection.generation,
    });
  if (!sameAttachment()) throw error.cause;
  const verified = verifiedProjectionErrors.get(error.cause);
  if (
    verified?.transport === connection.transport &&
    sameProjectionIdentity(verified.identity, identity)
  )
    return error;
  try {
    const probe = parseReply({
      ok: true,
      result: await connection.client.query(
        connection.buildQuery("catalog.list", connection.hostTarget, {
          pageSize: "1",
        }),
        signal,
      ),
    });
    if (binding?.disposed || signal?.aborted) throw abortError();
    if (
      !probe.ok ||
      !("kind" in probe.result) ||
      probe.result.kind !== "catalog" ||
      !sameAttachment()
    )
      throw error.cause;
  } catch (probeError) {
    if (binding?.disposed) throw abortError();
    if (
      signal?.aborted ||
      (probeError instanceof Error && probeError.name === "AbortError")
    )
      throw probeError;
    throw error.cause;
  }
  verifiedProjectionErrors.set(error.cause, {
    identity,
    transport: connection.transport,
  });
  return error;
}
export async function createHostConnection(port: HostNativePort = nativePort) {
  const desktop = await port.attachment();
  const connection = bindHostConnection(
    createNativeTransport(desktop, port),
    () => desktop.generation,
    (listener) =>
      port.onCatalogChanged?.((generation) => {
        if (generation === desktop.generation) listener();
      }) ?? Promise.resolve(() => {}),
  );
  return { ...connection, lanRoute: desktop.lanRoute };
}

export type WorkbenchHostTransport = HostTransport &
  Pick<
    ReturnType<typeof createNativeTransport>,
    "setScopes" | "openRawChannel" | "rawRequest" | "dispose"
  >;

export function bindHostConnection(
  transport: WorkbenchHostTransport,
  getGeneration: () => string,
  subscribeCatalog: (listener: () => void) => Promise<() => void>,
) {
  const attachment = transport.getAttachment();
  const originalIdentity = {
    hostId: attachment.hostId,
    instanceEpoch: attachment.instanceEpoch,
    actorId: attachment.actorId,
    clientId: attachment.clientId,
    generation: getGeneration(),
  };
  let disposed = false;
  const projectionBinding = { identity: originalIdentity, disposed: false };
  projectionBindings.set(transport, projectionBinding);
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
    options: Pick<
      Call,
      "expectedRevision" | "leaseId" | "executionMode" | "workspaceStartup"
    > = {},
  ): Call {
    return {
      ...buildQuery(actionId, target, params),
      requestContext: attachment.requestContext,
      ...options,
    };
  }
  async function refreshScopes(signal?: AbortSignal): Promise<StateScopeRef[]> {
    if (disposed || signal?.aborted) throw abortError();
    const identity = originalIdentity;
    const sameAttachment = () => {
      const current = transport.getAttachment();
      return (
        !disposed &&
        getGeneration() === identity.generation &&
        current.hostId === identity.hostId &&
        current.instanceEpoch === identity.instanceEpoch &&
        current.actorId === identity.actorId &&
        current.clientId === identity.clientId
      );
    };
    const result = await client
      .query(buildQuery("state.scopes", hostTarget), signal)
      .catch(async (error: unknown) => {
        if (disposed || signal?.aborted) throw abortError();
        if (
          !(error instanceof HostRequestError) ||
          error.code !== "EPOCH_MISMATCH" ||
          !sameAttachment()
        )
          throw error;
        const verified = await confirmProjectionHost(
          {
            client,
            transport,
            attachment: originalIdentity,
            get generation() {
              return getGeneration();
            },
            buildQuery,
            hostTarget,
          },
          new HostProjectionError(error),
          signal,
        ).catch((probeError: unknown) => {
          if (disposed) throw abortError();
          throw probeError;
        });
        if (disposed || signal?.aborted) throw abortError();
        throw verified;
      });
    if (disposed || signal?.aborted) throw abortError();
    if (!sameAttachment())
      throw new HostRequestError({
        code: "EPOCH_MISMATCH",
        message: "Host attachment changed",
        retryable: false,
      });
    if (result.kind !== "scopes") throw new ContractValidationError();
    transport.setScopes(result.value.scopes);
    return result.value.scopes;
  }
  return {
    client,
    transport,
    attachment,
    generation: originalIdentity.generation,
    hostTarget,
    buildQuery,
    buildCall,
    refreshScopes,
    onCatalogChanged(listener: () => void): Promise<() => void> {
      return subscribeCatalog(() => {
        if (!disposed && getGeneration() === originalIdentity.generation)
          listener();
      });
    },
    dispose: () => {
      disposed = true;
      projectionBinding.disposed = true;
      transport.dispose();
    },
  };
}
export type HostConnection = ReturnType<typeof bindHostConnection> & {
  browser?: {
    closed: AbortSignal;
    openViewConnection(signal: AbortSignal): Promise<HostConnection>;
  };
  lanRoute?: LanRoute;
};
// The provider owns connection lifetime; reattachment is explicit, never an RPC retry.
const localPort = { ...nativePort, attachment: hostLocalAttachment };
export function getLocalHostClient(): Promise<HostConnection> {
  return createHostConnection(localPort);
}
export function getHostClient(): Promise<HostConnection> {
  return createHostConnection();
}
