import { createContext } from "react";
import type { Operation } from "@serial-workbench/contracts";

export type CalendarTaskMemory = Map<string, Operation>;
export const CalendarTaskMemoryContext = createContext<
  CalendarTaskMemory | undefined
>(undefined);
