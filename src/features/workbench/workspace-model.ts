import type {
  DeviceDescriptor,
  SessionSnapshot,
  TerminalSettings,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import type { SessionTab } from "./session-tabs";
export function addSessionView(
  document: WorkspaceDocument,
  session: SessionSnapshot,
  device: DeviceDescriptor,
  terminal: TerminalSettings,
  color: string,
): { document: WorkspaceDocument; viewId: string } | undefined {
  if (session.deviceId !== device.deviceId) return undefined;
  const existing = document.bindings.find(
    (binding) =>
      binding.hostId === device.hostId && binding.deviceId === device.deviceId,
  );
  const binding = existing ?? {
    bindingId: crypto.randomUUID(),
    hostId: device.hostId,
    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    configuration: session.configuration,
    reconnect: { enabled: false, maxDelayMs: "30000", maxAttempts: "10" },
  };
  const viewId = `session-${session.sessionId}`;
  if (document.views.some((view) => view.id === viewId))
    return { document, viewId };
  return {
    viewId,
    document: {
      ...document,
      bindings: existing ? document.bindings : [...document.bindings, binding],
      views: [
        ...document.views,
        {
          id: viewId,
          name: device.systemName,
          color,
          icon: "terminal",
          pinned: false,
          receiveMode: terminal.receiveMode,
          sendMode: terminal.sendMode,
          bindingId: binding.bindingId,
        },
      ],
    },
  };
}
export function reconcileWorkspaceTabs(
  tabs: readonly SessionTab[],
  before: WorkspaceDocument | undefined,
  next: WorkspaceDocument,
): SessionTab[] {
  return next.views.map((view) => {
    const tab = tabs.find((candidate) => candidate.id === view.id);
    const previousBinding = before?.bindings.find(
      (binding) => binding.bindingId === tab?.view?.bindingId,
    );
    const binding = next.bindings.find(
      (binding) => binding.bindingId === view.bindingId,
    );
    const same =
      previousBinding &&
      binding &&
      previousBinding.hostId === binding.hostId &&
      previousBinding.deviceId === binding.deviceId;
    return {
      id: view.id,
      view,
      ...(same && tab?.sessionId ? { sessionId: tab.sessionId } : {}),
    };
  });
}
