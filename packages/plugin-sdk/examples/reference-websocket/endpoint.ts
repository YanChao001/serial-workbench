export const builtinWebsocketPackageId = "swb.builtin.websocket";
export const builtinWebsocketProviderId = "swb.builtin.websocket.transport";
export const websocketMessageLimit = 128 * 1024;

export type WebsocketRole = "client" | "server";
export type WebsocketSendType = "binary" | "text";

/* eslint-disable no-control-regex -- Reject control characters before URL normalization. */
function absoluteUrl(value: unknown, maxLength: number) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password && !value.includes("#"))
      return url;
  } catch {
    return;
  }
}

/* eslint-enable no-control-regex */

function literalBindAddress(value: unknown) {
  if (typeof value !== "string" || value.length > 64) return;
  if (/^[0-9.]+$/.test(value)) {
    const url = absoluteUrl("http://" + value, 80);
    if (url?.hostname === value && value.split(".").length === 4) return value;
  }
  if (/^[0-9a-f:.]+$/i.test(value) && value.includes(":")) {
    const url = absoluteUrl("http://[" + value + "]", 80);
    return url?.hostname.slice(1, -1);
  }
}

function handshakePath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?")
  )
    return;
  const url = absoluteUrl("http://localhost" + value, 300);
  if (url?.pathname === value) return value;
}

export function websocketEndpoint(params: Record<string, unknown>) {
  const { role = "client", sendType = "binary" } = params;
  if (role !== "client" && role !== "server") return { error: "role" } as const;
  if (sendType !== "text" && sendType !== "binary")
    return { error: "sendType" } as const;
  const keys =
    role === "client"
      ? ["role", "sendType", "url"]
      : ["role", "sendType", "bindAddress", "port", "path", "browserOrigin"];
  if (Object.keys(params).some((key) => !keys.includes(key)))
    return { error: "params" } as const;

  if (role === "client") {
    const url = absoluteUrl(params.url, 2048);
    if (
      !url ||
      typeof params.url !== "string" ||
      !/^wss?:\/\//i.test(params.url)
    )
      return { error: "url" } as const;
    return { role, sendType, url: url.href } as const;
  }

  const {
    bindAddress: bindInput = "127.0.0.1",
    path: pathInput = "/",
    port,
  } = params;
  const bindAddress = literalBindAddress(bindInput);
  if (!bindAddress) return { error: "bindAddress" } as const;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return { error: "port" } as const;
  const path = handshakePath(pathInput);
  if (!path) return { error: "path" } as const;
  let browserOrigin: string | undefined;
  if (params.browserOrigin !== undefined) {
    const url = absoluteUrl(params.browserOrigin, 256);
    if (
      !url ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.pathname !== "/" ||
      url.search
    )
      return { error: "browserOrigin" } as const;
    browserOrigin = url.origin;
  }
  return { role, sendType, bindAddress, port, path, browserOrigin } as const;
}
