import { defaults } from "@serial-workbench/contracts";
import type {
  DeviceDescriptor,
  SessionSnapshot,
  TerminalMode,
  TerminalSettings,
  WorkspaceDocument,
  WorkspaceView,
} from "@serial-workbench/contracts";
import type { SessionTab } from "./session-tabs";
import { addSessionView } from "./workspace-model";
export type WindowViewModes = Readonly<
  Record<string, { receiveMode?: TerminalMode; sendMode?: TerminalMode }>
>;

/** A template snapshot is built only for the user's explicit save action. */
export function snapshotWindowLayout(
  document: WorkspaceDocument,
  tabs: readonly SessionTab[],
  sessions: readonly SessionSnapshot[],
  devices: readonly DeviceDescriptor[],
  terminal: TerminalSettings,
  modes: WindowViewModes,
  viewColor = defaults.settings.customAccent,
): WorkspaceDocument {
  let result: WorkspaceDocument = { ...document, views: [] };
  const views: WorkspaceView[] = [];
  for (const tab of tabs) {
    let view = tab.view ?? document.views.find((view) => view.id === tab.id);
    const session = sessions.find(
      (session) => session.sessionId === tab.sessionId,
    );
    const device = devices.find(
      (device) => device.deviceId === session?.deviceId,
    );
    if (!view && session && device) {
      const added = addSessionView(
        { ...result, views: [] },
        session,
        device,
        terminal,
        viewColor,
      );
      if (added) {
        result = { ...result, bindings: added.document.bindings };
        view = added.document.views[0];
      }
    }
    if (!view) throw new Error("VIEW_BINDING_UNAVAILABLE");
    if (session && device) {
      const bindingId = view.bindingId;
      result = {
        ...result,
        bindings: result.bindings.map((binding) =>
          binding.bindingId === bindingId &&
          binding.deviceId === device.deviceId &&
          binding.hostId === device.hostId
            ? { ...binding, configuration: session.configuration }
            : binding,
        ),
      };
    }
    const receiveMode = modes[tab.id]?.receiveMode ?? view.receiveMode;
    const sendMode = modes[tab.id]?.sendMode ?? view.sendMode;
    views.push({ ...view, id: tab.id, receiveMode, sendMode });
  }
  return { ...result, views };
}
