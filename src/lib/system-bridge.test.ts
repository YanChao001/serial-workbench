import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSystemNotification, sendSystemNotification } from "./tauri";
const plugins = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<NotificationPermission>>(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugins);
function desktop() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}
beforeEach(() => {
  plugins.isPermissionGranted.mockResolvedValue(false);
  plugins.requestPermission.mockResolvedValue("denied");
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.resetAllMocks();
});
describe("notification permission and subscriptions", () => {
  it("does not request permission or send when a background call lacks authorization", async () => {
    desktop();
    await expect(sendSystemNotification("Demo", "Body", false)).resolves.toBe(
      false,
    );
    expect(plugins.requestPermission).not.toHaveBeenCalled();
    expect(plugins.sendNotification).not.toHaveBeenCalled();
  });

  it.each(["denied", "granted"] as const)(
    "explicitly requests permission and honors %s",
    async (permission) => {
      desktop();
      plugins.requestPermission.mockResolvedValue(permission);
      await expect(sendSystemNotification("Demo", "Body", true)).resolves.toBe(
        permission === "granted",
      );
      expect(plugins.requestPermission).toHaveBeenCalledOnce();
      if (permission === "granted")
        expect(plugins.sendNotification).toHaveBeenCalledWith({
          title: "Demo",
          body: "Body",
        });
      else expect(plugins.sendNotification).not.toHaveBeenCalled();
    },
  );

  it("uses an existing grant without another prompt and returns subscription cleanup", async () => {
    desktop();
    plugins.isPermissionGranted.mockResolvedValue(true);
    await expect(sendSystemNotification("Demo", "Body", false)).resolves.toBe(
      true,
    );
    expect(plugins.requestPermission).not.toHaveBeenCalled();
    expect(plugins.sendNotification).toHaveBeenCalledOnce();
    const unregister = vi.fn().mockResolvedValue(undefined);
    plugins.onAction.mockResolvedValue({ unregister });
    const handler = vi.fn();
    const dispose = await onSystemNotification(handler);
    expect(plugins.onAction).toHaveBeenCalledWith(handler);
    dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("rejects browser notifications before touching a native plugin", async () => {
    await expect(sendSystemNotification("Demo", "Body")).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    expect(plugins.isPermissionGranted).not.toHaveBeenCalled();
    expect(plugins.requestPermission).not.toHaveBeenCalled();
  });
});
