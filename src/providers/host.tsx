import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createHostWorkspace, getHostClient } from "@/lib/host-client";
import type { HostConnection } from "@/lib/host-client";
import { isTauri } from "@/lib/tauri";
import { HostRequestError } from "@serial-workbench/host-client";
import { HostContext } from "./host-context";
import type { HostContextValue, HostState } from "./host-context";

function unavailable(): never {
  throw new Error("Host is not connected");
}
function attachmentFailed(error: unknown) {
  return (
    error instanceof HostRequestError &&
    ["HOST_START_FAILED", "UNAUTHENTICATED", "EPOCH_MISMATCH"].includes(
      error.code,
    )
  );
}
const empty = (status: HostState["status"]): HostContextValue => ({
  state: {
    status,
    error: null,
    devices: [],
    devicesStale: false,
    catalog: [],
    sessions: [],
    operations: [],
    operationSummaries: [],
    streams: new Map(),
  },
  refresh: async () => unavailable(),
  metrics: async () => unavailable(),
  sessionMetrics: async () => unavailable(),
  sessionInputs: async () => unavailable(),
  operationInput: async () => unavailable(),
  pickFile: async () => unavailable(),
  trustedConnect: async () => unavailable(),
  readFile: async () => unavailable(),
  fileMetadata: async () => unavailable(),
  readReplayRecord: async () => unavailable(),
  readCaptureTail: async () => unavailable(),
  captureStatus: async () => unavailable(),
  readFileReceipts: async () => unavailable(),
  readReplay: async () => unavailable(),
  loadWorkspace: async () => unavailable(),
  saveWorkspace: async () => unavailable(),
  saveFavorites: async () => unavailable(),
  rebindDevice: async () => unavailable(),
  recentConnections: async () => unavailable(),
  exportWorkspace: async () => unavailable(),
  previewWorkspaceImport: async () => unavailable(),
  waitForOperation: async () => unavailable(),
  checkAction: async () => unavailable(),
  watchActions: (inputs, listener) => {
    listener(inputs.map((input) => ({ input, result: null, error: null })));
    return () => {};
  },
  open: async () => unavailable(),
  send: async () => unavailable(),
  takeover: async () => unavailable(),
  invoke: async () => unavailable(),
  watchSession: () => () => {},
});
export function HostProvider({
  children,
  connect = getHostClient,
  desktop = isTauri(),
}: {
  children: ReactNode;
  connect?: () => Promise<HostConnection>;
  desktop?: boolean;
}) {
  const [value, setValue] = useState(() =>
    empty(desktop ? "connecting" : "preview"),
  );
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let workspace: ReturnType<typeof createHostWorkspace> | undefined;
    let attaching: Promise<void> | undefined;
    const disposeWorkspace = () => {
      const previous = workspace;
      workspace = undefined;
      previous?.dispose();
    };
    const publish = (owner: typeof workspace) => {
      if (active && owner && workspace === owner) {
        const current = owner.getSnapshot();
        if (attachmentFailed(current.state.error)) {
          disposeWorkspace();
          failed(current.state.error);
        } else setValue({ ...current, refresh });
      }
    };
    const failed = (error: unknown) => {
      if (active)
        setValue({
          ...empty("error"),
          refresh,
          state: {
            ...empty("error").state,
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
    };
    const attach = async () => {
      if (!active) return;
      if (attaching) return attaching;
      disposeWorkspace();
      attaching = (async () => {
        const connection = await connect();
        if (!active) {
          connection.dispose();
          return;
        }
        const attachedWorkspace = createHostWorkspace(connection);
        workspace = attachedWorkspace;
        attachedWorkspace.subscribe(() => publish(attachedWorkspace));
        publish(attachedWorkspace);
        await attachedWorkspace.refresh();
      })();
      try {
        await attaching;
      } catch (error) {
        if (workspace && !attachmentFailed(error)) {
          // 首次元数据查询失败也保留已认证连接，独立的设置订阅继续工作。
          publish(workspace);
        } else {
          disposeWorkspace();
          failed(error);
        }
      } finally {
        attaching = undefined;
      }
    };
    async function refresh() {
      if (!workspace || attachmentFailed(workspace.getSnapshot().state.error))
        return attach();
      const refreshing = workspace;
      try {
        await refreshing.refresh();
      } catch (error) {
        if (active && workspace === refreshing && attachmentFailed(error)) {
          disposeWorkspace();
          failed(error);
        }
        throw error;
      }
    }
    void attach();
    return () => {
      active = false;
      workspace?.dispose();
    };
  }, [connect, desktop]);
  return <HostContext value={value}>{children}</HostContext>;
}
