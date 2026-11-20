import { createContext } from "react";
import type { LanRoute } from "@serial-workbench/contracts";

export const LanWorkbenchContext = createContext<{
  route: LanRoute | undefined;
  title: string;
  source: string;
  description?: string;
  open: (returnFocus: HTMLButtonElement | null) => void;
} | null>(null);
