import { createContext } from "react";

export type UnsavedWork = {
  id: string;
  label: string;
  dirty: boolean;
  save: (signal?: AbortSignal) => Promise<void>;
  discard: (signal?: AbortSignal) => void | Promise<void>;
};
type Registry = {
  register: (work: UnsavedWork, scope?: string) => void;
  unregister: (id: string) => void;
  requestLeave: (scope: string, signal?: AbortSignal) => Promise<boolean>;
  releaseScope: (scope: string) => void;
};
export const UnsavedWorkContext = createContext<Registry | null>(null);
export const UnsavedWorkScopeContext = createContext<string | undefined>(
  undefined,
);
