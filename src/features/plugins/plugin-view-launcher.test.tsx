import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostRequestError } from "@serial-workbench/host-client";
import { expect, it, vi } from "vitest";
import type { HostConnection } from "@/lib/host-client";
import { operation, session } from "@/features/workbench/test-fixtures";
import type { BrowserViewOpen } from "./browser-plugin-view";
import { PluginViewLauncher } from "./plugin-view-launcher";

const packageId = "swb.reference.chart";
const archiveSha256 = "a".repeat(64);
const actionId = "swb.reference.chart.sample";
const invoke = vi.fn();
const checkAction = vi.fn();

vi.mock("@/providers/host-context", () => ({
  useHost: () => ({
    state: {
      catalog: [{ actionId, targetKinds: ["session"] }],
      sessions: [session("first"), session("second")],
      devices: [],
    },
    invoke,
    checkAction,
    waitForOperation: (accepted: unknown) => Promise.resolve(accepted),
  }),
}));
vi.mock("@/providers/i18n", () => ({
  useI18n: () => ({
    language: "en",
    t: (key: string, params?: { number: number }) =>
      params === undefined ? key : `${key} ${params.number}`,
  }),
}));
vi.mock("./browser-plugin-view", () => ({
  BrowserPluginView: ({
    view,
    onClose,
  }: {
    view: BrowserViewOpen;
    onClose: () => void;
  }) => <button onClick={onClose}>Close {view.operationId}</button>,
}));

it("reuses each open session's chart after switching and after transient view pressure", async () => {
  invoke.mockImplementation(({ target }: { target: { id: string } }) =>
    Promise.resolve({
      ...operation(`sampling-${target.id}`, target.id),
      state: "running",
      dependencies: [
        { id: packageId, version: "0.1.0", digest: archiveSha256 },
      ],
    }),
  );
  checkAction.mockResolvedValue({ allowed: true });
  const connection = {
    generation: "1",
    hostTarget: { kind: "host", hostId: "host", id: "host" },
    browser: {
      closed: new AbortController().signal,
      openViewConnection: vi.fn(),
    },
  } satisfies Partial<HostConnection>;
  const user = userEvent.setup();
  render(
    <PluginViewLauncher
      connection={connection as unknown as HostConnection}
      packageId={packageId}
      displayName="Reference Chart"
      archiveSha256={archiveSha256}
      views={[{ id: "chart", actionId, feed: "derived", stateScopes: [] }]}
    />,
  );
  const open = screen.getByRole("button", { name: "plugins.openView" });
  async function choose(firstOrSecond: number) {
    await user.click(screen.getByRole("combobox"));
    await user.click(
      screen.getByRole("option", {
        name: `plugins.viewSessionNumber ${firstOrSecond}`,
      }),
    );
  }
  await choose(1);
  await user.click(open);
  await user.click(
    await screen.findByRole("button", { name: "Close sampling-first" }),
  );
  await choose(2);
  await user.click(open);
  await user.click(
    await screen.findByRole("button", { name: "Close sampling-second" }),
  );
  await choose(1);

  checkAction.mockRejectedValueOnce(
    new HostRequestError({
      code: "HOST_BUSY",
      message: "No free view slot",
      retryable: true,
    }),
  );
  await user.click(open);
  await waitFor(() => expect(checkAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await expect(
    screen.findByRole("button", { name: "Close sampling-first" }),
  ).resolves.toBeVisible();
  expect(invoke).toHaveBeenCalledTimes(2);
});
