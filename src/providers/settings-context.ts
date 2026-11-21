import { createContext } from "react";
import type { AppSettings } from "@/lib/settings-model";
import type { PersistenceStatus } from "@/lib/settings-sync";
import type { MediaPort } from "@/lib/media";
import type { ConnectionPreferences } from "./use-connection-preferences";
import type { AvailableNodeTheme } from "./use-node-themes";

export type SettingsContextValue = {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => Promise<void>;
  persistence: PersistenceStatus;
  persistenceError: string | null;
  persistenceEventKey?: string;
  persistenceScope?: "connection" | "shared" | "client" | "serial" | "effects";
  retrySave: () => void;
  media?: MediaPort;
  connections?: ConnectionPreferences;
  nodeThemes?: readonly AvailableNodeTheme[];
};
export const SettingsContext = createContext<SettingsContextValue | null>(null);
