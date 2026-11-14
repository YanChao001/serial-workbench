import { StrictMode } from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Toaster } from "sonner";
import type { WorkspaceDocument } from "@serial-workbench/contracts";
import { WorkspaceLayout, type WorkbenchHost } from "./workspace-layout";
import { addSessionView } from "./workspace-model";
import {
  labels,
  operation,
  session,
  actionCatalog,
  txItem,
} from "./test-fixtures";
import * as streamModel from "./stream-model";
import { workbenchToolLabels } from "./tool-labels";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { defaults } from "@serial-workbench/contracts";
import { connectionKey } from "@/lib/client-connection-defaults";
import { HostRequestError } from "@serial-workbench/host-client";
import { createHostConnection } from "@/lib/host-client";
import type { HostNativePort } from "@/lib/host-client";
import type { AttachResult } from "@serial-workbench/contracts";
afterEach(cleanup);
beforeEach(() => {
  render(<Toaster />);
});
const namedSessionLabels = { ...labels, sessionLabel: "Session" };
function workspacePreset(
  adapter: WorkbenchHost,
  baudRate: string,
  deviceId = "device",
) {
  const device = adapter.state.devices.find(
    (item) => item.deviceId === deviceId,
  )!;
  return addSessionView(
    defaults.workspace,
    {
      ...session(),
      deviceId,
      configuration: { ...session().configuration, baudRate },
    },
    device,
    defaults.settings.terminal,
    "#2266AA",
  )!.document;
}

it("uses the selected workspace connection preset ahead of remembered device preferences", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={workspacePreset(adapter, "9600")}
      connectionDefaults={{
        [connectionKey("host", "device")]: {
          ...session().configuration,
          baudRate: "115200",
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() =>
    expect(adapter.open).toHaveBeenCalledWith(
      "device",
      expect.any(AbortSignal),
      expect.objectContaining({ baudRate: "9600" }),
    ),
  );
});
it("keeps an explicitly opened connection usable in cloned views and another workspace without reopening the device", async () => {
  const adapter = host();
  const original = workspacePreset(adapter, "9600");
  const content = (document: WorkspaceDocument, key = "original") => (
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      workspaceKey={key}
    />
  );
  const mounted = render(content(original));
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(adapter.open).toHaveBeenCalledOnce());
  const source = original.views[0]!;
  const clone = {
    ...original,
    views: [
      ...original.views,
      {
        ...source,
        id: "cloned",
        bindingId: "cloned-binding",
        name: "Cloned view",
      },
    ],
    bindings: [
      ...original.bindings,
      { ...original.bindings[0]!, bindingId: "cloned-binding" },
    ],
  };
  mounted.rerender(content(clone));
  fireEvent.click(await screen.findByRole("tab", { name: "Cloned view" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "probe" },
  });
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  mounted.rerender(content({ ...clone, views: [clone.views[1]!] }, "another"));
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(adapter.open).toHaveBeenCalledOnce();
  adapter.state.sessions = adapter.state.sessions.map((value) => ({
    ...value,
    sessionEpoch: String(BigInt(value.sessionEpoch) + 1n),
  }));
  mounted.rerender(
    content({ ...clone, views: [clone.views[1]!] }, "retired-epoch"),
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("selects the restored view's bound device before the first enumerated port", () => {
  const adapter = host();
  adapter.state.sessions = [];
  adapter.state.devices = [
    ...adapter.state.devices,
    {
      ...adapter.state.devices[0]!,
      deviceId: "second",
      systemName: "Second serial",
    },
  ];
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={workspacePreset(adapter, "9600", "second")}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: labels.devices }),
  ).toHaveTextContent("Second serial");
  expect(
    screen.getByRole("button", { name: "Open Second serial" }),
  ).toBeEnabled();
});

it("requires an explicit device choice when the restored binding is unavailable on this Host", () => {
  const adapter = host();
  adapter.state.sessions = [];
  const document = workspacePreset(adapter, "9600");
  document.bindings = document.bindings.map((binding) => ({
    ...binding,
    hostId: "other-host",
  }));
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
    />,
  );
  expect(screen.getByRole("button", { name: /^Open(?: |$)/ })).toBeDisabled();
  expect(adapter.open).not.toHaveBeenCalled();
});

it("connects an explicitly chosen replacement device in the existing workspace view after access succeeds", async () => {
  const adapter = host();
  let document = workspacePreset(adapter, "9600");
  document = {
    ...document,
    bindings: document.bindings.map((binding) => ({
      ...binding,
      hostId: "retired-host",
      deviceId: "retired-device",
    })),
  };
  const original = structuredClone(document);
  const viewId = document.views[0]!.id;
  let completeOpen: (() => void) | undefined;
  adapter.open = vi.fn<WorkbenchHost["open"]>(
    () => new Promise((resolve) => (completeOpen = () => resolve(session()))),
  );
  const save = vi.fn(async (value: WorkspaceDocument) => {
    document = value;
  });
  const content = () => (
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ [viewId]: "retained draft" }}
      onSaveWindowLayout={save}
      onCloseSession={vi.fn()}
    />
  );
  const mounted = render(content());
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: labels.devices }));
  await user.click(screen.getByRole("option", { name: "Virtual serial" }));
  await user.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(adapter.watchSession).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "retained draft",
  );
  await act(async () => completeOpen?.());
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(adapter.send).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "session", sessionEpoch: "1" }),
    new TextEncoder().encode("retained draft"),
    expect.any(AbortSignal),
    expect.any(String),
  );
  await user.click(screen.getByRole("button", { name: labels.saveDrafts }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(document.views).toHaveLength(1);
  expect(document.views[0]).toMatchObject({
    id: viewId,
    name: "Virtual serial",
  });
  expect(
    document.bindings.find(
      (binding) => binding.bindingId === document.views[0]!.bindingId,
    ),
  ).toMatchObject({ hostId: "host", deviceId: "device" });
  expect(original.bindings[0]?.hostId).toBe("retired-host");
  mounted.rerender(content());
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "retained draft",
  );
  expect(adapter.open).toHaveBeenCalledOnce();
  expect(adapter.watchSession).toHaveBeenCalledOnce();
});

it("keeps the selected view's connection preset when its unavailable device is explicitly replaced", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  const document = workspacePreset(adapter, "9600");
  document.bindings[0]!.deviceId = "retired-device";
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      connectionDefaults={{
        [connectionKey("host", "device")]: {
          ...session().configuration,
          baudRate: "230400",
        },
      }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: labels.devices }));
  await user.click(screen.getByRole("option", { name: "Virtual serial" }));
  await user.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  expect(adapter.open).toHaveBeenCalledWith(
    "device",
    expect.any(AbortSignal),
    expect.objectContaining({ baudRate: "9600" }),
  );
});

it("opens all matching saved views without switching away from the view the user connected", async () => {
  const adapter = host();
  const original = workspacePreset(adapter, "9600");
  const document = {
    ...original,
    views: [
      ...original.views,
      { ...original.views[0]!, id: "second-view", name: "Second view" },
    ],
  };
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ "second-view": "second draft" }}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Second view" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
  );
  expect(screen.getByRole("tab", { name: "Second view" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "second draft",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Virtual serial" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "first draft" },
  });
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  fireEvent.click(screen.getByRole("tab", { name: "Second view" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "second draft",
  );
  expect(adapter.open).toHaveBeenCalledOnce();
  expect(adapter.watchSession).toHaveBeenCalledOnce();
});

it("offers connect for an offline view when its chosen device is already connected in another tab", async () => {
  const adapter = host();
  const original = workspacePreset(adapter, "9600");
  const document = {
    ...original,
    bindings: [
      ...original.bindings,
      {
        ...original.bindings[0]!,
        bindingId: "old-binding",
        deviceId: "retired-device",
      },
    ],
    views: [
      ...original.views,
      {
        ...original.views[0]!,
        id: "offline-view",
        bindingId: "old-binding",
        name: "Offline view",
      },
    ],
  };
  const close = vi.fn();
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      onCloseSession={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("button", { name: "Close session" });
  fireEvent.click(screen.getByRole("tab", { name: "Offline view" }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: labels.devices }));
  await user.click(screen.getByRole("option", { name: "Virtual serial" }));
  await user.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(adapter.open).toHaveBeenCalledTimes(2));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("tab", { name: "Offline view" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "replacement" },
  });
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(close).not.toHaveBeenCalled();
  expect(adapter.watchSession).toHaveBeenCalledOnce();
});

it("keeps the original view and its draft when connecting a replacement is denied", async () => {
  const adapter = host();
  const document = workspacePreset(adapter, "9600");
  document.bindings[0]!.deviceId = "missing-device";
  adapter.trustedConnect = vi
    .fn()
    .mockRejectedValue({ code: "PERMISSION_DENIED" });
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ [document.views[0]!.id]: "do not lose" }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: labels.devices }));
  await user.click(screen.getByRole("option", { name: "Virtual serial" }));
  await user.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(adapter.trustedConnect).toHaveBeenCalledOnce());
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "do not lose",
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(adapter.watchSession).not.toHaveBeenCalled();
  expect(adapter.open).not.toHaveBeenCalled();
  expect(document.bindings[0]?.deviceId).toBe("missing-device");
});

it.each(["saved", "runtime"])(
  "reconnects %s and duplicated views to the new session together while retaining independent drafts",
  async (kind) => {
    const adapter = host();
    const document =
      kind === "saved" ? workspacePreset(adapter, "9600") : defaults.workspace;
    const props = { host: adapter, labels, initialWorkspace: document };
    const mounted = render(<WorkspaceLayout {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    await waitFor(() => expect(adapter.watchSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "New view" }));
    const second = screen.getByRole("tab", { selected: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
      target: { value: "second draft" },
    });
    const closed = { ...session(), state: "closed" as const };
    const reopened = { ...session("reopened"), sessionEpoch: "2" };
    adapter.state = { ...adapter.state, sessions: [] };
    adapter.open = vi.fn(async () => {
      adapter.state = { ...adapter.state, sessions: [closed, reopened] };
      return reopened;
    });
    mounted.rerender(<WorkspaceLayout {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
    );
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(adapter.send).toHaveBeenCalledOnce());
    expect(adapter.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "reopened", sessionEpoch: "2" }),
      new TextEncoder().encode("second draft"),
      expect.any(AbortSignal),
      expect.any(String),
    );
    fireEvent.click(screen.getByRole("tab", { selected: false }));
    fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
      target: { value: "first draft" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.click(second);
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      "second draft",
    );
    expect(adapter.watchSession).toHaveBeenCalledTimes(2);
  },
);

it("restores each workspace's display modes when the view ids are the same", () => {
  const adapter = host();
  const preset = workspacePreset(adapter, "9600");
  const content = (key: string) => (
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={preset}
      workspaceKey={key}
    />
  );
  const mounted = render(content("first"));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Receive" })).getByRole("radio", {
      name: "HEX",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: "Send" })).getByRole("radio", {
      name: "HEX",
    }),
  );
  mounted.rerender(content("second"));
  expect(
    within(screen.getByRole("region", { name: "Receive" })).getByRole("radio", {
      name: "Text",
    }),
  ).toBeChecked();
  expect(
    within(screen.getByRole("region", { name: "Send" })).getByRole("radio", {
      name: "Text",
    }),
  ).toBeChecked();
});

it("does not reuse an earlier workspace's connection overrides when opening another preset", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  adapter.open = vi.fn().mockResolvedValue({
    ...session(),
    configuration: { ...session().configuration, baudRate: "9600" },
  });
  const first = workspacePreset(adapter, "9600");
  const second = workspacePreset(adapter, "115200");
  const mounted = render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={first}
      workspaceKey="first"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    ).toBeEnabled(),
  );
  mounted.rerender(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={second}
      workspaceKey="second"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() =>
    expect(adapter.open).toHaveBeenLastCalledWith(
      "device",
      expect.any(AbortSignal),
      expect.objectContaining({ baudRate: "115200" }),
    ),
  );
});
it("updates visible view metadata and adds new views without reopening a closed view", () => {
  const adapter = host();
  const workspace = addSessionView(
    defaults.workspace,
    session(),
    adapter.state.devices[0]!,
    defaults.settings.terminal,
    "#2266AA",
  )!.document;
  const original = workspace.views[0]!;
  const content = (document: WorkspaceDocument) => (
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ [original.id]: "LOCAL DRAFT" }}
    />
  );
  const mounted = render(content(workspace));
  const edited = {
    ...workspace,
    views: [
      {
        ...original,
        name: "Edited view",
        color: "#AA2266",
        icon: "cpu",
        pinned: true,
      },
    ],
  };
  mounted.rerender(content(edited));
  const tab = screen.getByRole("tab", { name: /Edited view/ });
  expect(tab).toHaveTextContent(labels.pinned);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "LOCAL DRAFT",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close view" }));
  mounted.rerender(content({ ...edited, name: "Renamed workspace" }));
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  mounted.rerender(
    content({
      ...edited,
      views: [
        ...edited.views,
        { ...original, id: "cloned-view", name: "Cloned view" },
      ],
    }),
  );
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Cloned view" })).toBeInTheDocument();
  expect(adapter.open).not.toHaveBeenCalled();
});
it("reports backend exact-send permission denial without claiming successful transmission", async () => {
  const adapter = host();
  adapter.checkAction = vi.fn<WorkbenchHost["checkAction"]>(async (input) => ({
    actionId: input.actionId,
    target: input.target,
    allowed: false,
  }));
  adapter.send = vi
    .fn<WorkbenchHost["send"]>()
    .mockRejectedValue({ code: "PERMISSION_DENIED" });
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      formatError={(error) => error.code ?? "INTERNAL"}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "DO NOT TRANSMIT" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("PERMISSION_DENIED"),
  );
  expect(adapter.send).toHaveBeenCalledOnce();
});
it("submits exact bytes during advisory checking and keeps close usable during send admission", async () => {
  const adapter = host();
  adapter.watchActions = vi.fn<WorkbenchHost["watchActions"]>(
    (inputs, listener) => {
      listener(
        inputs.map((input) => ({
          input,
          result:
            input.actionId === "session.tx"
              ? null
              : {
                  actionId: input.actionId,
                  target: input.target,
                  allowed: true,
                },
          error: null,
        })),
      );
      return () => {};
    },
  );
  let release: (() => void) | undefined;
  const sendNormally = adapter.send;
  adapter.send = vi.fn<WorkbenchHost["send"]>(
    (...args) =>
      new Promise((resolve, reject) => {
        release = () => void sendNormally(...args).then(resolve, reject);
      }),
  );
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      onCloseSession={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "x".repeat(10000) },
  });
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toBeEnabled();
  fireEvent.click(send);
  await waitFor(() => expect(adapter.send).toHaveBeenCalledOnce());
  expect(adapter.send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    }),
    new TextEncoder().encode("x".repeat(10000)),
    expect.any(AbortSignal),
    "1869",
  );
  expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();
  await act(async () => release?.());
  await waitFor(() => expect(adapter.send).toHaveBeenCalledOnce());
});
it("does not reproject retained receive data for each draft keystroke", async () => {
  const adapter = host();
  adapter.state.streams = new Map([
    [
      "session",
      {
        items: [txItem("tx")],
        error: null,
        trimmed: false,
      },
    ],
  ]);
  const project = vi.spyOn(streamModel, "projectStreamItems");
  try {
    render(<WorkspaceLayout host={adapter} labels={labels} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    const draft = screen.getByRole("textbox", { name: "Send input" });
    await waitFor(() => expect(screen.getByText("Hello")).toBeVisible());
    project.mockClear();
    for (let length = 1; length <= 20; length++)
      fireEvent.change(draft, { target: { value: "x".repeat(length) } });
    expect(draft).toHaveValue("x".repeat(20));
    expect(project).not.toHaveBeenCalled();
  } finally {
    project.mockRestore();
  }
});
async function namedSessionConnection(
  options: {
    hostId?: string;
    instanceEpoch?: string;
    generation?: string;
  } = {},
) {
  const attachment: AttachResult = {
    hostId: options.hostId ?? "host",
    instanceEpoch: options.instanceEpoch ?? "1",
    protocolVersion: "0.1",
    catalogVersion: "1",
    actorId: "actor",
    clientId: "client",
    requestContext: "fixture-context",
    requestContextAcceptUntil: "2026-11-11T00:00:00Z",
    limits: {
      maxRequestBytes: "100000",
      maxPageItems: "100",
      maxBatchBytes: "100000",
      maxReaderQueueBytes: "100000",
      resultRetentionMs: "1000",
      maxLeaseTtlMs: "1000",
    },
  };
  const port: HostNativePort = {
    attachment: vi
      .fn()
      .mockResolvedValue({ attachment, generation: options.generation ?? "1" }),
    request: vi.fn(),
    rawRequest: vi.fn(),
    subscribe: vi.fn(),
    rawSubscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    rawUnsubscribe: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
  };
  return createHostConnection(port);
}

it("retains a source-proven friendly session tab and its draft when the Host attachment retires", async () => {
  const adapter = host();
  adapter.connection = await namedSessionConnection();
  const view = render(
    <WorkspaceLayout host={adapter} labels={namedSessionLabels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "CURRENT EDIT" },
  });
  adapter.connection.dispose();
  adapter.connection = undefined;
  adapter.state = {
    ...adapter.state,
    status: "error",
    error: new Error("retired attachment"),
    devices: [],
    sessions: [],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={namedSessionLabels} />);
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    "Virtual serial",
  );
  expect(screen.getByRole("tab", { selected: true })).not.toHaveTextContent(
    "session-session",
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "CURRENT EDIT",
  );
});

it("retains a source-proven friendly session tab when only its device descriptor disappears", async () => {
  const adapter = host();
  adapter.connection = await namedSessionConnection();
  const view = render(
    <WorkspaceLayout host={adapter} labels={namedSessionLabels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  adapter.state = { ...adapter.state, devices: [] };
  view.rerender(<WorkspaceLayout host={adapter} labels={namedSessionLabels} />);
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    "Virtual serial",
  );
  adapter.connection.dispose();
});

it.each(["Host", "instance", "generation", "session epoch"])(
  "does not borrow a prior friendly session tab label after its %s changes",
  async (changed) => {
    const adapter = host();
    adapter.connection = await namedSessionConnection();
    const previous = adapter.connection;
    const view = render(
      <WorkspaceLayout host={adapter} labels={namedSessionLabels} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    await screen.findByRole("tab", { name: "Virtual serial" });
    fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
      target: { value: "CURRENT EDIT" },
    });
    adapter.connection = await namedSessionConnection({
      hostId: changed === "Host" ? "replacement-host" : "host",
      instanceEpoch: changed === "instance" ? "2" : "1",
      generation: changed === "generation" ? "2" : "1",
    });
    adapter.state = {
      ...adapter.state,
      devices: [],
      sessions: [
        { ...session(), sessionEpoch: changed === "session epoch" ? "2" : "1" },
      ],
    };
    view.rerender(
      <WorkspaceLayout host={adapter} labels={namedSessionLabels} />,
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Session",
    );
    expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
      "CURRENT EDIT",
    );
    previous.dispose();
    adapter.connection.dispose();
  },
);

it("uses a generic session label for an unknown source instead of opaque identities", () => {
  const adapter = host();
  adapter.state = {
    ...adapter.state,
    devices: [],
    operationSummaries: [operation("unknown-name")],
  };
  render(<WorkspaceLayout host={adapter} labels={namedSessionLabels} />);
  locateActivity("Locate unknown-name");
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "Session",
  );
});

it.each(["", " \t ", "  Motor controller  ", "串口 A"])(
  "uses a safe generic tab label only for blank custom session names: %j",
  (name) => {
    const adapter = host();
    render(
      <WorkspaceLayout
        host={adapter}
        labels={namedSessionLabels}
        initialWorkspace={{
          ...defaults.workspace,
          views: [
            {
              id: "opaque-internal-view",
              name,
              color: "#2266aa",
              icon: "terminal",
              pinned: false,
              receiveMode: "text",
              sendMode: "text",
              bindingId: "unknown-binding",
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("tab").textContent).toBe(
      name.trim() ? name : "Session",
    );
  },
);
it("requests actual enumeration only when the COM picker opens and retains the draft", async () => {
  const adapter = host();
  const toolLabels = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout host={adapter} labels={labels} toolLabels={toolLabels} />,
  );
  const draft = screen.getByRole("textbox", { name: "Send input" });
  fireEvent.change(draft, { target: { value: "RETAINED DRAFT" } });
  const picker = screen.getByRole("combobox", { name: "Choose device" });
  expect(adapter.refresh).not.toHaveBeenCalled();
  fireEvent.keyDown(picker, { key: "Enter" });
  await screen.findByRole("listbox");
  expect(adapter.refresh).toHaveBeenCalledWith({ enumerateDevices: true });
  expect(adapter.refresh).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  expect(adapter.refresh).toHaveBeenCalledOnce();
  expect(draft).toHaveValue("RETAINED DRAFT");
  expect(adapter.open).not.toHaveBeenCalled();
  expect(adapter.send).not.toHaveBeenCalled();
});
it("disables view duplication when a retained local tab has no ready session", async () => {
  const adapter = host();
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "CURRENT EDIT" },
  });
  adapter.state = {
    ...adapter.state,
    status: "error",
    error: new Error("offline"),
    sessions: [],
    devices: [],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(screen.getByRole("button", { name: "New view" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "CURRENT EDIT",
  );
});
it("keeps the parameter action compact and exposes the current serial summary on focus", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  const toolLabels = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout host={adapter} labels={labels} toolLabels={toolLabels} />,
  );
  const parameters = screen.getByRole("button", {
    name: "Connection parameters",
  });
  expect(parameters).not.toHaveTextContent("9600");
  fireEvent.focus(parameters);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("9600 / 8N1");
});
it("enables the dedicated controls entry only for an open serial session", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  adapter.open = vi.fn(async () => {
    adapter.state.sessions = [session()];
    return session();
  });
  const toolLabels = workbenchToolLabels(createTranslator(en)).layout;
  const renderTool = vi.fn((tool: string) => <div data-tool={tool} />);
  const view = render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={toolLabels}
      renderTool={renderTool}
    />,
  );
  const controls = screen.getByRole("button", {
    name: "Control lines and receipts",
  });
  expect(controls).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(controls).toBeEnabled());
  fireEvent.click(controls);
  expect(
    screen.getByRole("dialog", { name: "Control lines and receipts" }),
  ).toBeInTheDocument();
  expect(renderTool.mock.calls.at(-1)?.[0]).toBe("controls");
  adapter.state.sessions = adapter.state.sessions.map((value) => ({
    ...value,
    state: "disconnected",
  }));
  view.rerender(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={toolLabels}
      renderTool={renderTool}
    />,
  );
  expect(controls).toBeDisabled();
});
it("targets the chosen serial device for controls while another session view stays selected", async () => {
  const adapter = host();
  adapter.state.devices = [
    ...adapter.state.devices,
    {
      ...adapter.state.devices[0]!,
      deviceId: "offline-device",
      systemName: "Offline serial",
    },
  ];
  const toolLabels = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={toolLabels}
      renderTool={(_tool, context) => (
        <output aria-label="Control target">{context.target?.sessionId}</output>
      )}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  const user = userEvent.setup();
  const controls = screen.getByRole("button", {
    name: "Control lines and receipts",
  });
  await user.click(screen.getByRole("combobox", { name: "Choose device" }));
  await user.click(screen.getByRole("option", { name: "Offline serial" }));
  expect(controls).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Choose device" }));
  await user.click(screen.getByRole("option", { name: "Virtual serial" }));
  await user.click(controls);
  expect(screen.getByLabelText("Control target")).toHaveTextContent("session");
});
it("keeps the workspace entry stable while loading and localizes only its unnamed presentation", async () => {
  const adapter = host();
  const english = workbenchToolLabels(createTranslator(en)).layout;
  const chinese = workbenchToolLabels(createTranslator(zhCN)).layout;
  const content = (
    toolLabels: typeof english,
    initialWorkspace?: WorkspaceDocument,
  ) => (
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={toolLabels}
      initialWorkspace={initialWorkspace}
      renderTool={() => null}
    />
  );
  const view = render(content(english));
  const entry = screen.getByRole("button", { name: "Workspace" });
  fireEvent.focus(entry);
  await waitFor(() => expect(entry).toHaveAccessibleDescription("Workspace"));
  view.rerender(content(english, { ...defaults.workspace, name: "" }));
  expect(screen.getByRole("button", { name: "Workspace" })).toBe(entry);
  await waitFor(() => expect(entry).toHaveAccessibleDescription("Workspace"));
  view.rerender(content(chinese, { ...defaults.workspace, name: "" }));
  expect(screen.getByRole("button", { name: "工作区" })).toBe(entry);
  await waitFor(() => expect(entry).toHaveAccessibleDescription("工作区"));
  view.rerender(content(chinese, { ...defaults.workspace, name: "Workspace" }));
  await waitFor(() =>
    expect(entry).toHaveAccessibleDescription("工作区: Workspace"),
  );
  expect(entry).toHaveTextContent("");
});
it("returns keyboard menu tools and internal tool jumps to the permanent menu trigger", async () => {
  const tools = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout
      host={host()}
      labels={labels}
      toolLabels={tools}
      readMetrics={vi.fn().mockRejectedValue(new Error("UNAVAILABLE"))}
      renderTool={(tool, context) =>
        tool === "diagnostics" ? (
          <button onClick={context.onInspectMetrics}>Inspect metrics</button>
        ) : null
      }
    />,
  );
  const trigger = screen.getByRole("button", { name: "Workspace menu" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const tasks = await screen.findByRole("menuitem", { name: "Tasks" });
  tasks.focus();
  fireEvent.keyDown(tasks, { key: "Enter" });
  await screen.findByRole("dialog", { name: "Tasks" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const diagnostics = await screen.findByRole("menuitem", {
    name: "Troubleshooting",
  });
  diagnostics.focus();
  fireEvent.keyDown(diagnostics, { key: "Enter" });
  const metrics = await screen.findByRole("button", {
    name: "Inspect metrics",
  });
  metrics.focus();
  fireEvent.click(metrics);
  await screen.findByRole("dialog", { name: "Host metrics" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
});
it("releases an old reader without subscribing its stale session on a replacement attachment", async () => {
  const adapter = host(),
    stop = vi.fn();
  adapter.watchSession = vi.fn(() => stop);
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(adapter.watchSession).toHaveBeenCalledOnce());
  const next = {
    ...host(),
    state: { ...adapter.state, sessions: [] },
    watchSession: vi.fn(() => {
      throw new Error("SESSION_NOT_FOUND");
    }),
  };
  expect(() =>
    view.rerender(<WorkspaceLayout host={next} labels={labels} />),
  ).not.toThrow();
  expect(stop).toHaveBeenCalledOnce();
  expect(next.watchSession).not.toHaveBeenCalled();
});
it("returns focus to the adjacent view after deleting the selected tab", async () => {
  render(<WorkspaceLayout host={host()} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  const selected = screen.getByRole("tab", { selected: true });
  selected.focus();
  fireEvent.keyDown(selected, { key: "Delete" });
  expect(screen.getByRole("tab", { selected: true })).toHaveFocus();
});
it("saves the current window layout only on explicit save and keeps later runtime tabs when its receipt arrives", async () => {
  const adapter = host(),
    save = vi.fn().mockResolvedValue(undefined);
  const tools = workbenchToolLabels(createTranslator(en)).layout;
  const view = render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={defaults.workspace}
      toolLabels={tools}
      onSaveWindowLayout={save}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close view" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save current layout" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const snapshot = save.mock
    .calls[0]![0] as import("@serial-workbench/contracts").WorkspaceDocument;
  expect(snapshot.views).toHaveLength(1);
  expect(snapshot.views[0]?.id).toBe("session-session");
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  view.rerender(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={snapshot}
      toolLabels={tools}
      onSaveWindowLayout={save}
    />,
  );
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});
it("clears only the current view and shows new data after the bounded reader trims the cleared marker", async () => {
  const adapter = host();
  const toolLabels = workbenchToolLabels(createTranslator(en)).layout;
  const item = (
    text: string,
    seq: string,
  ): import("@serial-workbench/contracts").StreamItem => ({
    kind: "source",
    event: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      eventSeq: seq,
      configurationRevision: "1",
      time: {
        clockId: "clock",
        sourceMonoNs: seq,
        receivedWallTime: "2026-11-08T00:00:00Z",
        precision: {
          source: "host_read",
          resolutionNs: "1",
          syncMethod: "none",
        },
      },
      kind: "rx",
      payload: {
        bytesBase64: btoa(text),
        byteStart: String(Number(seq) - 1),
        byteEnd: seq,
      },
    },
  });
  adapter.state.streams = new Map([
    [
      "session",
      { items: [item("A", "1"), item("B", "2")], error: null, trimmed: false },
    ],
  ]);
  const view = render(
    <WorkspaceLayout host={adapter} labels={labels} toolLabels={toolLabels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  expect(screen.getByRole("log")).toHaveTextContent("AB");
  fireEvent.click(screen.getByRole("button", { name: "Clear receive view" }));
  expect(screen.getByRole("log")).not.toHaveTextContent("AB");
  adapter.state = {
    ...adapter.state,
    streams: new Map([
      ["session", { items: [item("C", "3")], error: null, trimmed: true }],
    ]),
  };
  view.rerender(
    <WorkspaceLayout host={adapter} labels={labels} toolLabels={toolLabels} />,
  );
  expect(screen.getByText("C")).toBeInTheDocument();
  expect(adapter.refresh).not.toHaveBeenCalled();
  expect(adapter.open).toHaveBeenCalledOnce();
});
it("watches exact send bytes and immediately disables a revoked target while catalog remains unchanged", async () => {
  const adapter = host();
  let publish:
    | ((
        values: readonly import("@/providers/host-context").HostActionAvailability[],
      ) => void)
    | undefined;
  let watched: readonly import("@/providers/host-context").HostActionCheckInput[] =
    [];
  adapter.watchActions = vi.fn<WorkbenchHost["watchActions"]>(
    (inputs, listener) => {
      watched = inputs;
      publish = listener;
      return () => {};
    },
  );
  render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "AT" },
  });
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await waitFor(() =>
    expect(
      watched.find((input) => input.actionId === "session.tx")?.params,
    ).toEqual({ bytesBase64: "QVQ=", writeWaitMs: "1001" }),
  );
  act(() =>
    publish?.(
      watched.map((input) => ({
        input,
        result: {
          actionId: input.actionId,
          target: input.target,
          allowed: true,
        },
        error: null,
      })),
    ),
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  act(() =>
    publish?.(
      watched.map((input) => ({
        input,
        result: {
          actionId: input.actionId,
          target: input.target,
          allowed: false,
        },
        error: null,
      })),
    ),
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(adapter.send).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("AT");
});
it("keeps an unconnected draft when explicitly opening a device", async () => {
  render(<WorkspaceLayout host={host()} labels={labels} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "STATUS?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "STATUS?",
  );
});
it("keeps the disconnected draft editable and receive tools visible without any session", () => {
  const adapter = host();
  adapter.state.sessions = [];
  render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "STATUS?" },
  });
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "STATUS?",
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "Receive" })).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Tasks" }),
  ).not.toBeInTheDocument();
});
it("opens activity on demand and returns focus to its named trigger", async () => {
  render(<WorkspaceLayout host={host()} labels={labels} />);
  const trigger = screen.getByRole("button", { name: "Activity" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Activity" })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
});
it("closing a view only releases its reader while closing the session calls Host and retains the draft", async () => {
  const adapter = host(),
    stop = vi.fn(),
    close = vi.fn().mockResolvedValue(operation());
  adapter.watchSession = vi.fn(() => stop);
  render(
    <WorkspaceLayout host={adapter} labels={labels} onCloseSession={close} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "UNSENT" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close view" }));
  expect(close).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "UNSENT",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  await waitFor(() =>
    expect(close).toHaveBeenCalledWith("session", expect.any(AbortSignal)),
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "UNSENT",
  );
});

it("keeps the close action available while a send is still being accepted", async () => {
  const adapter = host();
  let finish = (_result: ReturnType<typeof operation>) => {};
  adapter.send = vi.fn(
    () =>
      new Promise<ReturnType<typeof operation>>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <WorkspaceLayout host={adapter} labels={labels} onCloseSession={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  const close = await screen.findByRole("button", { name: "Close session" });
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "still pending" },
  });
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).toBeEnabled());
  try {
    fireEvent.click(send);
    await waitFor(() => expect(adapter.send).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: labels.sending })).toBeDisabled();
    expect(close).toBeEnabled();
  } finally {
    await act(async () => finish(operation()));
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
  );
});

it("keeps the actual connection button stable while close authorization is being checked", async () => {
  const adapter = host();
  let publishUnknown = () => {};
  adapter.watchActions = vi.fn<WorkbenchHost["watchActions"]>(
    (inputs, listener) => {
      listener(
        inputs.map((input) => ({
          input,
          result: {
            actionId: input.actionId,
            target: input.target,
            allowed: true,
          },
          error: null,
        })),
      );
      publishUnknown = () =>
        listener(inputs.map((input) => ({ input, result: null, error: null })));
      return () => {};
    },
  );
  render(
    <WorkspaceLayout host={adapter} labels={labels} onCloseSession={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  const connected = await screen.findByRole("button", {
    name: "Close session",
  });
  await waitFor(() => expect(connected).toBeEnabled());
  act(() => publishUnknown());
  expect(screen.getByRole("button", { name: "Close session" })).toBe(connected);
  expect(connected).toBeEnabled();
  expect(connected).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.queryByRole("button", { name: "Open Virtual serial" }),
  ).not.toBeInTheDocument();
  expect(adapter.open).toHaveBeenCalledOnce();
});

it.each([
  ["Restore connection access", "Restoring connection access…", "modify"],
  ["恢复连接访问", "正在恢复连接访问…", "raw"],
] as const)(
  "restores an existing connected view explicitly after confirmed %s denial",
  async (restoreAccess, restoringAccess, source) => {
    const user = userEvent.setup();
    const adapter = host();
    let lastAllowed: boolean | null = true;
    let publish: (allowed: boolean | null) => void = () => {};
    let publishForeign = () => {};
    adapter.watchActions = vi.fn<WorkbenchHost["watchActions"]>(
      (inputs, listener) => {
        publish = (allowed) => {
          lastAllowed = allowed;
          listener(
            inputs.map((input) => ({
              input,
              result:
                allowed === null
                  ? null
                  : { actionId: input.actionId, target: input.target, allowed },
              error: null,
            })),
          );
        };
        publishForeign = () =>
          listener(
            inputs.map((input) => {
              const foreign = {
                ...input,
                target: { ...input.target, sessionEpoch: "999" },
              };
              return {
                input: foreign,
                result: {
                  actionId: foreign.actionId,
                  target: foreign.target,
                  allowed: false,
                },
                error: null,
              };
            }),
          );
        // 输入去抖会重新订阅；夹具保持已确认的权限，不能重新变成允许。
        publish(lastAllowed);
        return () => {};
      },
    );
    const messages = source === "raw" ? zhCN : en;
    const localized = {
      ...labels,
      restoreAccess: messages["workbench.restoreAccess"],
      restoringAccess: messages["workbench.restoringAccess"],
    };
    expect(localized.restoreAccess).toBe(restoreAccess);
    expect(localized.restoringAccess).toBe(restoringAccess);
    const close = vi.fn();
    const content = () => (
      <WorkspaceLayout
        host={adapter}
        labels={localized}
        onCloseSession={close}
      />
    );
    const view = render(content());
    await user.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    const tab = await screen.findByRole("tab", { name: /Virtual serial/ });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close session" }),
      ).toBeEnabled(),
    );
    const draft = screen.getByRole("textbox", { name: "Send input" });
    fireEvent.change(draft, { target: { value: "DO NOT TRANSMIT" } });
    const restore = vi.fn().mockResolvedValue(session());
    adapter.trustedConnect = restore;
    act(() => publish(null));
    const menuTrigger = screen.getByRole("button", { name: "Expand" });
    await user.click(menuTrigger);
    expect(
      screen.queryByRole("menuitem", { name: restoreAccess }),
    ).not.toBeInTheDocument();
    act(() => publishForeign());
    expect(
      screen.queryByRole("menuitem", { name: restoreAccess }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    if (source === "raw") {
      adapter.state = {
        ...adapter.state,
        streams: new Map([
          [
            "session",
            {
              items: [],
              trimmed: false,
              error: new HostRequestError({
                code: "PERMISSION_DENIED",
                message: "read denied",
                retryable: false,
              }),
            },
          ],
        ]),
      };
      view.rerender(content());
    } else act(() => publish(false));
    expect(restore).not.toHaveBeenCalled();
    const connected = screen.getByRole("button", { name: "Close session" });
    expect(connected).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Expand" }));
    const restoreCommand = await screen.findByRole("menuitem", {
      name: restoreAccess,
    });
    await waitFor(() =>
      expect(restoreCommand).not.toHaveAttribute("data-disabled"),
    );
    await user.click(restoreCommand);
    await waitFor(() =>
      expect(restore).toHaveBeenCalledExactlyOnceWith(
        "device",
        expect.any(AbortSignal),
        session().configuration,
      ),
    );
    expect(screen.getByRole("tab", { name: /Virtual serial/ })).toBe(tab);
    expect(screen.getByRole("textbox", { name: "Send input" })).toBe(draft);
    expect(draft).toHaveValue("DO NOT TRANSMIT");
    expect(adapter.send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);

it.each(["readonly", "closed", "SOURCE_ENDED"] as const)(
  "does not offer access restoration for %s",
  async (reason) => {
    const adapter = host();
    const props = { host: adapter, labels, onCloseSession: vi.fn() };
    const view = render(<WorkspaceLayout {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Virtual serial" }),
    );
    await screen.findByRole("tab", { name: /Virtual serial/ });
    adapter.trustedConnect = vi.fn().mockResolvedValue(session());
    adapter.watchActions = vi.fn<WorkbenchHost["watchActions"]>(
      (inputs, listener) => {
        listener(
          inputs.map((input) => ({
            input,
            result: {
              actionId: input.actionId,
              target: input.target,
              allowed: false,
            },
            error: null,
          })),
        );
        return () => {};
      },
    );
    adapter.state = {
      ...adapter.state,
      sessions: adapter.state.sessions.map((value) =>
        value.sessionId !== "session"
          ? value
          : {
              ...value,
              ...(reason === "readonly"
                ? { readOnly: true }
                : reason === "closed"
                  ? { state: "closed" as const }
                  : {}),
            },
      ),
      streams:
        reason === "SOURCE_ENDED"
          ? new Map([
              [
                "session",
                {
                  items: [],
                  trimmed: false,
                  error: new HostRequestError({
                    code: "SOURCE_ENDED",
                    message: "source ended",
                    retryable: false,
                  }),
                },
              ],
            ])
          : adapter.state.streams,
    };
    view.rerender(<WorkspaceLayout {...props} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Expand" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.queryByRole("menuitem", { name: labels.restoreAccess }),
    ).not.toBeInTheDocument();
    expect(adapter.trustedConnect).not.toHaveBeenCalled();
  },
);

it("does not recreate action observations when metadata republishes the same session target", async () => {
  const adapter = host();
  const close = vi.fn();
  const view = render(
    <WorkspaceLayout host={adapter} labels={labels} onCloseSession={close} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("button", { name: "Close session" });
  const count = vi.mocked(adapter.watchActions).mock.calls.length;
  adapter.state = {
    ...adapter.state,
    devices: adapter.state.devices.map((device) => ({ ...device })),
    sessions: adapter.state.sessions.map((value) => ({ ...value })),
  };
  view.rerender(
    <WorkspaceLayout host={adapter} labels={labels} onCloseSession={close} />,
  );
  expect(adapter.watchActions).toHaveBeenCalledTimes(count);
});
it("reports a failed replay import without guessing a device connection diagnosis", async () => {
  render(
    <WorkspaceLayout
      host={host()}
      labels={labels}
      formatError={() => "Recording file is corrupt"}
      onOpenReplay={vi.fn().mockRejectedValue(
        new HostRequestError({
          code: "CAPTURE_CORRUPT",
          message:
            "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
          retryable: false,
        }),
      )}
    />,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Expand" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Open replay" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recording file is corrupt",
  );
  expect(
    screen.queryByText(/EXPLICIT_FIXTURE_SECRET|cargo run|C:\/private/),
  ).not.toBeInTheDocument();
});
it("follows a new replay result when its real session arrives after admission", () => {
  const adapter = host();
  const replay = { read: vi.fn(), readRecord: vi.fn(), control: vi.fn() };
  const view = render(
    <WorkspaceLayout host={adapter} labels={labels} replay={replay} />,
  );
  const queued = {
    ...operation("replay"),
    actionId: "replay.open",
    state: "queued" as const,
    revealTarget: { pageId: "workbench" },
  };
  adapter.state = {
    ...adapter.state,
    operations: [queued],
    operationSummaries: [queued],
  };
  view.rerender(
    <WorkspaceLayout host={adapter} labels={labels} replay={replay} />,
  );
  const settled = {
    ...queued,
    state: "succeeded" as const,
    revision: "2",
    result: {
      kind: "opened" as const,
      value: {
        sessionId: "session",
        sessionEpoch: "1",
        revision: "1",
        reused: false,
      },
    },
  };
  adapter.state = {
    ...adapter.state,
    operations: [settled],
    operationSummaries: [settled],
  };
  view.rerender(
    <WorkspaceLayout host={adapter} labels={labels} replay={replay} />,
  );
  expect(
    screen.getByRole("button", { name: "Read replay" }),
  ).toBeInTheDocument();
  expect(adapter.watchSession).not.toHaveBeenCalled();
});
function host(): WorkbenchHost {
  return {
    state: {
      status: "ready",
      error: null,
      devices: [
        {
          deviceId: "device",
          hostId: "host",
          systemName: "Virtual serial",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          capabilities: session().capabilities,
        },
      ],
      sessions: [session(), { ...session("other"), deviceId: "other-device" }],
      operations: [],
      operationSummaries: [],
      operationSummariesReady: true,
      streams: new Map(),
      catalog: actionCatalog,
      devicesStale: false,
    },
    checkAction: vi.fn(
      async (
        input: import("@/providers/host-context").HostActionCheckInput,
      ) => ({ actionId: input.actionId, target: input.target, allowed: true }),
    ),
    watchActions: vi.fn((inputs, listener) => {
      listener(
        inputs.map(
          (input: import("@/providers/host-context").HostActionCheckInput) => ({
            input,
            result: {
              actionId: input.actionId,
              target: input.target,
              allowed: true,
            },
            error: null,
          }),
        ),
      );
      return () => {};
    }),
    open: vi.fn().mockResolvedValue(session()),
    send: vi.fn().mockResolvedValue(operation()),
    takeover: vi.fn().mockResolvedValue(operation()),
    refresh: vi.fn().mockResolvedValue(undefined),
    watchSession: vi.fn(() => () => {}),
  };
}
it("explicitly authorizes the existing session once and adds a second tab without reader churn", async () => {
  const adapter = host();
  render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  await screen.findByRole("tab", { name: /Virtual serial/ });
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Receive" })).getByRole("radio", {
      name: "HEX",
    }),
  );
  expect(adapter.open).toHaveBeenCalledTimes(1);
  expect(adapter.watchSession).toHaveBeenCalledTimes(1);
});
it("opening a device then adding a second view makes exactly one Host open", async () => {
  const adapter = host();
  adapter.state.sessions = [];
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  await waitFor(() => expect(adapter.open).toHaveBeenCalledTimes(1));
  adapter.state = { ...adapter.state, sessions: [session()] };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  await screen.findByRole("tab", { name: /Virtual serial/ });
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(adapter.open).toHaveBeenCalledTimes(1);
});
it("keeps capture progress live when receive rendering is frozen and disables read-only controls", async () => {
  const adapter = host();
  adapter.state.operationSummaries = [
    {
      ...operation("capture"),
      actionId: "capture.start",
      state: "running",
      progress: { completed: "4", unit: "bytes" },
    },
  ];
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  locateActivity("Locate capture");
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  adapter.state = {
    ...adapter.state,
    sessions: adapter.state.sessions.map((value) => ({
      ...value,
      readOnly: true,
    })),
    operationSummaries: [
      {
        ...adapter.state.operationSummaries[0]!,
        revision: "2",
        progress: { completed: "8", unit: "bytes" },
      },
    ],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  expect(
    within(screen.getByRole("region", { name: "Capture" })).getByText("8 B"),
  ).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
});
it("activity navigation preserves drafts and an old operation update cannot steal a newer selection", async () => {
  const adapter = host();
  const first = operation("a");
  adapter.state.operationSummaries = [first];
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  locateActivity(/Locate a/);
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "unsent command" },
  });
  const newer = operation("b", "other");
  adapter.state = { ...adapter.state, operationSummaries: [first, newer] };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  locateActivity(/Locate b/);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("");
  adapter.state = {
    ...adapter.state,
    operationSummaries: [{ ...first, revision: "2", state: "failed" }, newer],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    labels.sessionLabel,
  );
  locateActivity(/Locate a/);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "unsent command",
  );
});
it("pairs every StrictMode reader watch with cleanup without a second device sidebar", async () => {
  const adapter = host();
  const stop = vi.fn();
  adapter.watchSession = vi.fn(() => stop);
  const view = render(
    <StrictMode>
      <WorkspaceLayout host={adapter} labels={labels} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  await waitFor(() => expect(adapter.watchSession).toHaveBeenCalled());
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(
    vi.mocked(adapter.watchSession).mock.calls.length,
  );
});
it("releases the previous attachment reader before watching a replacement Host", async () => {
  const adapter = host();
  const stopOld = vi.fn();
  const stopNew = vi.fn();
  adapter.watchSession = vi.fn(() => stopOld);
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  await screen.findByRole("tab", { name: /Virtual serial/ });
  const replacement = { ...adapter, watchSession: vi.fn(() => stopNew) };
  view.rerender(<WorkspaceLayout host={replacement} labels={labels} />);
  expect(stopOld).toHaveBeenCalledTimes(1);
  expect(replacement.watchSession).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stopNew).toHaveBeenCalledTimes(1);
});
it("does not move selection when an earlier open completes after explicit activity navigation", async () => {
  const adapter = host();
  adapter.state.sessions = [{ ...session("other"), deviceId: "other-device" }];
  adapter.state.operationSummaries = [operation("other-operation", "other")];
  let finish!: (value: ReturnType<typeof session>) => void;
  adapter.open = vi.fn(
    () =>
      new Promise<ReturnType<typeof session>>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  locateActivity("Locate other-operation");
  adapter.state = {
    ...adapter.state,
    sessions: [...adapter.state.sessions, session()],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  await act(async () => finish(session()));
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    labels.sessionLabel,
  );
});
it("restores named colored views as configuration without opening or subscribing", () => {
  const adapter = host();
  adapter.state.operationSummaries = [operation("historical-operation")];
  const workspace: WorkspaceDocument = {
    name: "Bench",
    layout: { sidebarWidth: 280, panelHeight: 240 },
    captures: [],
    favoriteBindingIds: [],
    bindings: [
      {
        bindingId: "binding",
        hostId: "host",
        deviceId: "device",
        fingerprint: { transport: "virtual", evidence: "unreliable" },
        configuration: session().configuration,
        reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
      },
    ],
    views: [
      {
        id: "view-1",
        name: "Motor controller",
        color: "#2266aa",
        icon: "terminal",
        pinned: false,
        receiveMode: "hex",
        sendMode: "hex",
        bindingId: "binding",
      },
    ],
  };
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={workspace}
    />,
  );
  expect(
    screen.getByRole("tab", { name: "Motor controller" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  expect(adapter.open).not.toHaveBeenCalled();
  expect(adapter.watchSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  expect(
    screen.getByRole("tab", { name: "Motor controller", selected: true }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "Receive" })).getByRole("radio", {
      name: "HEX",
    }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
});
it("restores client drafts without sending and keeps duplicate views independent", async () => {
  const adapter = host();
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialDrafts={{ "session-session": "STATUS?" }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  await screen.findByRole("tab", { name: "Virtual serial" });
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "STATUS?",
  );
  expect(adapter.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "VERSION?" },
  });
  fireEvent.click(screen.getAllByRole("tab")[0]!);
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "STATUS?",
  );
});
it("does not follow a previously unseen old result after a newer activity", () => {
  const adapter = host();
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  const newer = {
    ...operation("newer", "other"),
    acceptedAt: "2026-11-08T00:01:00Z",
  };
  adapter.state = { ...adapter.state, operationSummaries: [newer] };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    labels.sessionLabel,
  );
  adapter.state = {
    ...adapter.state,
    operationSummaries: [newer, operation("older", "session")],
  };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
    labels.sessionLabel,
  );
});
it("does not open devices while the Host is unavailable", () => {
  const adapter = host();
  adapter.state = {
    ...adapter.state,
    status: "error",
    catalog: [],
    sessions: [],
  };
  render(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(
    screen.getByRole("button", { name: /Open Virtual serial/ }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Open Virtual serial/ }));
  expect(adapter.open).not.toHaveBeenCalled();
});
it("allows an explicit trusted connection from metadata-only mode without enabling ordinary sends", async () => {
  const adapter = host();
  adapter.state = { ...adapter.state, catalog: [], sessions: [] };
  adapter.trustedConnect = vi.fn().mockResolvedValue(session());
  const view = render(<WorkspaceLayout host={adapter} labels={labels} />);
  const button = screen.getByRole("button", { name: "Open Virtual serial" });
  expect(button).toBeEnabled();
  expect(adapter.trustedConnect).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(adapter.trustedConnect).toHaveBeenCalledWith(
      "device",
      expect.any(AbortSignal),
      defaults.serialConfiguration,
    ),
  );
  expect(adapter.open).not.toHaveBeenCalled();
  adapter.state = { ...adapter.state, sessions: [session()] };
  view.rerender(<WorkspaceLayout host={adapter} labels={labels} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});
it("locates a safe MCP summary while operation details remain unavailable", () => {
  const adapter = host();
  const source = operation("safe-summary");
  adapter.state.operationSummaries = [
    {
      operationId: source.operationId,
      executionHostId: source.executionHostId,
      actorId: "mcp",
      actionId: source.actionId,
      target: source.target,
      executionMode: source.executionMode,
      state: "running",
      revision: "1",
      acceptedAt: source.acceptedAt,
      revealTarget: source.revealTarget,
      progress: { completed: "10", unit: "bytes" },
    },
  ];
  render(<WorkspaceLayout host={adapter} labels={labels} />);
  locateActivity("Locate safe-summary");
  expect(
    screen.getByRole("textbox", { name: "Send input" }),
  ).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Expand" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Tasks" }));
  expect(
    within(screen.getByRole("region", { name: "Tasks" })).getByText(
      "No operations",
    ),
  ).toBeInTheDocument();
});
it("uses the replay reader for a real replay.open result without opening a serial reader", async () => {
  const adapter = host();
  const opened = {
    ...operation("replay"),
    actionId: "replay.open",
    result: {
      kind: "opened" as const,
      value: {
        sessionId: "session",
        sessionEpoch: "1",
        revision: "1",
        reused: false,
      },
    },
  };
  adapter.state.operations = [opened];
  adapter.state.operationSummaries = [opened];
  const replay = {
    read: vi.fn().mockResolvedValue({
      records: [],
      readerGeneration: "1",
      nextRecord: "0",
      atEnd: true,
    }),
    readRecord: vi.fn(),
    control: vi.fn(),
  };
  render(<WorkspaceLayout host={adapter} labels={labels} replay={replay} />);
  locateActivity("Locate replay");
  expect(adapter.watchSession).not.toHaveBeenCalled();
  expect(replay.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Read replay" }));
  await screen.findByText("End reached");
});

function locateActivity(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  fireEvent.click(screen.getByRole("button", { name }));
}

it("restores isolated readonly capture tabs without connecting or overwriting the local draft", async () => {
  const adapter = host();
  const reference = {
    hostId: "host",
    kind: "capture",
    id: "saved",
    revision: "1",
  };
  const document = { ...defaults.workspace, views: [], captures: [reference] };
  const view = render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      workspaceKey="pending"
      initialDrafts={{ unconnected: "keep draft" }}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Send input" });
  input.focus();
  view.rerender(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      workspaceKey="loaded"
      initialDrafts={{ unconnected: "keep draft" }}
      initialWorkspace={document}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "keep draft",
  );
  expect(input).toHaveFocus();
  const capture = screen.getByRole("tab", { name: /Recording 1/ });
  fireEvent.click(capture);
  expect(
    screen.getByRole("textbox", { name: "Send input" }),
  ).not.toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "New view" })).toBeDisabled();
  expect(adapter.open).not.toHaveBeenCalled();
  expect(adapter.send).not.toHaveBeenCalled();
});

it("associates only this window's capture operation and saves refs separately from device views", async () => {
  const adapter = host();
  const ref = { hostId: "host", kind: "capture", id: "saved", revision: "2" };
  const capture = {
    ...operation("mine"),
    actionId: "capture.start",
    state: "running" as const,
  };
  const start = vi.fn().mockResolvedValue(capture);
  const save = vi.fn().mockResolvedValue(undefined);
  const props = {
    host: adapter,
    labels,
    initialWorkspace: { ...defaults.workspace, views: [], captures: [] },
    workspaceKey: "one",
    onStartCapture: start,
    onSaveWindowLayout: save,
  };
  const view = render(<WorkspaceLayout {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await screen.findByRole("tab", { name: /Virtual serial/ });
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  adapter.state = {
    ...adapter.state,
    operations: [
      { ...capture, result: { kind: "reference", value: { resultRef: ref } } },
    ],
  };
  view.rerender(<WorkspaceLayout {...props} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await screen.findByRole("tab", { name: /Recording 1/ });
  const saveButton = screen.getAllByRole("button", { name: "Save drafts" })[0]!;
  fireEvent.click(saveButton);
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const value = save.mock.calls[0]![0] as WorkspaceDocument;
  expect(value.captures).toEqual([ref]);
  expect(value.views).toHaveLength(1);
  expect(value.views[0]?.id).not.toContain("capture/");
  view.unmount();
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={value}
      workspaceKey="one"
    />,
  );
  expect(screen.getByRole("tab", { name: /Recording 1/ })).toBeInTheDocument();
});

it("keeps an initial unbound draft editable when a restored document has only captures", () => {
  const document = {
    ...defaults.workspace,
    views: [],
    captures: [{ hostId: "host", kind: "capture", id: "unconnected" }],
  };
  render(
    <WorkspaceLayout
      host={host()}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ unconnected: "local text" }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "local text",
  );
  expect(
    screen.getByRole("textbox", { name: "Send input" }),
  ).not.toHaveAttribute("readonly");
});

it("keeps capture and Host view ids in separate draft namespaces", () => {
  const document = {
    ...defaults.workspace,
    views: [
      {
        id: "same",
        name: "Device view",
        color: "#2266aa",
        icon: "terminal",
        pinned: false,
        receiveMode: "text" as const,
        sendMode: "text" as const,
        bindingId: "binding",
      },
    ],
    captures: [{ hostId: "host", kind: "capture", id: "same" }],
  };
  render(
    <WorkspaceLayout
      host={host()}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ same: "device draft" }}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue("");
  expect(
    screen.getByRole("textbox", { name: "Send input" }),
  ).not.toHaveAttribute("readonly");
  fireEvent.click(screen.getByRole("tab", { name: /Device view/ }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "device draft",
  );
});

it("invalidates the restored capture tail when only the workspace document revision advances", async () => {
  const adapter = host();
  const reference = {
    hostId: "host",
    kind: "capture",
    id: "revision-tail",
    revision: "1",
  };
  const pending: {
    signal?: AbortSignal;
    resolve: (
      value: import("@serial-workbench/contracts").CaptureTailResult,
    ) => void;
  }[] = [];
  const read = vi.fn(
    (_reference: unknown, signal?: AbortSignal) =>
      new Promise<import("@serial-workbench/contracts").CaptureTailResult>(
        (resolve) => pending.push({ signal, resolve }),
      ),
  );
  const props = {
    host: adapter,
    labels,
    initialWorkspace: {
      ...defaults.workspace,
      views: [],
      captures: [reference],
    },
    workspaceKey: "same-target",
    workspaceSelection: 0,
    readCaptureTail: read,
  };
  const view = render(<WorkspaceLayout {...props} workspaceRevision="1" />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender(<WorkspaceLayout {...props} workspaceRevision="2" />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(pending[0]?.signal?.aborted).toBe(true);
  const tail = {
    captureRef: reference,
    state: "complete" as const,
    verifiedPrefix: "0",
    firstRecord: "1",
    containerComplete: true,
    sourceContinuous: true,
    records: [],
  };
  await act(async () => {
    pending[0]!.resolve({ ...tail, sourceFingerprint: "a".repeat(64) });
    pending[1]!.resolve({ ...tail, sourceFingerprint: "b".repeat(64) });
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: labels.captureTail + " · " + labels.expand,
    }),
  );
  const details = await screen.findByRole("dialog", {
    name: labels.captureTail,
  });
  expect(within(details).getByText("b".repeat(64))).toBeVisible();
  expect(within(details).queryByText("a".repeat(64))).not.toBeInTheDocument();
});

it("shares the existing unconnected draft owner across capture tabs without changing a same-named device draft", async () => {
  const adapter = host();
  const save = vi.fn().mockResolvedValue(undefined);
  const document = {
    ...defaults.workspace,
    views: [
      {
        id: "unconnected",
        name: "Device view",
        bindingId: "binding",
        color: "#2266aa",
        icon: "terminal",
        pinned: false,
        receiveMode: "text" as const,
        sendMode: "text" as const,
      },
    ],
    captures: [
      { hostId: "host", kind: "capture", id: "x".repeat(128), revision: "1" },
      { hostId: "host", kind: "capture", id: "another", revision: "1" },
    ],
  };
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      initialWorkspace={document}
      initialDrafts={{ unconnected: "UNBOUND", "view/unconnected": "DEVICE" }}
      onSaveDrafts={save}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  const input = screen.getByRole("textbox", { name: "Send input" });
  expect(input).toHaveValue("UNBOUND");
  expect(input).not.toHaveAttribute("readonly");
  expect(screen.getByText("Unconnected draft")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "41" } });
  const sender = screen.getByRole("region", { name: "Send" });
  fireEvent.click(within(sender).getByRole("radio", { name: "HEX" }));
  fireEvent.keyDown(
    within(sender).getByRole("combobox", { name: "Line ending" }),
    { key: "Enter" },
  );
  fireEvent.keyDown(screen.getByRole("option", { name: "CRLF" }), {
    key: "Enter",
  });
  fireEvent.click(screen.getByRole("tab", { name: /Recording 2/ }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "34 31",
  );
  expect(within(sender).getByRole("radio", { name: "HEX" })).toBeChecked();
  expect(
    within(sender).getByRole("combobox", { name: "Line ending" }),
  ).toHaveTextContent("CRLF");
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("4 B");
  expect(
    screen.queryByRole("button", { name: /^Byte preview:/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send file" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Send input" }), {
    key: "Enter",
    ctrlKey: true,
  });
  fireEvent.click(
    screen
      .getAllByRole("button", { name: "Save drafts" })
      .find((button) => !button.hasAttribute("disabled"))!,
  );
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { unconnected: "34 31", "view/unconnected": "DEVICE" },
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Device view" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "DEVICE",
  );
  expect(
    within(screen.getByRole("region", { name: "Send" })).getByRole("radio", {
      name: "Text",
    }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("tab", { name: "Send input" }));
  expect(screen.getByRole("textbox", { name: "Send input" })).toHaveValue(
    "34 31",
  );
  expect(
    within(screen.getByRole("region", { name: "Send" })).getByRole("radio", {
      name: "HEX",
    }),
  ).toBeChecked();
  expect(adapter.send).not.toHaveBeenCalled();
  expect(adapter.open).not.toHaveBeenCalled();
});

it("keeps capture draft saving directly reachable while disclosing its layout blocker nearby", async () => {
  const adapter = host(),
    save = vi.fn().mockResolvedValue(undefined),
    layoutSave = vi.fn();
  const blocker =
    "Connect before saving this layout; the unconnected draft can be saved separately.";
  const tools = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={tools}
      initialWorkspace={{
        ...defaults.workspace,
        views: [],
        captures: [
          {
            hostId: "host",
            kind: "capture",
            id: "compact-draft",
            revision: "1",
          },
        ],
      }}
      initialDrafts={{ unconnected: "UNBOUND" }}
      onSaveDrafts={save}
      onSaveWindowLayout={layoutSave}
      unboundDraftMessage={blocker}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  expect(screen.queryByText(blocker)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Send input" }), {
    target: { value: "EDIT KEPT" },
  });
  const saveButton = screen.getByRole("button", { name: "Save drafts" });
  expect(saveButton).toBeEnabled();
  expect(saveButton).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save current layout" }),
  ).toBeDisabled();
  const trigger = within(
    screen.getByRole("region", { name: "Send" }),
  ).getByRole("button", { name: /Unconnected draft · Save current layout/ });
  expect(trigger).toHaveAccessibleName(/Save current layout/);
  expect(trigger).toHaveAccessibleName(/Unconnected draft/);
  expect(trigger).toHaveAccessibleName(/Expand/);
  fireEvent.click(trigger);
  const details = await screen.findByRole("dialog", {
    name: labels.unconnectedDraft,
  });
  expect(within(details).getByText(blocker)).toBeVisible();
  fireEvent.keyDown(details, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  fireEvent.click(saveButton);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { unconnected: "EDIT KEPT" },
      expect.any(AbortSignal),
    ),
  );
  expect(layoutSave).not.toHaveBeenCalled();
  expect(adapter.send).not.toHaveBeenCalled();
  expect(adapter.open).not.toHaveBeenCalled();
});

it("keeps the capture draft disclosure named while using a compact icon", () => {
  render(
    <WorkspaceLayout
      host={host()}
      labels={labels}
      initialWorkspace={{
        ...defaults.workspace,
        views: [],
        captures: [
          { hostId: "host", kind: "capture", id: "fallback", revision: "1" },
        ],
      }}
      initialDrafts={{ unconnected: "UNBOUND" }}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  const trigger = within(
    screen.getByRole("region", { name: "Send" }),
  ).getByRole("button", { name: /Unconnected draft/ });
  expect(trigger).toHaveTextContent("");
  expect(trigger).toHaveAccessibleName(/Save drafts/);
});

it("keeps capture Host failures visible while retaining device-status facts in the draft disclosure", async () => {
  const adapter = host(),
    tools = workbenchToolLabels(createTranslator(en)).layout;
  adapter.state = {
    ...adapter.state,
    status: "error",
    error: new Error("private host failure"),
    devices: [],
    devicesStale: true,
  };
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={tools}
      initialWorkspace={{
        ...defaults.workspace,
        views: [],
        captures: [
          {
            hostId: "host",
            kind: "capture",
            id: "failure-layout",
            revision: "1",
          },
        ],
      }}
      initialDrafts={{ unconnected: "UNBOUND" }}
      onSaveDrafts={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    labels.unavailable,
  );
  expect(screen.getByRole("alert")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Unconnected draft · Save current layout · Expand",
    }),
  );
  const details = await screen.findByRole("dialog", {
    name: labels.unconnectedDraft,
  });
  expect(within(details).getByText(labels.noDevices)).toBeVisible();
  expect(within(details).getByText(tools.deviceListStale)).toBeVisible();
  fireEvent.keyDown(details, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save drafts" })).toBeVisible();
  expect(adapter.send).not.toHaveBeenCalled();
  expect(adapter.open).not.toHaveBeenCalled();
});

it("compacts only the disabled capture close control after a real connection and keeps the device action unchanged", async () => {
  const adapter = host(),
    connected = session(),
    close = vi.fn().mockResolvedValue(operation("close"));
  adapter.state = { ...adapter.state, sessions: [] };
  adapter.open = vi.fn(async () => {
    adapter.state = { ...adapter.state, sessions: [connected] };
    return connected;
  });
  const tools = workbenchToolLabels(createTranslator(en)).layout;
  render(
    <WorkspaceLayout
      host={adapter}
      labels={labels}
      toolLabels={tools}
      initialWorkspace={{
        ...defaults.workspace,
        views: [],
        captures: [
          {
            hostId: "host",
            kind: "capture",
            id: "connection-chrome",
            revision: "1",
          },
        ],
      }}
      initialDrafts={{ unconnected: "UNBOUND" }}
      onCloseSession={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Virtual serial" }));
  await waitFor(() => expect(adapter.open).toHaveBeenCalledOnce());
  const deviceTab = await screen.findByRole("tab", { name: "Virtual serial" });
  expect(deviceTab).toHaveAttribute("aria-selected", "true");
  const deviceClose = screen.getByRole("button", { name: "Close session" });
  expect(deviceClose).not.toHaveTextContent("Close session");
  expect(deviceClose).toBeEnabled();
  fireEvent.click(screen.getByRole("tab", { name: /Recording 1/ }));
  const captureClose = screen.getByRole("button", { name: "Close session" });
  expect(captureClose).toBeDisabled();
  expect(captureClose).toHaveAccessibleName("Close session");
  expect(captureClose).not.toHaveTextContent("Close session");
  expect(
    screen.getByRole("button", {
      name: "Connection parameters",
    }),
  ).toBeDisabled();
  expect(screen.queryByText("115200 / 8N1")).not.toBeInTheDocument();
  fireEvent.click(captureClose);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(deviceTab);
  const returnedClose = screen.getByRole("button", { name: "Close session" });
  expect(returnedClose).toBeEnabled();
  expect(returnedClose).not.toHaveTextContent("Close session");
  fireEvent.click(returnedClose);
  await waitFor(() =>
    expect(close).toHaveBeenCalledWith(
      connected.sessionId,
      expect.any(AbortSignal),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(adapter.send).not.toHaveBeenCalled();
});
