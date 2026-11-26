export const builtinUdpPackageId = "swb.builtin.udp";
export const builtinUdpProviderId = "swb.builtin.udp.transport";

export type UdpFamily = "ipv4" | "ipv6";
export type UdpMode = "unicast" | "broadcast" | "multicast";

function ipv4(value: string) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
    )
  );
}

function index(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^[1-9]\d{0,9}$/.test(value) &&
    Number(value) <= 4_294_967_295
  );
}

function address(value: unknown, family: UdpFamily) {
  if (typeof value !== "string" || value.length > 64 || value !== value.trim())
    return;
  if (family === "ipv4") return ipv4(value) ? value : undefined;
  const [ip, zone, ...extra] = value.split("%");
  if (!ip || !/^[0-9a-f.:]+$/i.test(ip) || extra.length) return;
  try {
    const canonical = new URL("http://[" + ip + "]").hostname.slice(1, -1);
    if (canonical.startsWith("::ffff:")) return;
    const linkLocal = /^fe[89ab][0-9a-f]:/.test(canonical);
    if (linkLocal) return index(zone) ? canonical + "%" + zone : undefined;
    if (zone === undefined) return canonical;
  } catch {
    return undefined;
  }
}

function group(value: string, family: UdpFamily) {
  if (family === "ipv6") return value.startsWith("ff");
  const first = Number(value.split(".", 1)[0]);
  return first >= 224 && first <= 239;
}

function portNumber(value: unknown, min: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= 65_535
  );
}

export function udpEndpoint(params: Record<string, unknown>) {
  const {
    family = "ipv4",
    mode = "unicast",
    host,
    port,
    localAddress,
    localPort,
    multicastInterface,
  } = params;
  if (
    Object.keys(params).some(
      (key) =>
        ![
          "family",
          "mode",
          "host",
          "port",
          "localAddress",
          "localPort",
          "multicastInterface",
        ].includes(key),
    )
  )
    return { error: "parameters" } as const;
  if (family !== "ipv4" && family !== "ipv6")
    return { error: "family" } as const;
  if (
    (mode !== "unicast" && mode !== "broadcast" && mode !== "multicast") ||
    (mode === "broadcast" && family !== "ipv4")
  )
    return { error: "mode" } as const;

  const destination = address(host, family);
  const any = family === "ipv4" ? "0.0.0.0" : "::";
  const limitedBroadcast = "255.255.255.255";
  if (
    !destination ||
    destination === any ||
    (mode === "multicast") !== group(destination, family) ||
    (destination === limitedBroadcast && mode !== "broadcast")
  )
    return { error: "host" } as const;
  if (!portNumber(port, 1)) return { error: "port" } as const;

  const binding =
    localAddress === undefined ? any : address(localAddress, family);
  if (
    !binding ||
    group(binding, family) ||
    binding === limitedBroadcast ||
    (mode === "multicast" && binding !== any) ||
    (mode === "broadcast" &&
      destination !== limitedBroadcast &&
      binding === any)
  )
    return { error: "localAddress" } as const;
  const incomingPort =
    localPort === undefined ? (mode === "multicast" ? port : 0) : localPort;
  if (!portNumber(incomingPort, mode === "multicast" ? 1 : 0)) {
    return { error: "localPort" } as const;
  }

  if (mode !== "multicast") {
    if (multicastInterface !== undefined)
      return { error: "multicastInterface" } as const;
    return {
      family,
      mode,
      host: destination,
      port,
      localAddress: binding,
      localPort: incomingPort,
    } as const;
  }

  const ipv6 = family === "ipv6";
  const interfaceAddress = ipv6
    ? index(multicastInterface) && "::%" + multicastInterface
    : address(multicastInterface, family);
  if (
    !interfaceAddress ||
    interfaceAddress === any ||
    interfaceAddress === limitedBroadcast ||
    group(interfaceAddress, family)
  )
    return { error: "multicastInterface" } as const;
  return {
    family,
    mode,
    host: destination,
    port,
    localAddress: binding,
    localPort: incomingPort,
    multicastInterface: interfaceAddress,
    sendHost: ipv6 ? destination + interfaceAddress.slice(2) : destination,
  } as const;
}
