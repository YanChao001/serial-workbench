import { useEffect, useRef, useState } from "react";
import {
  defaults,
  type WorkspaceDocument,
  type WorkspaceDocumentResult,
  type WorkspaceSummary,
} from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CopyPlus,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  RotateCw,
  FolderMinus,
} from "lucide-react";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchNotice } from "./workbench-notice";
import { copyWorkspace } from "./workspace-model";

/** 目录只读取摘要；明确选择后才加载文档，创建只复用工作区 CAS 保存。 */
export function WorkspacePicker({
  host,
  base,
  value,
  beforeReplace,
  onLoaded,
  onCopySaved,
  onBusyChange,
}: {
  host: Pick<
    HostContextValue,
    "listWorkspaces" | "loadWorkspace" | "saveWorkspace"
  > & { state: Pick<HostContextValue["state"], "status"> };
  base?: WorkspaceDocumentResult;
  value?: WorkspaceDocument;
  beforeReplace: () => Promise<boolean>;
  onLoaded: (value: WorkspaceDocumentResult) => void;
  onCopySaved: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const ready = host.state.status === "ready";
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [after, setAfter] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState(0);
  const [creation, setCreation] = useState<"new" | "copy" | null>(null);
  const [name, setName] = useState("");
  const [requestedId, setRequestedId] = useState("");
  const [targetOpen, setTargetOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const currentBase = useRef(base);
  currentBase.current = base;
  const pending = useRef<AbortController | null>(null);
  const reader = useRef(host.listWorkspaces);
  reader.current = host.listWorkspaces;
  useEffect(
    () => () => {
      pending.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setLoading(true);
    void reader
      .current(controller.signal, after)
      .then((result) => {
        if (controller.signal.aborted) return;
        setItems((current) => [
          ...new Map(
            [...(after ? current : []), ...result.workspaces].map((item) => [
              item.scope.target.id,
              item,
            ]),
          ).values(),
        ]);
        setCursor(result.nextCursor ?? undefined);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(nativeErrorCode(reason) ?? "HOST_UNAVAILABLE");
          setFailure((index) => index + 1);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ready, after, reload]);
  const entries = [
    ...new Map(
      [
        ...items,
        ...(base && !base.document.value.archived
          ? [
              {
                scope: base.scope,
                name: base.document.value.name,
                revision: base.document.revision,
              },
            ]
          : []),
      ].map((item) => [item.scope.target.id, item]),
    ).values(),
  ];
  const refresh = () => {
    setAfter(undefined);
    setReload((index) => index + 1);
  };
  async function run(
    action: (signal: AbortSignal) => Promise<void>,
    negotiate = false,
  ) {
    if (!ready || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      if (negotiate && !(await beforeReplace())) return;
      controller.signal.throwIfAborted();
      // 离开协商可调用编辑器保存；完成协商后才能禁用它。
      onBusyChange(true);
      await action(controller.signal);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) {
        setError(nativeErrorCode(reason) ?? "OPERATION_FAILED");
        setFailure((index) => index + 1);
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) {
          setBusy(false);
          onBusyChange(false);
        }
      }
    }
  }
  function load(id: string) {
    void run(async (signal) => {
      const loaded = await host.loadWorkspace(id, signal);
      signal.throwIfAborted();
      setTargetOpen(false);
      onLoaded(loaded);
    }, true);
  }
  function remove() {
    const selected = base?.scope.target.id;
    if (!selected || selected === "default") return;
    void run(async (signal) => {
      const current = currentBase.current;
      if (!current || current.scope.target.id !== selected) return;
      const removed = await host.saveWorkspace(
        current,
        { ...current.document.value, archived: true },
        signal,
      );
      signal.throwIfAborted();
      onLoaded(removed);
      setItems((items) =>
        items.filter((item) => item.scope.target.id !== selected),
      );
      setRemoving(false);
      const fallback = await host.loadWorkspace("default", signal);
      signal.throwIfAborted();
      onLoaded(fallback);
      refresh();
    }, true);
  }
  function create() {
    const copy = creation === "copy";
    const nextName = name.trim();
    if (!nextName || !base || (copy && !value)) return;
    const document = copy
      ? copyWorkspace(value!, nextName)
      : { ...structuredClone(defaults.workspace), name: nextName };
    void run(async (signal) => {
      const id = crypto.randomUUID();
      const target = { ...base.scope.target, id };
      const saved = await host.saveWorkspace(
        {
          scope: { scopeId: `workspace:${id}`, target },
          document: { revision: "0", value: document },
        },
        document,
        signal,
      );
      signal.throwIfAborted();
      // 保存成功即更新目录。后续加载失败也可从目录重开，不能重放保存。
      setItems((current) => [
        ...current,
        {
          scope: saved.scope,
          name: saved.document.value.name,
          revision: saved.document.revision,
        },
      ]);
      setCreation(null);
      // 目标加载会切换所有者并取消旧界面等待；副本提交后先结清原编辑草稿。
      if (copy) onCopySaved();
      const loaded = await host.loadWorkspace(id, signal);
      signal.throwIfAborted();
      onLoaded(loaded);
    }, !copy);
  }
  return (
    <>
      <div className="workbench-toolbar workbench-workspace-picker">
        <Select
          value={base?.scope.target.id ?? ""}
          disabled={!ready || busy || (loading && !base)}
          onValueChange={load}
        >
          <SelectTrigger
            aria-label={t("workbench.tools.chooseWorkspace")}
            aria-busy={loading}
          >
            <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
            <SelectValue placeholder={t("workbench.tools.chooseWorkspace")} />
          </SelectTrigger>
          <SelectContent>
            {entries.map((item, index) => (
              <SelectItem
                key={item.scope.target.id}
                value={item.scope.target.id}
              >
                {item.name ||
                  (item.scope.target.id === "default"
                    ? t("workbench.tools.defaultWorkspace")
                    : `${t("workbench.tools.workspace")} ${index + 1}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Popover
          open={creation !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setCreation(null);
          }}
        >
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={t("workbench.tools.newWorkspace")}
              disabled={!ready || busy || !base}
              onClick={() => {
                setCreation("new");
                setName("");
              }}
            >
              <FolderPlus aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <WorkbenchIconButton
            label={t("workbench.tools.saveWorkspaceAs")}
            disabled={!ready || busy || !base}
            onClick={() => {
              setCreation("copy");
              setName(
                value?.name
                  ? `${value.name} ${t("workbench.tools.workspaceCopySuffix")}`
                  : "",
              );
            }}
          >
            <CopyPlus aria-hidden="true" />
          </WorkbenchIconButton>
          <PopoverContent
            className="workbench-detail-popover workbench-workspace-create"
            aria-label={t(
              creation === "copy"
                ? "workbench.tools.saveWorkspaceAs"
                : "workbench.tools.newWorkspace",
            )}
          >
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <p className="text-sm text-muted-foreground">
                {t(
                  creation === "copy"
                    ? "workbench.tools.copyWorkspaceHint"
                    : "workbench.tools.newWorkspaceHint",
                )}
              </p>
              <label className="grid gap-1 text-sm">
                {t("workbench.tools.workspaceName")}
                <Input
                  value={name}
                  disabled={busy}
                  maxLength={128}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button size="sm" type="submit" disabled={busy || !name.trim()}>
                {t(
                  creation === "copy"
                    ? "workbench.tools.saveWorkspaceAs"
                    : "workbench.tools.createWorkspace",
                )}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
        <Popover open={targetOpen} onOpenChange={setTargetOpen}>
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={t("workbench.tools.openOtherWorkspace")}
              disabled={!ready || busy}
            >
              <FolderSearch aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent
            className="workbench-detail-popover workbench-workspace-target"
            aria-label={t("workbench.tools.openOtherWorkspace")}
          >
            <label>
              <span>{t("workbench.tools.workspaceId")}</span>
              <Input
                value={requestedId}
                onChange={(event) => setRequestedId(event.target.value)}
                autoComplete="off"
                maxLength={118}
              />
            </label>
            <Button
              size="sm"
              disabled={!ready || busy || !requestedId.trim()}
              onClick={() => load(requestedId.trim())}
            >
              {t("workbench.tools.load")}
            </Button>
          </PopoverContent>
        </Popover>
        <Popover open={removing} onOpenChange={setRemoving}>
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={t("workbench.tools.removeWorkspace")}
              disabled={
                !ready || busy || !base || base.scope.target.id === "default"
              }
            >
              <FolderMinus aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent
            role="dialog"
            aria-label={t("workbench.tools.removeWorkspace")}
            className="workbench-detail-popover grid gap-3"
          >
            <p className="font-medium">
              {t("workbench.tools.removeWorkspace")}:{" "}
              {base?.document.value.name}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("workbench.tools.removeWorkspaceHelp")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={remove}>
                {t("workbench.tools.removeWorkspace")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <WorkbenchIconButton
          label={t("workbench.tools.refreshWorkspaces")}
          disabled={!ready || busy || loading}
          onClick={refresh}
        >
          <RotateCw aria-hidden="true" />
        </WorkbenchIconButton>
        {cursor && (
          <Button
            size="sm"
            variant="outline"
            disabled={loading || busy}
            onClick={() => setAfter(cursor)}
          >
            {t("workbench.tools.moreWorkspaces")}
          </Button>
        )}
      </div>
      <WorkbenchNotice
        noticeKey={`workspace-picker:${failure}:${error}`}
        log={{
          module: "workspace",
          level: "error",
          code: error,
          message: error ? nativeErrorText({ code: error }, t) : "",
        }}
      >
        {error ? (
          <span role="alert">{nativeErrorText({ code: error }, t)}</span>
        ) : null}
      </WorkbenchNotice>
    </>
  );
}
