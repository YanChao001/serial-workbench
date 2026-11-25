import {
  ContractValidationError,
  validateNodePackageInstallation,
} from "@serial-workbench/contracts";
import type {
  NodePackageDetailsReadParams,
  NodePackageDetailsReadResult,
  NodePackageListParams,
  NodePackagePermissions,
  NodePackageSourceKey,
  NodePackageSummary,
  NodeSourceListParams,
  Query,
} from "@serial-workbench/contracts";
import type { HostConnection } from "@/lib/host-client";
import type { LocalNodeIntent } from "@/lib/tauri";
import type { MessageKey } from "@/i18n/zh-CN";

export type Confirmation = {
  label: MessageKey;
  description: MessageKey;
  identity: string;
  source?: string;
  permissions?: MessageKey[];
  intent: LocalNodeIntent;
};

export function permissionLabels(permissions: NodePackagePermissions) {
  const labels = new Set<MessageKey>();
  for (const scope of permissions.hostApi) {
    for (const permission of scope.permissions) {
      switch (permission) {
        case "metadata.read":
          labels.add(
            scope.targetKinds.every(
              (kind) => kind === "device" || kind === "session",
            )
              ? "plugins.readConnections"
              : "plugins.readData",
          );
          break;
        case "content.read":
          for (const kind of scope.targetKinds) {
            labels.add(
              kind === "session"
                ? "plugins.readSerial"
                : kind === "file" || kind === "capture"
                  ? "plugins.readFiles"
                  : "plugins.readData",
            );
          }
          break;
        case "device.modify":
          labels.add("plugins.controlSerial");
          break;
        case "workspace.modify":
          labels.add("plugins.changeWorkspace");
          break;
        case "settings.modify":
          labels.add("plugins.changeSettings");
          break;
        default:
          labels.add("plugins.otherPermissions");
      }
    }
  }
  if (permissions.externalTools.length) labels.add("plugins.useExternalTools");
  return [...labels];
}

const DETAIL_PAGE_SIZE = 32768;
// 原 manifest 上限 1 MiB，完整详情还可能包含一份执行权限声明。
const MAX_DETAIL_SIZE = 4 * 1024 * 1024;
type PackageIdentity = Pick<
  NodePackageDetailsReadParams,
  "id" | "archiveSha256" | "expectedRevision"
>;

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readNodeInstallation(
  identity: PackageIdentity,
  read: (
    params: NodePackageDetailsReadParams,
    signal?: AbortSignal,
  ) => Promise<NodePackageDetailsReadResult>,
  signal?: AbortSignal,
) {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let digest: string | undefined;
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const page = await read(
      { ...identity, offset: String(offset), length: String(DETAIL_PAGE_SIZE) },
      signal,
    );
    signal?.throwIfAborted();
    const total = Number(page.totalBytes);
    if (
      page.id !== identity.id ||
      page.archiveSha256 !== identity.archiveSha256 ||
      page.revision !== identity.expectedRevision ||
      page.offset !== String(offset) ||
      !Number.isSafeInteger(total) ||
      total <= 0 ||
      total > MAX_DETAIL_SIZE ||
      (bytes && (total !== bytes.length || page.jsonSha256 !== digest))
    )
      throw new ContractValidationError("Plugin details snapshot changed");

    if (page.bytesBase64.length > 4 * Math.ceil(DETAIL_PAGE_SIZE / 3))
      throw new ContractValidationError("Invalid plugin details range");
    const chunk = atob(page.bytesBase64);
    if (
      !chunk.length ||
      chunk.length > DETAIL_PAGE_SIZE ||
      offset + chunk.length > total
    )
      throw new ContractValidationError("Invalid plugin details range");

    bytes ??= new Uint8Array(total);
    digest ??= page.jsonSha256;
    for (let index = 0; index < chunk.length; index++)
      bytes[offset + index] = chunk.charCodeAt(index);
    offset += chunk.length;
  } while (offset < bytes.length);

  if ((await sha256Hex(bytes)) !== digest)
    throw new ContractValidationError("Plugin details digest mismatch");
  signal?.throwIfAborted();
  const installation: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !validateNodePackageInstallation(installation) ||
    installation.manifest.id !== identity.id ||
    installation.archiveSha256 !== identity.archiveSha256
  )
    throw new ContractValidationError("Invalid plugin installation details");
  return installation;
}

export function queryNode(
  connection: HostConnection,
  actionId: string,
  params: Query["params"],
  signal?: AbortSignal,
) {
  return connection.client.query(
    connection.buildQuery(actionId, connection.hostTarget, params),
    signal,
  );
}

export async function loadInstalledPlugins(
  connection: HostConnection,
  signal?: AbortSignal,
  filter: Pick<NodePackageListParams, "parserOnly"> = {},
) {
  const packages: NodePackageSummary[] = [];
  let input: NodePackageListParams = filter;
  const seen = new Set<string>();
  for (;;) {
    const result = await queryNode(
      connection,
      "node.packages.list",
      { ...input },
      signal,
    );
    if (result.kind !== "node_packages") throw new ContractValidationError();
    const { revision, nextAfter } = result.value;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== revision
    )
      throw new ContractValidationError();
    packages.push(...result.value.packages);
    if (nextAfter === undefined) return { revision, packages };
    if (seen.has(nextAfter)) throw new ContractValidationError();
    seen.add(nextAfter);
    input = { ...filter, after: nextAfter, expectedRevision: revision };
  }
}

export async function loadPluginSources(
  connection: HostConnection,
  signal?: AbortSignal,
) {
  const keys: NodePackageSourceKey[] = [];
  let input: NodeSourceListParams = {};
  for (;;) {
    const result = await queryNode(
      connection,
      "node.sources.list",
      { ...input },
      signal,
    );
    if (result.kind !== "node_package_sources")
      throw new ContractValidationError();
    const { revision, nextOffset } = result.value;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== revision
    )
      throw new ContractValidationError();
    keys.push(...result.value.keys);
    if (nextOffset === undefined) return { revision, keys };
    if (BigInt(nextOffset) <= BigInt(input.offset ?? "0"))
      throw new ContractValidationError();
    input = { offset: nextOffset, expectedRevision: revision };
  }
}
