import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as native from "@/lib/tauri";
import type { Activation, Workspace } from "@/lib/tauri";
import { useWorkspace } from "./use-workspace";

const router = vi.hoisted(() => ({ navigate: vi.fn(), pathname: "/" }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useLocation: vi.fn(),
  useNavigate: vi.fn(),
}));
vi.mock("@/lib/report-error", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  getCurrentWindowLabel: vi.fn(),
  getWorkspace: vi.fn(),
  getActivationSnapshot: vi.fn(),
  onActivation: vi.fn(),
  onWorkspaceRoute: vi.fn(),
  saveWorkspaceRoute: vi.fn(),
  recoveryStatus: vi.fn(),
}));
let activation: ((value: Activation) => void) | undefined;
let route: ((value: string) => void) | undefined;
const stops = [vi.fn(), vi.fn()];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function deepLink(id: number, route: string): Activation {
  return { id, source: "deep-link", route };
}
beforeEach(() => {
  vi.resetAllMocks();
  router.pathname = "/";
  activation = undefined;
  route = undefined;
  vi.mocked(useLocation).mockImplementation(
    () => ({ pathname: router.pathname }) as ReturnType<typeof useLocation>,
  );
  vi.mocked(useNavigate).mockReturnValue(router.navigate);
  vi.mocked(native.getCurrentWindowLabel).mockResolvedValue("main");
  vi.mocked(native.getWorkspace).mockResolvedValue({
    routes: {},
    secondaryOpen: false,
  });
  vi.mocked(native.getActivationSnapshot).mockResolvedValue([]);
  vi.mocked(native.recoveryStatus).mockResolvedValue({
    active: false,
    reason: null,
    pending: false,
    archiveId: null,
  });
  vi.mocked(native.saveWorkspaceRoute).mockResolvedValue(undefined);
  vi.mocked(native.onActivation).mockImplementation(async (handler) => {
    activation = handler;
    return stops[0]!;
  });
  vi.mocked(native.onWorkspaceRoute).mockImplementation(async (handler) => {
    route = handler;
    return stops[1]!;
  });
});
afterEach(cleanup);
describe("workspace navigation", () => {
  it("persists product pages while excluding dynamic plugin sessions and hidden recovery pages", async () => {
    const view = renderHook(useWorkspace);
    await waitFor(() =>
      expect(native.saveWorkspaceRoute).toHaveBeenCalledWith("/"),
    );
    vi.mocked(native.saveWorkspaceRoute).mockClear();
    router.pathname = "/extensions/app/example.plugin/open";
    view.rerender();
    await act(async () => {});
    expect(native.saveWorkspaceRoute).not.toHaveBeenCalled();
    router.pathname = "/recovery";
    view.rerender();
    await act(async () => {});
    expect(native.saveWorkspaceRoute).not.toHaveBeenCalled();
    router.pathname = "/settings";
    view.rerender();
    await waitFor(() =>
      expect(native.saveWorkspaceRoute).toHaveBeenCalledWith("/settings"),
    );
  });
  it("rejects removed demo destinations and does not restore them from an activation", async () => {
    vi.mocked(native.getWorkspace).mockResolvedValue({
      routes: { main: "/settings" },
      secondaryOpen: false,
    });
    vi.mocked(native.getActivationSnapshot).mockResolvedValue([
      deepLink(1, "/workbench"),
    ]);
    renderHook(useWorkspace);
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith("/settings"),
    );
    router.navigate.mockClear();
    act(() => {
      activation?.(deepLink(2, "/database"));
      route?.("/tasks");
    });
    expect(router.navigate).not.toHaveBeenCalled();
  });
  it("preserves newer activation navigation when startup snapshots arrive late", async () => {
    const initial = deferred<Workspace>();
    vi.mocked(native.getWorkspace).mockReturnValue(initial.promise);
    renderHook(useWorkspace);
    await waitFor(() => expect(native.getWorkspace).toHaveBeenCalled());
    act(() => activation?.(deepLink(2, "/extensions")));
    await act(async () =>
      initial.resolve({ routes: { main: "/settings" }, secondaryOpen: false }),
    );
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/extensions");
  });
  it("does not override navigation made while startup data is loading", async () => {
    const initial = deferred<Workspace>();
    vi.mocked(native.getWorkspace).mockReturnValue(initial.promise);
    const view = renderHook(useWorkspace);
    await waitFor(() => expect(native.getWorkspace).toHaveBeenCalled());
    router.pathname = "/extensions";
    view.rerender();
    await act(async () =>
      initial.resolve({ routes: { main: "/settings" }, secondaryOpen: false }),
    );
    expect(router.navigate).not.toHaveBeenCalled();
  });
  it("releases late subscriptions and ignores callbacks after unmount", async () => {
    const late = deferred<() => void>();
    vi.mocked(native.onActivation).mockReturnValue(late.promise);
    const view = renderHook(useWorkspace);
    view.unmount();
    await act(async () => late.resolve(stops[0]!));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
    act(() => route?.("/settings"));
    expect(router.navigate).not.toHaveBeenCalled();
  });
  it("does not let an earlier StrictMode subscription override active navigation", async () => {
    const view = renderHook(useWorkspace, { wrapper: StrictMode });
    await waitFor(() => expect(native.saveWorkspaceRoute).toHaveBeenCalled());
    router.navigate.mockClear();
    act(() => activation?.(deepLink(3, "/settings")));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/settings");
    view.unmount();
    expect(stops[0]).toHaveBeenCalledTimes(2);
    expect(stops[1]).toHaveBeenCalledTimes(2);
  });
});
