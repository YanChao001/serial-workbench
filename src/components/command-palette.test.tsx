import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppCommand } from "@/commands/types";
import { CommandsContext } from "@/providers/commands-context";
import { CommandPalette } from "./command-palette";

vi.mock("@/providers/i18n", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const { en } = await import("@/i18n/en");
  return { useI18n: () => ({ t: createTranslator(en), language: "en" }) };
});

const execute = vi.fn(async () => true);
const commands: AppCommand[] = [
  {
    id: "settings",
    labelKey: "nav.settings",
    group: "navigation",
    run: () => {},
  },
  {
    id: "extension-command",
    labelKey: "ext.title",
    label: "Plugin action",
    group: "tools",
    run: () => {},
  },
  {
    id: "unavailable",
    labelKey: "nav.settings",
    label: "Unavailable action",
    group: "tools",
    available: () => false,
    run: () => {},
  },
];
function Palette() {
  const [paletteOpen, setPaletteOpen] = useState(true);
  return (
    <MemoryRouter>
      <CommandsContext.Provider
        value={{
          commands,
          register: () => () => {},
          paletteOpen,
          setPaletteOpen,
          execute,
          aboutOpen: false,
          setAboutOpen: () => {},
          fullscreen: false,
        }}
      >
        <CommandPalette />
      </CommandsContext.Provider>
    </MemoryRouter>
  );
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("filters registered application actions", () => {
  render(<Palette />);
  fireEvent.change(screen.getByRole("combobox", { name: "Quick actions" }), {
    target: { value: "settings" },
  });
  expect(screen.getByRole("option", { name: "Settings" })).toBeVisible();
});

it("executes plugin commands and closes the palette while excluding unavailable actions", async () => {
  const user = userEvent.setup();
  render(<Palette />);
  expect(
    screen.queryByRole("option", { name: "Unavailable action" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Plugin action" }));
  expect(execute).toHaveBeenCalledExactlyOnceWith("extension-command");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("shows an empty state for unmatched commands", () => {
  render(<Palette />);
  fireEvent.change(screen.getByRole("combobox", { name: "Quick actions" }), {
    target: { value: "unmatched" },
  });
  expect(screen.getByText("No matching actions")).toBeVisible();
});
