import { createContext, useContext, useState } from "react";
import {
  createClientDraftStore,
  type ClientDraftStore,
} from "@/features/workbench/client-drafts";
import {
  readClientWindowState,
  saveClientWindowState,
} from "@/lib/client-settings";

export const ClientDraftsContext = createContext<ClientDraftStore | null>(null);
export function createWindowDraftStore() {
  return createClientDraftStore({
    read: readClientWindowState,
    save: saveClientWindowState,
  });
}
export function useClientDraftStore(override?: ClientDraftStore) {
  const shared = useContext(ClientDraftsContext);
  const [local] = useState(
    () => override ?? shared ?? createWindowDraftStore(),
  );
  return override ?? shared ?? local;
}
