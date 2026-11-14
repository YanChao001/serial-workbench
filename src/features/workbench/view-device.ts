import type { DeviceDescriptor } from "@serial-workbench/contracts";

/** 只恢复视图的端口选择，不授予权限或打开设备；Host 继续负责实际身份核验。 */
export function resolveViewDevice(
  saved:
    | (Pick<DeviceDescriptor, "hostId" | "deviceId" | "fingerprint"> & {
        portName?: string;
        systemName?: string;
      })
    | undefined,
  devices: readonly DeviceDescriptor[],
  stale = false,
  legacyPortName?: string,
): DeviceDescriptor | undefined {
  if (!saved) return;
  const exact = devices.find(
    (device) =>
      device.hostId === saved.hostId && device.deviceId === saved.deviceId,
  );
  if (exact || stale) return exact;

  const portName = saved.portName ?? saved.systemName;
  const matchingPort = (name: string) =>
    devices.filter(
      (device) =>
        device.hostId === saved.hostId &&
        device.fingerprint.transport === saved.fingerprint.transport &&
        portNameKey(device.systemName) === portNameKey(name),
    );
  if (portName !== undefined) {
    const ports = matchingPort(portName);
    // 端口位置只决定新连接的可见目标，不证明还是旧硬件；重名不猜测。
    if (ports.length > 0) return ports.length === 1 ? ports[0] : undefined;
  }

  // 与 Host IdentityMatcher::Exact 保持相同证据边界，未知字段的候选也参与歧义判断。
  const fingerprint = saved.fingerprint;
  const serial = nonempty(fingerprint.serialNumber);
  const plausible = devices.filter((device) => {
    const found = device.fingerprint;
    return (
      device.hostId === saved.hostId &&
      found.transport === fingerprint.transport &&
      compatible(fingerprint.vid, found.vid) &&
      compatible(fingerprint.pid, found.pid) &&
      compatible(serial, nonempty(found.serialNumber))
    );
  });
  if (plausible.length === 1) {
    const candidate = plausible[0]!;
    const found = candidate.fingerprint;
    if (
      fingerprint.evidence === "serialNumber" &&
      found.evidence === "serialNumber" &&
      serial !== undefined &&
      serial === nonempty(found.serialNumber) &&
      (fingerprint.vid === undefined || fingerprint.vid === found.vid) &&
      (fingerprint.pid === undefined || fingerprint.pid === found.pid) &&
      nonempty(fingerprint.topologyPath) === nonempty(found.topologyPath)
    )
      return candidate;
  }
  // 仅旧文档缺少端口字段时，才把用户可见的旧名称用作选择提示。
  if (portName === undefined && legacyPortName !== undefined) {
    const ports = matchingPort(legacyPortName);
    if (ports.length === 1) return ports[0];
  }
}

function portNameKey(name: string): string {
  return /^COM\d+$/i.test(name) ? name.toUpperCase() : name;
}

function nonempty(value: string | undefined): string | undefined {
  // Rust trim 按 Unicode White_Space 判空，与 JS trim 的 NEL/BOM 集合不同。
  return value !== undefined && /[^\p{White_Space}]/u.test(value)
    ? value
    : undefined;
}

function compatible<T>(saved: T | undefined, found: T | undefined): boolean {
  return saved === undefined || found === undefined || saved === found;
}
