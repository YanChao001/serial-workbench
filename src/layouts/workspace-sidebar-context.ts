import { createContext, type Dispatch, type SetStateAction } from "react";

export const WorkspaceSidebarContext = createContext<
  | {
      width: number | undefined;
      setWidth: Dispatch<SetStateAction<number | undefined>>;
    }
  | undefined
>(undefined);
