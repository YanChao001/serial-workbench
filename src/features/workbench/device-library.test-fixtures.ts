import type {
  DeviceDescriptor,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { session } from "./test-fixtures";

export const deviceLabels = {
  onlineDevices: "Online devices",
  details: "Details",
  offlineDevice: "Offline device",
  noDevices: "No online devices",
  loading: "Loading",
  retry: "Retry",
  serialIdentity: "Device serial number",
  topologyIdentity: "USB port location",
  unknownIdentity: "Cannot uniquely identify",
  virtualDevice: "Virtual loopback device",
  failure: (code: string) => `Failed: ${code}`,
  deviceLibrary: "Device library",
  deviceInformation: "Device information",
  manufacturer: "Manufacturer",
  driver: "Driver",
  usbVid: "USB VID",
  usbPid: "USB PID",
  serialNumber: "Serial number",
  topologyPath: "Topology path",
  identityEvidence: "Identity evidence",
  missingEvidence: "Not reported",
  recentConnections: "Recent connections",
  favorites: "Favorites",
  noRecent: "No recent connections",
  noBindings: "No workspace bindings",
  addFavorite: "Add favorite",
  removeFavorite: "Remove favorite",
  rebind: "Rebind",
  chooseDevice: "Choose a device explicitly",
  binding: "Binding",
  configuration: "Requested configuration",
  disconnected: "Disconnected",
  refreshRecent: "Refresh recent",
  unavailable: "Unavailable",
  rebindHelp:
    "Choose the intended device using its identity evidence. Rebinding does not open a port.",
};
export function device(id = "device-a"): DeviceDescriptor {
  return {
    deviceId: id,
    hostId: "host",
    systemName: id === "device-a" ? "COM9" : "COM2",
    manufacturer: "ACME",
    driver: "driver-v1",
    fingerprint: {
      transport: "serial",
      vid: 4660,
      pid: 22136,
      serialNumber: "serial-42",
      topologyPath: "usb/1/2",
      evidence: "serialNumber",
    },
    capabilities: session().capabilities,
  };
}
export function workspace(): WorkspaceDocumentResult {
  return {
    document: {
      revision: "7",
      value: {
        name: "Bench",
        views: [],
        bindings: [
          {
            bindingId: "probe",
            hostId: "host",
            deviceId: "missing-device",
            fingerprint: { transport: "serial", evidence: "unreliable" },
            configuration: session().configuration,
            reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
          },
        ],
        favoriteBindingIds: ["probe"],
        layout: { sidebarWidth: 224, panelHeight: 192 },
        captures: [],
      },
    },
    scope: {
      scopeId: "workspace:bench",
      target: { hostId: "host", kind: "workspace", id: "bench" },
    },
  };
}

export function favoriteSaved(): WorkspaceDocumentResult {
  const result = workspace();
  result.document.revision = "8";
  result.document.value.favoriteBindingIds = [];
  return result;
}

export function deviceRebound(deviceId = "device-a"): WorkspaceDocumentResult {
  const result = workspace();
  result.document.revision = "8";
  result.document.value.bindings = result.document.value.bindings.map(
    (binding) => ({ ...binding, deviceId }),
  );
  return result;
}
