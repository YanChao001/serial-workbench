import {
  ContractValidationError,
  type NodeViewAssetReadResult,
  type Target,
} from "@serial-workbench/contracts";
import type { HostConnection } from "@/lib/host-client";
import { sha256Hex } from "./node-management";

const chunkBytes = 32 * 1024;
const maxAssetBytes = 8 * 1024 * 1024;
const maxViewAssets = 16;

function invalid() {
  return new ContractValidationError("Browser plugin view resource changed");
}

export type BrowserViewRequest = {
  operationId: string;
  viewId: string;
  packageId: string;
  archiveSha256: string;
  target: Target;
};

export async function prepareBrowserView(
  connection: HostConnection,
  request: BrowserViewRequest,
  signal: AbortSignal,
) {
  const target = {
    kind: "operation",
    hostId: request.target.hostId,
    id: request.operationId,
  };
  async function page(offset: number, path?: string) {
    const reply = await connection.client.query(
      connection.buildQuery("node.views.assetRead", target, {
        viewId: request.viewId,
        offset: String(offset),
        ...(path === undefined ? {} : { path }),
      }),
      signal,
    );
    signal.throwIfAborted();
    if (reply.kind !== "node_view_asset") throw invalid();
    const asset = reply.value;
    if (
      asset.packageId !== request.packageId ||
      asset.archiveSha256 !== request.archiveSha256 ||
      asset.view.id !== request.viewId ||
      asset.view.feed === "derived" ||
      asset.target.kind !== "session" ||
      asset.target.hostId !== request.target.hostId ||
      asset.target.id !== request.target.id ||
      asset.target.sessionId !== request.target.sessionId ||
      asset.target.sessionEpoch !== request.target.sessionEpoch ||
      asset.path !== (path ?? asset.entry) ||
      asset.offset !== String(offset)
    )
      throw invalid();
    return asset;
  }

  const entry = await page(0);
  function sameActivation(asset: NodeViewAssetReadResult) {
    if (
      asset.activationId !== entry.activationId ||
      asset.version !== entry.version ||
      asset.entry !== entry.entry ||
      asset.view.actionId !== entry.view.actionId
    )
      throw invalid();
  }
  async function authorize() {
    const current = await page(Number(entry.totalBytes), entry.entry);
    sameActivation(current);
    if (
      current.totalBytes !== entry.totalBytes ||
      current.sha256 !== entry.sha256 ||
      current.bytesBase64 !== ""
    )
      throw invalid();
  }

  let remaining = maxAssetBytes;
  async function bytes(first: NodeViewAssetReadResult) {
    const total = Number(first.totalBytes);
    if (!Number.isSafeInteger(total) || total <= 0 || total > remaining)
      throw invalid();
    remaining -= total;
    const file = new Uint8Array(total);
    let asset = first;
    for (let offset = 0; offset < total;) {
      sameActivation(asset);
      const length = Math.min(chunkBytes, total - offset);
      if (
        asset.totalBytes !== first.totalBytes ||
        asset.sha256 !== first.sha256 ||
        asset.bytesBase64.length !== 4 * Math.ceil(length / 3)
      )
        throw invalid();
      const decoded = atob(asset.bytesBase64);
      if (decoded.length !== length) throw invalid();
      for (let i = 0; i < decoded.length; i++)
        file[offset + i] = decoded.charCodeAt(i);
      offset += length;
      if (offset < total) asset = await page(offset, first.path);
    }
    if ((await sha256Hex(file)) !== first.sha256) throw invalid();
    signal.throwIfAborted();
    return file;
  }

  const html = new TextDecoder("utf-8", { fatal: true }).decode(
    await bytes(entry),
  );
  const template = document.createElement("template");
  template.innerHTML = html;
  const directory = entry.entry.slice(0, entry.entry.lastIndexOf("/") + 1);
  function relative(source: string | null) {
    if (
      !source ||
      /[\\:?#]/u.test(source) ||
      source
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      throw invalid();
    return directory + source;
  }
  const scripts = Array.from(
    template.content.querySelectorAll("script"),
    (script) => {
      if (script.type && script.type !== "text/javascript") throw invalid();
      return relative(script.getAttribute("src"));
    },
  );
  const styles = Array.from(
    template.content.querySelectorAll('link[rel="stylesheet"]'),
    (link) => relative(link.getAttribute("href")),
  );
  if (!scripts.length || scripts.length + styles.length > maxViewAssets)
    throw invalid();
  const payload = {
    kind: "signed-view-assets",
    html,
    scripts: [] as Uint8Array<ArrayBuffer>[],
    styles: [] as Uint8Array<ArrayBuffer>[],
  };
  for (const path of scripts)
    payload.scripts.push(await bytes(await page(0, path)));
  for (const path of styles)
    payload.styles.push(await bytes(await page(0, path)));
  await authorize();
  return { authorize, payload };
}
