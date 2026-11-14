import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "sonner";
import type { ComponentProps } from "react";
import {
  defaults,
  type WorkspaceDocumentResult,
  type WorkspaceDocument,
} from "@serial-workbench/contracts";
import { I18nContext } from "@/providers/i18n-context";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { WorkspacePicker } from "./workspace-picker";
const i18n = { language: "en" as const, t: createTranslator(en) };
afterEach(() => {
  cleanup();
  toast.dismiss();
});
const base: WorkspaceDocumentResult = {
  scope: {
    scopeId: "workspace:original",
    target: { hostId: "host", kind: "workspace", id: "original" },
  },
  document: {
    revision: "7",
    value: { ...defaults.workspace, name: "Original" },
  },
};
function fixture(
  options: Partial<Omit<ComponentProps<typeof WorkspacePicker>, "host">> = {},
) {
  const host = {
    state: { status: "ready" as const },
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    saveWorkspace: vi
      .fn()
      .mockImplementation(
        async (base: WorkspaceDocumentResult, value: WorkspaceDocument) => ({
          ...base,
          document: { revision: "1", value },
        }),
      ),
    loadWorkspace: vi.fn().mockImplementation(async (id: string) => ({
      ...base,
      scope: { ...base.scope, target: { ...base.scope.target, id } },
    })),
  };
  const props = {
    host,
    base,
    value: base.document.value,
    beforeReplace: vi.fn().mockResolvedValue(true),
    onLoaded: vi.fn(),
    onCopySaved: vi.fn(),
    onBusyChange: vi.fn(),
    ...options,
  };
  const view = render(
    <I18nContext value={i18n}>
      <Toaster />
      <WorkspacePicker {...props} />
    </I18nContext>,
  );
  return { ...props, view };
}
async function createForm(label: string, name: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  const popover = await screen.findByRole("dialog", { name: label });
  fireEvent.change(
    within(popover).getByRole("textbox", { name: "Workspace name" }),
    { target: { value: name } },
  );
  return popover;
}
it("deletes only after leave negotiation, archives the current revision and selects the default workspace", async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete workspace",
  });
  expect(f.host.saveWorkspace).not.toHaveBeenCalled();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Delete workspace" }),
  );
  await waitFor(() =>
    expect(f.host.loadWorkspace).toHaveBeenCalledWith(
      "default",
      expect.any(AbortSignal),
    ),
  );
  expect(f.beforeReplace).toHaveBeenCalledOnce();
  expect(f.host.saveWorkspace).toHaveBeenCalledWith(
    base,
    { ...base.document.value, archived: true },
    expect.any(AbortSignal),
  );
  expect(f.onLoaded).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({
        target: expect.objectContaining({ id: "default" }),
      }),
    }),
  );
});
it("keeps the current workspace when deletion negotiation is cancelled or the archive conflicts", async () => {
  const f = fixture({ beforeReplace: vi.fn().mockResolvedValue(false) });
  fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete workspace",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Delete workspace" }),
  );
  await waitFor(() => expect(f.beforeReplace).toHaveBeenCalledOnce());
  expect(f.host.saveWorkspace).not.toHaveBeenCalled();
  expect(f.host.loadWorkspace).not.toHaveBeenCalled();
});
it("creates a named empty document at revision zero and selects it only after saving", async () => {
  const f = fixture();
  const form = await createForm("New workspace", "  Bench A  ");
  fireEvent.click(
    within(form).getByRole("button", { name: "Create workspace" }),
  );
  await waitFor(() => expect(f.onLoaded).toHaveBeenCalledOnce());
  expect(f.host.saveWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({
        target: expect.objectContaining({
          hostId: "host",
          kind: "workspace",
          id: expect.not.stringMatching(/^original$/),
        }),
      }),
      document: expect.objectContaining({ revision: "0" }),
    }),
    { ...defaults.workspace, name: "Bench A" },
    expect.any(AbortSignal),
  );
  expect(f.beforeReplace).toHaveBeenCalledOnce();
  expect(f.onCopySaved).not.toHaveBeenCalled();
});
it("saves unsaved editor changes as a separate copy without saving or discarding the original first", async () => {
  const f = fixture({
    value: { ...base.document.value, name: "Unsaved edit" },
  });
  const form = await createForm("Save workspace as", "Copied bench");
  fireEvent.click(
    within(form).getByRole("button", { name: "Save workspace as" }),
  );
  await waitFor(() => expect(f.onLoaded).toHaveBeenCalledOnce());
  expect(f.host.saveWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      document: expect.objectContaining({ revision: "0" }),
    }),
    expect.objectContaining({ name: "Copied bench" }),
    expect.any(AbortSignal),
  );
  expect(f.beforeReplace).not.toHaveBeenCalled();
  expect(f.onCopySaved).toHaveBeenCalledOnce();
});
it("keeps the original draft when creation fails and does not load a nonexistent workspace", async () => {
  const f = fixture();
  f.host.saveWorkspace.mockRejectedValue({ code: "STORAGE_UNAVAILABLE" });
  const form = await createForm("Save workspace as", "Failed copy");
  fireEvent.click(
    within(form).getByRole("button", { name: "Save workspace as" }),
  );
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(f.host.loadWorkspace).not.toHaveBeenCalled();
  expect(f.onCopySaved).not.toHaveBeenCalled();
  expect(
    within(form).getByRole("textbox", { name: "Workspace name" }),
  ).toHaveValue("Failed copy");
});
it("allows the current editor to save during leave negotiation and honors cancellation", async () => {
  let answer!: (allowed: boolean) => void;
  const beforeReplace = vi.fn().mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const f = fixture({ beforeReplace });
  const form = await createForm("New workspace", "Other bench");
  fireEvent.click(
    within(form).getByRole("button", { name: "Create workspace" }),
  );
  await waitFor(() => expect(beforeReplace).toHaveBeenCalledOnce());
  expect(f.onBusyChange).not.toHaveBeenCalledWith(true);
  await act(async () => answer(false));
  expect(f.host.saveWorkspace).not.toHaveBeenCalled();
});
it("loads subsequent directory pages and refreshes without reading workspace documents", async () => {
  const f = fixture();
  f.host.listWorkspaces
    .mockResolvedValueOnce({
      workspaces: [{ scope: base.scope, name: "First", revision: "1" }],
      nextCursor: "next-page",
    })
    .mockResolvedValueOnce({
      workspaces: [
        {
          scope: {
            ...base.scope,
            target: { ...base.scope.target, id: "other" },
          },
          name: "Second",
          revision: "2",
        },
      ],
    });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh workspace list" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh workspace list" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more workspaces" }),
  );
  await waitFor(() =>
    expect(f.host.listWorkspaces).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      "next-page",
    ),
  );
  expect(f.host.loadWorkspace).not.toHaveBeenCalled();
});
