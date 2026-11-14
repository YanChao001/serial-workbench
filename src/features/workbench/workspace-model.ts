import type {
  DeviceDescriptor,
  SessionSnapshot,
  TerminalSettings,
  WorkspaceDocument,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import type { SessionTab } from "./session-tabs";

/** DTO object key order may change across the native JSON round trip. */
export function sameWorkspace(
  left: WorkspaceDocument | undefined,
  right: WorkspaceDocument | undefined,
): boolean {
  return sameJsonValue(left, right);
}
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index) => sameJsonValue(value, right[index]))
    );
  if (Array.isArray(right)) return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = Object.keys(leftObject).filter(
    (key) => leftObject[key] !== undefined,
  );
  return (
    keys.length ===
      Object.keys(rightObject).filter((key) => rightObject[key] !== undefined)
        .length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        sameJsonValue(leftObject[key], rightObject[key]),
    )
  );
}
export function uniqueViewName(
  name: string,
  views: WorkspaceDocument["views"],
) {
  const names = new Set(views.map((view) => view.name));
  const root = name.replace(/\s+\(\d+\)$/u, "");
  let candidate = root;
  for (let index = 2; names.has(candidate); index++)
    candidate = `${root} (${index})`;
  return candidate;
}
/** 只消歧显示标签，已有用户名称作为数据保留。 */
export function distinctWorkspaceLabels(
  entries: readonly { value: string; label: string }[],
) {
  const counts = new Map<string, number>();
  for (const item of entries)
    counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  const used = new Set(entries.map((item) => item.label));
  return entries.map((item) => {
    if (counts.get(item.label) === 1) return item;
    let label = item.label;
    for (let index = 1; used.has(label); index++)
      label = `${item.label} (${index})`;
    used.add(label);
    return { ...item, label };
  });
}
export function addDeviceView(
  document: WorkspaceDocument,
  device: DeviceDescriptor,
  configuration: SerialConfiguration,
  terminal: TerminalSettings,
  color: string,
) {
  const bindingId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  return {
    viewId,
    document: {
      ...document,
      bindings: [
        ...document.bindings,
        {
          bindingId,
          hostId: device.hostId,
          deviceId: device.deviceId,
          fingerprint: device.fingerprint,
          configuration,
          reconnect: { enabled: false, maxDelayMs: "30000", maxAttempts: "10" },
        },
      ],
      views: [
        ...document.views,
        {
          id: viewId,
          name: uniqueViewName(device.systemName, document.views),
          color,
          icon: "terminal",
          pinned: false,
          receiveMode: terminal.receiveMode,
          sendMode: terminal.sendMode,
          receiveEncoding: terminal.receiveEncoding,
          sendEncoding: terminal.sendEncoding,
          bindingId,
        },
      ],
    },
  };
}
/** 副本拥有独立视图身份，不能复用原工作区的发送草稿键。 */
export function copyWorkspace(
  document: WorkspaceDocument,
  name: string,
): WorkspaceDocument {
  const bindings = new Map(
    document.bindings.map((binding) => [
      binding.bindingId,
      crypto.randomUUID(),
    ]),
  );
  const copy: WorkspaceDocument = {
    ...structuredClone(document),
    name,
    bindings: document.bindings.map((binding) => ({
      ...structuredClone(binding),
      bindingId: bindings.get(binding.bindingId)!,
    })),
    views: document.views.map((view) => ({
      ...view,
      id: crypto.randomUUID(),
      bindingId: bindings.get(view.bindingId)!,
    })),
    favoriteBindingIds: document.favoriteBindingIds.map((id) =>
      bindings.get(id)!,
    ),
  };
  delete copy.archived;
  return copy;
}
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
          receiveEncoding: terminal.receiveEncoding,
          sendEncoding: terminal.sendEncoding,
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
      ...(same && tab?.source ? { source: tab.source } : {}),
    };
  });
}

/** An explicit connection belongs to the chosen view; matching views share it. */
export function connectSessionTabs(
  tabs: readonly SessionTab[],
  document: WorkspaceDocument | undefined,
  sessionId: string,
  device: DeviceDescriptor | undefined,
  sessions: readonly SessionSnapshot[],
  preferredViewId?: string,
  openedSession?: SessionSnapshot,
): { tabs: SessionTab[]; selected: string } {
  const snapshot =
    openedSession ?? sessions.find((value) => value.sessionId === sessionId);
  const bindingIds = new Set(
    document?.bindings
      .filter(
        (binding) =>
          binding.deviceId === device?.deviceId &&
          binding.hostId === device?.hostId,
      )
      .map((binding) => binding.bindingId),
  );
  const matches = (tab: SessionTab) => {
    if (tab.source)
      return (
        tab.source.device.hostId === device?.hostId &&
        tab.source.device.deviceId === device?.deviceId
      );
    const current = sessions.find((value) => value.sessionId === tab.sessionId);
    return current && device
      ? current.deviceId === device.deviceId
      : bindingIds.has(tab.view?.bindingId ?? "");
  };
  const preferred = tabs.find(
    (tab) =>
      tab.id === preferredViewId &&
      !tab.captureRef &&
      (tab.view || tab.sessionId),
  );
  const selected =
    preferred ??
    tabs.find((tab) => tab.sessionId === sessionId) ??
    tabs.find(matches);
  const connect = (tab: SessionTab): SessionTab => {
    if (
      tab.sessionId === sessionId &&
      (!snapshot ||
        !device ||
        (tab.source?.session.sessionEpoch === snapshot.sessionEpoch &&
          tab.source.device.hostId === device.hostId &&
          tab.source.device.deviceId === device.deviceId))
    )
      return tab;
    return {
      ...tab,
      sessionId,
      ...(snapshot && device ? { source: { device, session: snapshot } } : {}),
    };
  };
  if (selected)
    return {
      selected: selected.id,
      tabs: tabs.map((tab) =>
        tab.id === selected.id || matches(tab) ? connect(tab) : tab,
      ),
    };
  const root = `session-${sessionId}`;
  let id = root;
  for (let index = 2; tabs.some((tab) => tab.id === id); index++)
    id = `${root}-${index}`;
  return { tabs: [...tabs, connect({ id })], selected: id };
}
