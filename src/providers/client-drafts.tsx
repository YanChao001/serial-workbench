import { useState, type ReactNode } from "react";
import {
  ClientDraftsContext,
  createWindowDraftStore,
} from "./client-drafts-context";

/** 草稿缓存归当前窗口，页面卸载不重启恢复流程。 */
export function ClientDraftsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createWindowDraftStore);
  return <ClientDraftsContext value={store}>{children}</ClientDraftsContext>;
}
