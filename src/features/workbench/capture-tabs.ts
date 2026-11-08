import type { ObjectRef, WorkspaceDocument } from "@serial-workbench/contracts";
import type { SessionTab } from "./session-tabs";
export function captureTab(reference: ObjectRef): SessionTab {
  return {
    id:
      "capture/" +
      encodeURIComponent(
        JSON.stringify([
          reference.hostId,
          reference.kind,
          reference.id,
          reference.revision,
        ]),
      ),
    captureRef: reference,
  };
}
export function workspaceTabs(
  document: WorkspaceDocument | undefined,
): SessionTab[] {
  return [
    ...(document?.views.map((view) => ({ id: view.id, view })) ?? []),
    ...(document?.captures.map(captureTab) ?? []),
  ];
}
