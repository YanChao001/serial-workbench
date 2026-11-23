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
    id: "registered-command",
    labelKey: "common.save",
    label: "Registered action",
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
function Palette({
  shortcutHelp = false,
  registered = commands,
}: {
  shortcutHelp?: boolean;
  registered?: AppCommand[];
} = {}) {
  const [paletteOpen, setPaletteOpen] = useState(true);
  return (
    <MemoryRouter>
      <CommandsContext.Provider
        value={{
          commands: registered,
          register: () => () => {},
          paletteOpen,
          shortcutHelp,
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

it("executes registered commands and closes the palette while excluding unavailable actions", async () => {
  const user = userEvent.setup();
  render(<Palette />);
  expect(
    screen.queryByRole("option", { name: "Unavailable action" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Registered action" }));
  expect(execute).toHaveBeenCalledExactlyOnceWith("registered-command");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("shows an empty state for unmatched commands", () => {
  render(<Palette />);
  fireEvent.change(screen.getByRole("combobox", { name: "Quick actions" }), {
    target: { value: "unmatched" },
  });
  expect(screen.getByText("No matching actions")).toBeVisible();
});

it("finds editor keys and marks collisions between available registered commands", () => {
  render(
    <Palette
      shortcutHelp
      registered={commands.map((command) => ({
        ...command,
        shortcuts: [{ key: "F8" }],
      }))}
    />,
  );
  const search = screen.getByRole("searchbox", {
    name: "Search keyboard shortcuts",
  });
  fireEvent.change(search, { target: { value: "F8" } });
  expect(
    screen.getAllByText("Shortcut is shared by multiple actions"),
  ).toHaveLength(2);
  expect(screen.queryByText("Unavailable action")).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "enter hex" } });
  expect(screen.getByText("Send draft")).toBeVisible();
  expect(screen.getByText("Send editor in Text or HEX mode")).toBeVisible();
  expect(screen.queryByText("Registered action")).not.toBeInTheDocument();
  expect(execute).not.toHaveBeenCalled();
});
