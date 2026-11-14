import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSynchronizedTheme, useThemeSwitch } from "./use-theme-switch";
import { STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/settings-model";
import * as themeReveal from "./theme-reveal";

const { setTheme, update, state } = vi.hoisted(() => ({
  setTheme: vi.fn(),
  update: vi.fn(),
  state: {
    theme: "light",
    resolved: "light",
    saved: "light",
    persistence: "saved",
    native: false,
  },
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: state.theme,
    resolvedTheme: state.resolved,
    setTheme,
  }),
}));
vi.mock("@/providers/settings", () => ({
  useSettings: () => ({
    settings: { theme: state.saved },
    persistence: state.persistence,
    update,
  }),
}));
vi.mock("@/lib/tauri", () => ({ isTauri: () => state.native }));

beforeEach(() => {
  Object.assign(state, {
    theme: "light",
    resolved: "light",
    saved: "light",
    persistence: "saved",
    native: false,
  });
  setTheme.mockClear();
  update.mockClear();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
});

describe("immediate theme choices", () => {
  it("never captures the interactive document while changing a theme", () => {
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      value: start,
      configurable: true,
    });
    const { result } = renderHook(useThemeSwitch);
    act(() => result.current.toggle());
    expect(update).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    expect(start).not.toHaveBeenCalled();
  });
  it.each([2, 3, 10])(
    "commits all %s rapid clicks in order before React renders again",
    (count) => {
      const { result } = renderHook(useThemeSwitch);
      act(() => {
        for (let index = 0; index < count; index++) result.current.toggle();
      });
      expect(update.mock.calls).toEqual(
        Array.from({ length: count }, (_, index) => [
          { theme: index % 2 ? "light" : "dark" },
        ]),
      );
      expect(setTheme).toHaveBeenCalledTimes(count);
      expect(setTheme).toHaveBeenLastCalledWith(count % 2 ? "dark" : "light");
    },
  );
  it("animates every toggle before the resolved appearance renders again", () => {
    const reveal = vi
      .spyOn(themeReveal, "startThemeReveal")
      .mockImplementation((commit) => {
        commit();
        return undefined;
      });
    const { result } = renderHook(useThemeSwitch);
    act(() => {
      for (let index = 0; index < 4; index++) result.current.toggle();
    });
    expect(reveal.mock.calls.map(([, enabled]) => enabled)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
  it("toggles from the resolved system appearance", () => {
    state.theme = state.saved = "system";
    state.resolved = "dark";
    const { result } = renderHook(useThemeSwitch);
    act(() => result.current.toggle());
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("light");
  });
  it("persists explicit choices, ignores invalid values, and uses the latest explicit intention", () => {
    const { result } = renderHook(useThemeSwitch);
    act(() => {
      result.current.toggle();
      result.current.setTheme("system");
      result.current.setTheme("invalid");
      result.current.toggle();
    });
    expect(update.mock.calls).toEqual([
      [{ theme: "dark" }],
      [{ theme: "system" }],
      [{ theme: "dark" }],
    ]);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
  });
  it("uses an accepted remote appearance for the next local toggle", () => {
    const { result, rerender } = renderHook(useThemeSwitch);
    act(() => result.current.toggle());
    state.theme = state.saved = state.resolved = "light";
    state.saved = "system";
    rerender();
    act(() => result.current.toggle());
    expect(setTheme.mock.calls).toEqual([["dark"], ["dark"]]);
  });
});

describe("synchronized theme", () => {
  it("waits for the first native snapshot and does not write it back", () => {
    state.native = true;
    state.persistence = "loading";
    state.saved = "dark";
    const { rerender } = renderHook(useSynchronizedTheme);
    expect(setTheme).not.toHaveBeenCalled();
    state.persistence = "saved";
    rerender();
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    expect(update).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "applies accepted changes immediately even when hidden (hidden=%s)",
    (hidden) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(
        hidden ? "hidden" : "visible",
      );
      state.native = true;
      const { rerender } = renderHook(useSynchronizedTheme);
      state.saved = "dark";
      rerender();
      expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
      state.theme = "dark";
      state.saved = "light";
      rerender();
      expect(setTheme.mock.calls).toEqual([["dark"], ["light"]]);
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("leaves no pending application after unmount", async () => {
    const { rerender, unmount } = renderHook(useSynchronizedTheme);
    state.saved = "dark";
    rerender();
    unmount();
    state.saved = "light";
    await act(async () => {});
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
  });
  it.each([true, false])(
    "uses the theme cache only for first paint (native=%s)",
    (native) => {
      state.native = native;
      const { unmount } = renderHook(useSynchronizedTheme);
      const received = vi.fn();
      window.addEventListener("storage", received);
      try {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: THEME_STORAGE_KEY,
            newValue: "dark",
          }),
        );
        expect(received).not.toHaveBeenCalled();
        window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
        expect(received).toHaveBeenCalledOnce();
        unmount();
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: THEME_STORAGE_KEY,
            newValue: "dark",
          }),
        );
        expect(received).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener("storage", received);
      }
    },
  );
});
