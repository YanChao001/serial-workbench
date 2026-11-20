import type { LanPeer, LanRoute } from "@serial-workbench/contracts";
import { isRecord } from "@/lib/settings-model";

function parseObject(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hostId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function readLanInvitation(text: string):
  | {
      peer: LanPeer;
      address?: string;
    }
  | undefined {
  const value = parseObject(text);
  if (
    !value ||
    !hostId(value.hostId) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint)
  )
    return;
  return {
    peer: { hostId: value.hostId, fingerprint: value.fingerprint },
    address:
      typeof value.address === "string" && value.address.length <= 128
        ? value.address.trim()
        : undefined,
  };
}

const lastConnectionKey = "serial-workbench:last-lan-connection";

export function lastLanConnection(): LanRoute | undefined {
  try {
    const value = parseObject(localStorage.getItem(lastConnectionKey) ?? "");
    if (
      value &&
      hostId(value.hostId) &&
      typeof value.address === "string" &&
      value.address.length > 0 &&
      value.address.length <= 128
    )
      return { hostId: value.hostId, address: value.address };
  } catch {
    // This hint is optional. The Host owns trust and authorization.
  }
}

export function rememberLanConnection(route: LanRoute) {
  try {
    localStorage.setItem(lastConnectionKey, JSON.stringify(route));
  } catch {
    // Connection success is independent of whether the address is remembered.
  }
}
