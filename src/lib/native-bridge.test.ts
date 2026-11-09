import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { defaults, type Operation } from "@serial-workbench/contracts";
import {
  NativeBridgeError,
  getDesktopStatus,
  hostApplyDocumentIntent,
  readClientState,
  recordFrontendError,
} from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "secondary" }),
}));

describe("generated native bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.resetAllMocks();
  });

  it("turns stable Rust error DTOs into errors with code and retryability", async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: "CONFLICT",
      message: "reload",
      retryable: true,
    });
    await expect(readClientState()).rejects.toBeInstanceOf(NativeBridgeError);
    await expect(readClientState()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reload",
      retryable: true,
    });
  });

  it("validates local document operation receipts and preserves Host error codes", async () => {
    const intent = {
      kind: "settingsSave" as const,
      expectedRevision: "9007199254740993",
      params: { value: { ...defaults.settings, theme: "light" as const } },
    };
    vi.mocked(invoke).mockResolvedValue({ operationId: "incomplete" });
    await expect(hostApplyDocumentIntent("12", intent)).rejects.toMatchObject({
      name: "ContractValidationError",
    });
    expect(invoke).toHaveBeenLastCalledWith("host_apply_document_intent", {
      generation: "12",
      intent,
    });
    const operation: Operation = {
      operationId: "settings-save",
      executionHostId: "host",
      actorId: "actor",
      requestId: "00000000-0000-4000-8000-000000000001",
      admission: { kind: "request", requestContextDigest: "a".repeat(64) },
      rootOperationId: "settings-save",
      childHighWatermark: "0",
      actionId: "settings.save",
      target: { hostId: "host", kind: "settings", id: "shared" },
      executionMode: "interactive",
      state: "queued",
      revision: "1",
      revealTarget: { pageId: "settings" },
      acceptedAt: "2026-11-08T00:00:00Z",
      owner: { kind: "host", id: "host" },
    };
    vi.mocked(invoke).mockResolvedValue(operation);
    expect(await hostApplyDocumentIntent("12", intent)).toEqual(operation);
    vi.mocked(invoke).mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "revoked",
    });
    await expect(hostApplyDocumentIntent("12", intent)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.mocked(invoke).mockClear();
    await expect(hostApplyDocumentIntent("12", intent)).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds error logs without splitting Unicode characters", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await recordFrontendError({
      message: "🌸".repeat(1100),
      stack: "s".repeat(9000),
      componentStack: "a" + "中".repeat(3000),
    });
    expect(invoke).toHaveBeenLastCalledWith("record_frontend_error", {
      error: {
        message: "🌸".repeat(1024),
        stack: "s".repeat(8192),
        componentStack: "a" + "中".repeat(2730),
      },
    });
  });

  it("browser previews cannot claim native support or write native logs", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(getDesktopStatus()).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    await recordFrontendError({ message: "browser" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
