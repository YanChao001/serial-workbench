import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
import type { WorkspaceDocumentResult } from "@serial-workbench/contracts";
import {
  UnsavedWorkContext,
  type UnsavedWork,
} from "@/providers/unsaved-work-context";
import { DeviceLibrary, type DeviceLibraryProps } from "./device-library";
import {
  device,
  deviceLabels,
  deviceRebound,
  favoriteSaved,
  workspace,
} from "./device-library.test-fixtures";
import { session } from "./test-fixtures";

afterEach(cleanup);
beforeEach(() => {
  render(<Toaster />);
});
function renderFavorites(content: ReactNode) {
  const view = render(content);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Favorites" }), {
    key: "Enter",
  });
  return {
    ...view,
    rerender(content: ReactNode) {
      view.rerender(content);
      fireEvent.keyDown(screen.getByRole("tab", { name: "Favorites" }), {
        key: "Enter",
      });
    },
  };
}

function pendingResult() {
  let resolve!: (result: WorkspaceDocumentResult) => void;
  const promise = new Promise<WorkspaceDocumentResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function props(): DeviceLibraryProps {
  return {
    devices: [device(), device("device-b")],
    workspace: workspace(),
    labels: deviceLabels,
  };
}
function registry() {
  const work = new Map<string, UnsavedWork>();
  const value = {
    requestLeave: async () => true,
    releaseScope: () => {},
    register: (item: UnsavedWork) => {
      work.set(item.id, item);
    },
    unregister: (id: string) => {
      work.delete(id);
    },
  };
  return { work, value };
}
function choose(deviceId = "device-a") {
  const tab = screen.getByRole("tab", { name: "Favorites" });
  if (tab.getAttribute("aria-selected") !== "true")
    fireEvent.keyDown(tab, { key: "Enter" });
  const select = screen.getByRole("combobox", {
    name: "Choose a device explicitly Binding 1",
  });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const option = screen.getByRole("option", {
    name: deviceId === "device-a" ? "COM9 · serial-42" : "COM2 · serial-42",
  });
  option.focus();
  fireEvent.keyDown(option, { key: "Enter" });
}

it("retains an unsubmitted rebind through CAS conflicts until the document is acknowledged", async () => {
  const { work, value } = registry();
  const result = pendingResult();
  const onRebindDevice = vi
    .fn()
    .mockRejectedValueOnce({
      code: "REVISION_CONFLICT",
      message: "Workspace changed",
    })
    .mockReturnValueOnce(result.promise);
  const onAcknowledged = vi.fn();
  renderFavorites(
    <UnsavedWorkContext.Provider value={value}>
      <DeviceLibrary
        {...props()}
        onRebindDevice={onRebindDevice}
        onAcknowledged={onAcknowledged}
      />
    </UnsavedWorkContext.Provider>,
  );
  choose();
  expect([...work.values()].some((item) => item.dirty)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "REVISION_CONFLICT",
  );
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("COM9");
  fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
  await waitFor(() => expect(onRebindDevice).toHaveBeenCalledTimes(2));
  expect([...work.values()].some((item) => item.dirty)).toBe(true);
  expect(onAcknowledged).not.toHaveBeenCalled();
  await act(async () => result.resolve(deviceRebound()));
  expect(screen.getByText("Binding 1 · COM9")).toBeVisible();
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("Choose a device explicitly");
  expect([...work.values()].some((item) => item.dirty)).toBe(false);
  expect(onAcknowledged).toHaveBeenCalledWith(deviceRebound());
});

it("uses a selectable device list and shows only relevant reported facts", () => {
  render(
    <DeviceLibrary
      devices={[
        device(),
        {
          ...device("device-b"),
          manufacturer: undefined,
          driver: undefined,
          fingerprint: { transport: "serial", evidence: "unreliable" },
        },
      ]}
      labels={deviceLabels}
    />,
  );
  expect(screen.getByText("driver-v1")).toBeVisible();
  expect(screen.getByText("serial-42")).toBeVisible();
  expect(screen.queryByText("Not reported")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "COM2" }));
  expect(screen.getByText("Cannot uniquely identify")).toBeVisible();
  expect(screen.queryByText("driver-v1")).toBeNull();
});

it("never guesses an ambiguous candidate and only submits the explicitly confirmed rebind", async () => {
  const onRebindDevice = vi.fn().mockResolvedValue(deviceRebound("device-b"));
  const base = props();
  renderFavorites(<DeviceLibrary {...base} onRebindDevice={onRebindDevice} />);
  const action = screen.getByRole("button", { name: "Rebind Binding 1" });
  expect(action).toBeDisabled();
  expect(onRebindDevice).not.toHaveBeenCalled();
  choose("device-b");
  expect(onRebindDevice).not.toHaveBeenCalled();
  fireEvent.click(action);
  await screen.findByText("Binding 1 · COM2");
  expect(onRebindDevice).toHaveBeenCalledWith(
    base.workspace,
    { bindingId: "probe", deviceId: "device-b" },
    expect.any(AbortSignal),
  );
});

it("keeps Host history separate and uses readable device and parameter summaries", () => {
  const onSaveFavorites = vi.fn();
  const onRebindDevice = vi.fn();
  renderFavorites(
    <DeviceLibrary
      {...props()}
      devices={[]}
      recent={{
        revision: "4",
        entries: [
          {
            deviceId: "missing-device",
            openedAt: "2026-11-07T12:00:00Z",
            fingerprint: {
              transport: "serial",
              evidence: "topology",
              topologyPath: "old-usb-path",
            },
            configuration: session().configuration,
          },
        ],
      }}
      onSaveFavorites={onSaveFavorites}
      onRebindDevice={onRebindDevice}
    />,
  );
  expect(
    screen.getByText("Binding 1 · Offline device · Disconnected"),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Recent connections" }), {
    key: "Enter",
  });
  expect(screen.getByText("Offline device 1")).toBeVisible();
  expect(screen.queryByText("missing-device")).toBeNull();
  expect(screen.getByLabelText("Requested configuration")).toHaveTextContent(
    "115200 / 8N1",
  );
  expect(screen.queryByRole("button", { name: "Refresh recent" })).toBeNull();
  expect(onSaveFavorites).not.toHaveBeenCalled();
  expect(onRebindDevice).not.toHaveBeenCalled();
});

it("waits for a real favorite document and uses its revision for the next explicit save", async () => {
  const result = pendingResult();
  const onSaveFavorites = vi
    .fn()
    .mockReturnValueOnce(result.promise)
    .mockResolvedValueOnce(workspace());
  const onAcknowledged = vi.fn();
  const base = props();
  renderFavorites(
    <DeviceLibrary
      {...base}
      onSaveFavorites={onSaveFavorites}
      onAcknowledged={onAcknowledged}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  );
  await waitFor(() => expect(onSaveFavorites).toHaveBeenCalledOnce());
  expect(onSaveFavorites).toHaveBeenCalledWith(
    base.workspace,
    { bindingIds: [] },
    expect.any(AbortSignal),
  );
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeDisabled();
  expect(onAcknowledged).not.toHaveBeenCalled();
  await act(async () => result.resolve(favoriteSaved()));
  fireEvent.click(
    screen.getByRole("button", { name: "Add favorite Binding 1" }),
  );
  await waitFor(() => expect(onSaveFavorites).toHaveBeenCalledTimes(2));
  expect(onSaveFavorites.mock.calls[1]?.[0].document.revision).toBe("8");
  expect(onSaveFavorites.mock.calls[1]?.[1]).toEqual({ bindingIds: ["probe"] });
});

it("gates each intent on its callback and explicit disabled context", () => {
  const base = props();
  const onSaveFavorites = vi.fn().mockResolvedValue(favoriteSaved());
  const onRebindDevice = vi.fn().mockResolvedValue(deviceRebound());
  const view = renderFavorites(<DeviceLibrary {...base} />);
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeDisabled();
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toBeDisabled();
  view.rerender(<DeviceLibrary {...base} onSaveFavorites={onSaveFavorites} />);
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeEnabled();
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toBeDisabled();
  view.rerender(
    <DeviceLibrary
      {...base}
      onSaveFavorites={onSaveFavorites}
      onRebindDevice={onRebindDevice}
      disabled
    />,
  );
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeDisabled();
  view.rerender(<DeviceLibrary {...base} onRebindDevice={onRebindDevice} />);
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeDisabled();
  choose();
  expect(
    screen.getByRole("button", { name: "Rebind Binding 1" }),
  ).toBeEnabled();
  view.rerender(
    <DeviceLibrary
      {...base}
      workspace={undefined}
      onSaveFavorites={onSaveFavorites}
      onRebindDevice={onRebindDevice}
    />,
  );
  expect(screen.getByText("No workspace bindings")).toBeVisible();
  expect(onSaveFavorites).not.toHaveBeenCalled();
  expect(onRebindDevice).not.toHaveBeenCalled();
});

it("preserves a newer rebind selection while acknowledging the submitted document", async () => {
  const result = pendingResult();
  const onRebindDevice = vi
    .fn()
    .mockReturnValueOnce(result.promise)
    .mockResolvedValueOnce(deviceRebound("device-b"));
  renderFavorites(
    <DeviceLibrary {...props()} onRebindDevice={onRebindDevice} />,
  );
  choose();
  fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toBeEnabled();
  choose("device-b");
  await act(async () => result.resolve(deviceRebound()));
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("COM2");
  fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
  await screen.findByText("Binding 1 · COM2");
  expect(onRebindDevice.mock.calls[1]?.[0].document.revision).toBe("8");
});

it("saves pending rebind through leave negotiation and refuses to discard a newer selection", async () => {
  const { work, value } = registry();
  const result = pendingResult();
  const onRebindDevice = vi.fn().mockReturnValue(result.promise);
  renderFavorites(
    <UnsavedWorkContext.Provider value={value}>
      <DeviceLibrary {...props()} onRebindDevice={onRebindDevice} />
    </UnsavedWorkContext.Provider>,
  );
  choose();
  const signal = new AbortController().signal;
  let saving!: Promise<void>;
  act(() => {
    saving = [...work.values()][0]!.save!(signal);
  });
  choose("device-b");
  const rejected = expect(saving).rejects.toThrow("New changes need saving");
  await act(async () => {
    result.resolve(deviceRebound());
    await rejected;
  });
  expect([...work.values()].some((item) => item.dirty)).toBe(true);
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("COM2");
  await act(async () => {
    await [...work.values()][0]!.discard();
  });
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("Choose a device explicitly");
});

it.each(["host", "workspace", "unmount"] as const)(
  "ignores late results after a %s switch",
  async (kind) => {
    const result = pendingResult();
    const onAcknowledged = vi.fn();
    const onRebindDevice = vi.fn().mockReturnValue(result.promise);
    const base = props();
    const view = renderFavorites(
      <StrictMode>
        <DeviceLibrary
          {...base}
          onRebindDevice={onRebindDevice}
          onAcknowledged={onAcknowledged}
        />
      </StrictMode>,
    );
    choose();
    fireEvent.click(screen.getByRole("button", { name: "Rebind Binding 1" }));
    const signal: AbortSignal = onRebindDevice.mock.calls[0]![2];
    if (kind === "unmount") view.unmount();
    else {
      const next = workspace();
      if (kind === "host") next.scope.target.hostId = "other-host";
      else next.scope.target.id = "other-workspace";
      view.rerender(
        <StrictMode>
          <DeviceLibrary
            {...base}
            workspace={next}
            onRebindDevice={onRebindDevice}
            onAcknowledged={onAcknowledged}
          />
        </StrictMode>,
      );
      choose("device-b");
    }
    expect(signal.aborted).toBe(true);
    await act(async () => result.resolve(deviceRebound()));
    expect(onAcknowledged).not.toHaveBeenCalled();
    if (kind !== "unmount") {
      expect(
        screen.getByLabelText("Choose a device explicitly Binding 1"),
      ).toHaveTextContent("COM2");
      expect(
        screen.getByText("Binding 1 · Offline device · Disconnected"),
      ).toBeVisible();
    }
  },
);

it("does not accept a document result after the leave signal is cancelled", async () => {
  const { work, value } = registry();
  const result = pendingResult();
  const onAcknowledged = vi.fn();
  const onRebindDevice = vi.fn().mockReturnValue(result.promise);
  renderFavorites(
    <UnsavedWorkContext.Provider value={value}>
      <DeviceLibrary
        {...props()}
        onRebindDevice={onRebindDevice}
        onAcknowledged={onAcknowledged}
      />
    </UnsavedWorkContext.Provider>,
  );
  choose();
  const controller = new AbortController();
  let saving!: Promise<void>;
  act(() => {
    saving = [...work.values()][0]!.save!(controller.signal);
  });
  act(() => controller.abort());
  const rejected = expect(saving).rejects.toMatchObject({ name: "AbortError" });
  await act(async () => {
    result.resolve(deviceRebound());
    await rejected;
  });
  expect(onAcknowledged).not.toHaveBeenCalled();
  expect(
    screen.getByLabelText("Choose a device explicitly Binding 1"),
  ).toHaveTextContent("COM9");
  expect(
    screen.getByRole("button", { name: "Rebind Binding 1" }),
  ).toBeEnabled();
});

it("keeps a newer Host workspace revision when an earlier save resolves late", async () => {
  const result = pendingResult();
  const onSaveFavorites = vi.fn().mockReturnValue(result.promise);
  const onAcknowledged = vi.fn();
  const base = props();
  const view = renderFavorites(
    <DeviceLibrary
      {...base}
      onSaveFavorites={onSaveFavorites}
      onAcknowledged={onAcknowledged}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  );
  const next = workspace();
  next.document.revision = "9";
  next.document.value.name = "New Host document";
  view.rerender(
    <DeviceLibrary
      {...base}
      workspace={next}
      onSaveFavorites={onSaveFavorites}
      onAcknowledged={onAcknowledged}
    />,
  );
  await act(async () => result.resolve(favoriteSaved()));
  expect(onAcknowledged).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove favorite Binding 1" }),
  );
  expect(onSaveFavorites.mock.calls[1]?.[0].document.revision).toBe("9");
});
