import { createContext } from "react";

export const dismissWorkbenchPopup = "workbench:dismiss-popup";

export const WorkbenchDialogExit = createContext<
  (() => Promise<boolean>) | null
>(null);
