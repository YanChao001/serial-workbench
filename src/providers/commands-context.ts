import { createContext } from "react";
import type { AppCommand } from "@/commands/types";
import type { ShortcutBinding } from "@/lib/generated/bindings";
import type { useGlobalSendShortcut } from "./use-global-send-shortcut";

export type CommandsContextValue = {
  commands: AppCommand[];
  execute: (id: string) => Promise<boolean>;
  register: (commands: readonly AppCommand[]) => () => void;
  paletteOpen: boolean;
  shortcutHelp: boolean;
  changeShortcut?: (id: string, binding: ShortcutBinding) => void;
  globalSend?: ReturnType<typeof useGlobalSendShortcut>;
  setPaletteOpen: (open: boolean) => void;
  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;
  fullscreen: boolean;
};

export const CommandsContext = createContext<CommandsContextValue | null>(null);
export const ActivityNavigationContext = createContext<
  ((pageId: string) => void) | undefined
>(undefined);
