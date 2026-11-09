import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundSelection } from "@serial-workbench/contracts";
import type { MediaPort, SelectedMedia } from "@/lib/media";
import { CustomBackgroundPicker } from "./custom-background-picker";
import {
  browserClientStateStore,
  DEFAULT_CLIENT_STATE,
} from "@/lib/client-settings";

const state = vi.hoisted(() => ({
  settings: {
    background: { kind: "preset", value: "plain" } as BackgroundSelection,
  },
  update: vi.fn(),
  persistence: "saved",
  media: undefined as MediaPort | undefined,
}));
vi.mock("@/providers/settings", () => ({ useSettings: () => state }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));
vi.mock("@/providers/i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: { name?: string }) =>
      key + (values?.name ? `: ${values.name}` : ""),
  }),
}));
const chosen: SelectedMedia = {
  reference: { hostId: "host", kind: "file", id: "image", revision: "1" },
  name: "sky.webp",
  mime: "image/webp",
  length: "100",
};
beforeEach(() => {
  sessionStorage.clear();
  state.settings.background = {
    kind: "media",
    reference: chosen.reference,
    fit: "contain",
  };
  state.media = undefined;
  state.update.mockReset();
});
async function ready() {
  const button = screen.getByRole("button", {
    name: "settings.importBackground",
  });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}
afterEach(cleanup);
describe("authorized media selection", () => {
  it("preserves existing media when the service is not connected", () => {
    render(<CustomBackgroundPicker />);
    expect(
      screen.getByRole("button", { name: "settings.importBackground" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.mediaUnavailable",
    );
    expect(state.update).not.toHaveBeenCalled();
  });
  it("saves the authorized reference and retains fit without embedding media bytes", async () => {
    const choose = vi.fn(async () => chosen);
    state.media = {
      choose,
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    render(<CustomBackgroundPicker />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.importBackground" }),
    );
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        background: {
          kind: "media",
          reference: chosen.reference,
          fit: "contain",
        },
      }),
    );
    expect(choose).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(browserClientStateStore().read().state.gallery).toEqual([
      { reference: chosen.reference, name: chosen.name },
    ]);
  });
  it("leaves selection untouched after chooser cancellation or error", async () => {
    const choose = vi
      .fn<MediaPort["choose"]>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: "FILE_DENIED" });
    state.media = {
      choose,
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    render(<CustomBackgroundPicker />);
    await ready();
    const button = screen.getByRole("button", {
      name: "settings.importBackground",
    });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("aborts and ignores late chooser results after unmount", async () => {
    let finish!: (result: SelectedMedia) => void;
    const choose = vi.fn<MediaPort["choose"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.media = {
      choose,
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    const view = render(<CustomBackgroundPicker />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.importBackground" }),
    );
    view.unmount();
    expect(choose.mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => finish(chosen));
    expect(state.update).not.toHaveBeenCalled();
  });
  it("changes fit on the same reference", () => {
    render(<CustomBackgroundPicker />);
    fireEvent.click(
      screen.getByRole("radio", { name: "settings.backgroundCover" }),
    );
    expect(state.update).toHaveBeenCalledWith({
      background: { kind: "media", reference: chosen.reference, fit: "cover" },
    });
  });
  it("allows choosing after the Host media port changes and ignores the retired chooser", async () => {
    let finish!: (result: SelectedMedia) => void;
    const previous = vi.fn<MediaPort["choose"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.media = {
      choose: previous,
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    const view = render(<CustomBackgroundPicker />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.importBackground" }),
    );
    const next = vi.fn<MediaPort["choose"]>().mockResolvedValue(null);
    state.media = {
      choose: next,
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    view.rerender(<CustomBackgroundPicker />);
    const button = screen.getByRole("button", {
      name: "settings.importBackground",
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(next).toHaveBeenCalledOnce());
    await act(async () => finish(chosen));
    expect(state.update).not.toHaveBeenCalled();
  });
  it("restores gallery entries and renames/removes only client metadata", async () => {
    browserClientStateStore().save(
      {
        ...DEFAULT_CLIENT_STATE,
        gallery: [{ reference: chosen.reference, name: "Cloud" }],
        drafts: { view: "unsent" },
      },
      "0",
    );
    state.media = {
      choose: vi.fn(),
      resolve: vi.fn(async () => ({
        url: "blob:image",
        mime: "image/webp",
        name: "image",
        dispose: vi.fn(),
      })),
    };
    render(<CustomBackgroundPicker />);
    await screen.findByRole("button", {
      name: "settings.chooseWallpaper: Cloud",
    });
    const rename = screen.getByRole("button", {
      name: "settings.renameWallpaper: Cloud",
    });
    rename.focus();
    fireEvent.click(rename);
    fireEvent.change(
      screen.getByRole("textbox", { name: "settings.wallpaperName" }),
      { target: { value: "Renamed" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await screen.findByRole("button", {
      name: "settings.chooseWallpaper: Renamed",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "settings.renameWallpaper: Renamed",
        }),
      ).toHaveFocus(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.deleteWallpaper: Renamed" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "settings.chooseWallpaper: Renamed",
        }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "settings.importBackground" }),
      ).toHaveFocus(),
    );
    expect(browserClientStateStore().read().state).toMatchObject({
      gallery: [],
      drafts: { view: "unsent" },
    });
    expect(state.update).not.toHaveBeenCalled();
  });
  it("keeps corrupt gallery bytes and disables import until a successful retry", async () => {
    const store = browserClientStateStore();
    store.save(
      {
        ...DEFAULT_CLIENT_STATE,
        gallery: [{ reference: chosen.reference, name: "Cloud" }],
      },
      "0",
    );
    const key = sessionStorage.key(0)!;
    const original = sessionStorage.getItem(key)!;
    sessionStorage.setItem(key, original.slice(0, -2));
    state.media = {
      choose: vi.fn(),
      resolve: vi
        .fn<MediaPort["resolve"]>()
        .mockRejectedValue({ code: "MEDIA_NOT_FOUND" }),
    };
    render(<CustomBackgroundPicker />);
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "settings.importBackground" }),
    ).toBeDisabled();
    expect(sessionStorage.getItem(key)).toBe(original.slice(0, -2));
    sessionStorage.setItem(key, original);
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await ready();
  });
});
