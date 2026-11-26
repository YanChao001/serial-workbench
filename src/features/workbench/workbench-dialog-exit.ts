import { createContext } from "react";

export const WorkbenchDialogExit = createContext<
  (() => Promise<boolean>) | null
>(null);
