import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostAttachment,
  hostRequest,
  hostSubscribe,
  hostDeliveryAck,
  readClientState,
  saveClientState,
  applyHostSettingsEffects,
  hostConnectDevice,
  chooseFileResource,
  mediaResolve,
  mediaRelease,
} from "./tauri";
import { defaults } from "@serial-workbench/contracts";
import type { Query } from "@serial-workbench/contracts";
import type { HostSettingsEffectsReceipt } from "./tauri";
const bridge = vi.hoisted(() => ({
  hostAttachment: vi.fn(),
  hostRequest: vi.fn(),
  hostSubscribe: vi.fn(),
  hostDeliveryAck: vi.fn(),
  clientStateRead: vi.fn(),
  clientStateSave: vi.fn(),
  applyHostSettingsEffects: vi.fn(),
  hostConnectDevice: vi.fn(),
  chooseFileResource: vi.fn(),
  mediaResolve: vi.fn(),
  mediaRelease: vi.fn(),
  channels: vi.fn(),
}));
vi.mock("./generated/bindings", () => ({ commands: bridge }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(public onmessage: (value: unknown) => void) {
      bridge.channels();
    }
  },
}));
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.clearAllMocks();
});
function desktop() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}
describe("Host native facade", () => {
  it("passes display-only capture naming context to the generation-bound native picker", async () => {
    desktop();
    bridge.chooseFileResource.mockResolvedValue({ status: "ok", data: null });
    const hint = { deviceName: "COM7", baudRate: "115200" };
    await expect(
      chooseFileResource("captureTarget", "8", hint),
    ).resolves.toBeNull();
    expect(bridge.chooseFileResource).toHaveBeenCalledExactlyOnceWith(
      "captureTarget",
      "8",
      hint,
    );
  });
  it("passes explicit device connection parameters and generation without a generic grant request", async () => {
    desktop();
    bridge.hostConnectDevice.mockResolvedValue({
      status: "error",
      error: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    });
    const params = { configuration: defaults.serialConfiguration };
    await expect(
      hostConnectDevice("8", "selected-device", params),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(bridge.hostConnectDevice).toHaveBeenCalledExactlyOnceWith(
      "8",
      "selected-device",
      params,
    );
  });
  it("binds the native file selection and media lifecycle to the current generation", async () => {
    desktop();
    bridge.chooseFileResource.mockResolvedValue({ status: "ok", data: null });
    await expect(chooseFileResource("source", "8")).resolves.toBeNull();
    expect(bridge.chooseFileResource).toHaveBeenCalledExactlyOnceWith(
      "source",
      "8",
      null,
    );
    const reference = {
      hostId: "host",
      kind: "file",
      id: "selected",
      revision: "1",
    };
    const resolution = {
      ticket: "ticket",
      url: "app-media://localhost/ticket",
      name: "selected",
      mime: "image/png",
    };
    bridge.mediaResolve.mockResolvedValue({ status: "ok", data: resolution });
    await expect(mediaResolve(reference, "8")).resolves.toEqual(resolution);
    expect(bridge.mediaResolve).toHaveBeenCalledExactlyOnceWith(reference, "8");
    bridge.mediaRelease.mockResolvedValue({ status: "ok", data: null });
    await mediaRelease("ticket", "8");
    expect(bridge.mediaRelease).toHaveBeenCalledExactlyOnceWith("ticket", "8");
  });
  it("rejects connect and picker in browser preview before invoking native commands", async () => {
    await expect(
      hostConnectDevice("8", "device", {
        configuration: defaults.serialConfiguration,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await expect(chooseFileResource("source", "8")).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    expect(bridge.hostConnectDevice).not.toHaveBeenCalled();
    expect(bridge.chooseFileResource).not.toHaveBeenCalled();
  });
  it("reads client state and sends the explicit CAS revision without an arbitrary window identity", async () => {
    desktop();
    const state = {
      preferences: {
        menuBar: true,
        windowPosition: "remember" as const,
        sidebarCollapsed: false,
        sidebarWidth: 224,
      },
      currentPage: "workbench",
      focusedPanelId: null,
      scrollOffset: 0,
      follow: true,
      lastWorkspaceId: null,
      drafts: { "view-one": "unsent" },
    };
    const snapshot = { formatVersion: "0.1", revision: "4", state };
    bridge.clientStateRead.mockResolvedValue({ status: "ok", data: snapshot });
    await expect(readClientState()).resolves.toEqual(snapshot);
    bridge.clientStateSave.mockResolvedValue({
      status: "ok",
      data: { ...snapshot, revision: "5" },
    });
    await expect(saveClientState(state, "4")).resolves.toMatchObject({
      revision: "5",
    });
    expect(bridge.clientStateSave).toHaveBeenCalledWith(state, "4");
    bridge.clientStateSave.mockResolvedValue({
      status: "error",
      error: { code: "CONFLICT", message: "changed", retryable: true },
    });
    await expect(saveClientState(state, "4")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("applies the authoritative Host settings without accepting preference values from JavaScript", async () => {
    desktop();
    const receipt: HostSettingsEffectsReceipt = {
      hostId: "host",
      instanceEpoch: "7",
      revision: "4",
      effects: {
        trayLanguage: true,
        networkMode: true,
        runInBackground: true,
      },
    };
    bridge.applyHostSettingsEffects.mockResolvedValue({
      status: "ok",
      data: receipt,
    });
    await expect(applyHostSettingsEffects()).resolves.toEqual(receipt);
    bridge.applyHostSettingsEffects.mockResolvedValue({
      status: "error",
      error: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    });
    await expect(applyHostSettingsEffects()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(bridge.applyHostSettingsEffects).toHaveBeenCalledWith();
  });
  it("refuses preview attachment before calling the native commands", async () => {
    await expect(hostAttachment()).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    expect(bridge.hostAttachment).not.toHaveBeenCalled();
    expect(bridge.channels).not.toHaveBeenCalled();
  });
  it("retains Host stable error codes", async () => {
    desktop();
    bridge.hostAttachment.mockResolvedValue({
      status: "error",
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: "storage unavailable",
        retryable: true,
      },
    });
    await expect(hostAttachment()).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
  });
  it("does not replace Host failure replies with native errors", async () => {
    desktop();
    const reply = {
      ok: false,
      error: { code: "CURSOR_EXPIRED", message: "expired", retryable: false },
    };
    bridge.hostRequest.mockResolvedValue({ status: "ok", data: reply });
    const query: Query = {
      protocolVersion: "0.1",
      hostId: "host",
      instanceEpoch: "1",
      actorId: "actor",
      requestId: crypto.randomUUID(),
      actionId: "state.snapshot",
      target: { hostId: "host", kind: "host", id: "host" },
      params: {},
      revealTarget: { pageId: "workbench" },
    };
    await expect(
      hostRequest({ method: "action.query", params: query }, "3"),
    ).resolves.toEqual(reply);
    bridge.hostSubscribe.mockResolvedValue({ status: "ok", data: "real-id" });
    const listener = vi.fn();
    await expect(hostSubscribe(query, listener, "3")).resolves.toBe("real-id");
    expect(bridge.hostSubscribe).toHaveBeenCalledWith(
      query,
      expect.objectContaining({ onmessage: listener }),
      "3",
    );
    bridge.hostDeliveryAck.mockResolvedValue({ status: "ok", data: null });
    await hostDeliveryAck("3", "real-id", "lifecycle", "1");
    expect(bridge.hostDeliveryAck).toHaveBeenCalledWith(
      "3",
      "real-id",
      "lifecycle",
      "1",
    );
  });
});
