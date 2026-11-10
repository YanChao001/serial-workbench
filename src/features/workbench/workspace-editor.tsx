import { useEffect, useId, useRef, useState } from "react";
import type {
  SerialConfiguration,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  WorkspaceView,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { stateScopeKey } from "@/lib/host-scope";
import { diffWorkspaceImport } from "./workspace-import";
import {
  SerialConfigurationFields,
  type SerialConfigurationLabels,
} from "./serial-configuration-fields";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { nativeErrorCode } from "@/lib/native-error";
import {
  RotateCw,
  Undo2,
  FileDown,
  FileUp,
  Info,
  FolderOpen,
} from "lucide-react";
import { WorkbenchIconButton } from "./workbench-icon-button";

export type WorkspaceEditorLabels = {
  configurationLabels: SerialConfigurationLabels;
  defaultIcon: string;
  defaultWorkspaceName: string;
  details: string;
  chooseImportFile: string;
  emptyImportFile: string;
  enteredImportContent: string;
  failure: (code: string) => string;
  title: string;
  workspaceName: string;
  viewName: string;
  color: string;
  icon: string;
  pinned: string;
  receiveMode: string;
  sendMode: string;
  text: string;
  hex: string;
  binding: string;
  configuration: string;
  baudRate: string;
  dataBits: string;
  parity: string;
  stopBits: string;
  flowControl: string;
  readWaitMs: string;
  writeWaitMs: string;
  reconnectBackoffMs: string;
  sidebarWidth: string;
  panelHeight: string;
  save: string;
  reload: string;
  discard: string;
  clone: string;
  unavailable: string;
  conflict: string;
  saved: string;
  import: string;
  export: string;
  apply: string;
  cancelImport: string;
  changes: string;
  noView: string;
  importUnavailable: string;
  importJson?: string;
  importFile?: string;
  previewImport?: string;
  added?: string;
  removed?: string;
  changed?: string;
  before?: string;
  after?: string;
  noChanges?: string;
  views?: string;
  bindings?: string;
  favorites?: string;
  layout?: string;
  captures?: string;
  order?: string;
  editedWhileSaving?: string;
};
export type WorkspaceEditorProps = {
  base: WorkspaceDocumentResult;
  value?: WorkspaceDocument;
  selectedViewId?: string;
  disabled?: boolean;
  maxImportBytes?: string;
  labels: WorkspaceEditorLabels;
  onChange?: (value: WorkspaceDocument) => void;
  onSelectView?: (viewId: string) => void;
  onAcknowledged?: (result: WorkspaceDocumentResult) => void;
  onSave?: (
    base: WorkspaceDocumentResult,
    value: WorkspaceDocument,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDocumentResult>;
  onReload?: (signal?: AbortSignal) => Promise<WorkspaceDocumentResult>;
  onPreviewImport?: (
    json: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDocument>;
  onExport?: (
    base: WorkspaceDocumentResult,
    signal?: AbortSignal,
  ) => Promise<void>;
};

export function cloneWorkspaceView(
  value: WorkspaceDocument,
  viewId: string,
): { value: WorkspaceDocument; viewId: string } | undefined {
  const source = value.views.find((view) => view.id === viewId);
  const binding = value.bindings.find(
    (item) => item.bindingId === source?.bindingId,
  );
  if (!source || !binding) return undefined;
  const id = `view-${crypto.randomUUID()}`;
  const bindingId = `binding-${crypto.randomUUID()}`;
  return {
    viewId: id,
    value: {
      ...value,
      views: [...value.views, { ...source, id, bindingId }],
      bindings: [...value.bindings, { ...structuredClone(binding), bindingId }],
      favoriteBindingIds: value.favoriteBindingIds.includes(binding.bindingId)
        ? [...value.favoriteBindingIds, bindingId]
        : value.favoriteBindingIds,
    },
  };
}

export function WorkspaceEditor(props: WorkspaceEditorProps) {
  return (
    <WorkspaceEditorDraft key={stateScopeKey(props.base.scope)} {...props} />
  );
}

function WorkspaceEditorDraft({
  base,
  value,
  selectedViewId,
  disabled = false,
  maxImportBytes = "1048576",
  labels,
  onChange,
  onSelectView,
  onAcknowledged,
  onSave,
  onReload,
  onExport,
  onPreviewImport,
}: WorkspaceEditorProps) {
  const [original, setOriginal] = useState(base);
  const [local, setLocal] = useState(base.document.value);
  const [localSelection, setLocalSelection] = useState(
    selectedViewId ?? base.document.value.views[0]?.id,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [eventKey, setEventKey] = useState<string>();
  const [failureIndex, setFailureIndex] = useState(0);
  const [saved, setSaved] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importFileName, setImportFileName] = useState<string>();
  const importFileControl = useRef<HTMLInputElement | null>(null);
  const [candidate, setCandidate] = useState<WorkspaceDocument>();
  const importGeneration = useRef(0);
  const importPending = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const draft = value ?? local;
  const latest = useRef(draft);
  latest.current = draft;
  const id = useId();
  const view = draft.views.find(
    (item) => item.id === (selectedViewId ?? localSelection),
  );
  const binding = draft.bindings.find(
    (item) => item.bindingId === view?.bindingId,
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(original.document.value);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  function change(next: WorkspaceDocument) {
    setLocal(next);
    onChange?.(next);
    setSaved(false);
  }
  async function request<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    dedupeOperationFailure = false,
  ) {
    signal?.throwIfAborted();
    if (pending.current) throw new Error(labels.unavailable);
    const controller = new AbortController();
    const release = () => {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    };
    controller.signal.addEventListener("abort", release, { once: true });
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    setEventKey(undefined);
    setSaved(false);
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(nativeErrorCode(reason) ?? "OPERATION_FAILED");
        setEventKey(
          dedupeOperationFailure ? operationFailureEventKey(reason) : undefined,
        );
        setFailureIndex((value) => value + 1);
      }
      throw reason;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", release);
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function save(signal?: AbortSignal) {
    if (!onSave || disabled) throw new Error(labels.unavailable);
    const snapshot = draft;
    const result = await request(
      (nextSignal) => onSave(original, snapshot, nextSignal),
      signal,
      true,
    );
    setOriginal(result);
    const unchanged =
      JSON.stringify(latest.current) === JSON.stringify(snapshot);
    if (unchanged) change(result.document.value);
    setSaved(unchanged);
    onAcknowledged?.(result);
    if (!unchanged && signal)
      throw new Error(labels.editedWhileSaving ?? "New changes need saving");
  }
  async function reload() {
    if (!onReload) return;
    const snapshot = latest.current;
    const result = await request(onReload);
    setOriginal(result);
    if (JSON.stringify(latest.current) === JSON.stringify(snapshot)) {
      change(result.document.value);
      onAcknowledged?.(result);
    }
  }
  function invalidateImport() {
    importGeneration.current += 1;
    if (importPending.current) {
      pending.current?.abort();
      importPending.current = false;
    }
    setCandidate(undefined);
  }
  function changeImportJson(json: string) {
    invalidateImport();
    setImportJson(json);
    setImportFileName(undefined);
  }
  function cancelImport() {
    invalidateImport();
    setImportOpen(false);
    setImportJson("");
    setImportFileName(undefined);
  }
  async function previewImport() {
    if (!onPreviewImport || disabled) return;
    const generation = importGeneration.current;
    importPending.current = true;
    try {
      const next = await request((signal) =>
        onPreviewImport(importJson, signal),
      );
      if (generation === importGeneration.current) setCandidate(next);
    } finally {
      if (generation === importGeneration.current)
        importPending.current = false;
    }
  }
  async function readImportFile(file: File) {
    invalidateImport();
    setImportJson("");
    setImportFileName(file.name);
    const generation = importGeneration.current;
    importPending.current = true;
    try {
      const json = await request(() => {
        if (BigInt(file.size) > BigInt(maxImportBytes))
          throw { code: "MESSAGE_TOO_LARGE" };
        return file.text();
      });
      if (generation === importGeneration.current) setImportJson(json);
    } finally {
      if (generation === importGeneration.current)
        importPending.current = false;
    }
  }
  async function applyImport(signal?: AbortSignal) {
    if (!onSave || !candidate || disabled) return;
    const snapshot = latest.current;
    const imported = candidate;
    const generation = importGeneration.current;
    const result = await request(
      (requestSignal) => onSave(original, imported, requestSignal),
      signal,
      true,
    );
    setOriginal(result);
    const unchanged =
      JSON.stringify(latest.current) === JSON.stringify(snapshot);
    if (unchanged) change(result.document.value);
    const sourceUnchanged = generation === importGeneration.current;
    setSaved(unchanged && sourceUnchanged);
    if (sourceUnchanged) {
      setCandidate(undefined);
      setImportOpen(false);
      setImportJson("");
      setImportFileName(undefined);
    }
    onAcknowledged?.(result);
    if (signal && (!unchanged || !sourceUnchanged))
      throw new Error(labels.editedWhileSaving ?? "New changes need saving");
  }
  const importChanges = candidate ? diffWorkspaceImport(draft, candidate) : [];
  function changeName(item: (typeof importChanges)[number]) {
    if (item.key === "$order") return labels.order ?? "Order";
    for (const value of [item.after, item.before])
      if (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        typeof value.name === "string"
      )
        return value.name;
    return "";
  }
  const sectionLabels = {
    name: labels.workspaceName,
    views: labels.views ?? labels.viewName,
    bindings: labels.bindings ?? labels.binding,
    favoriteBindingIds: labels.favorites ?? "Favorites",
    layout: labels.layout ?? "Layout",
    captures: labels.captures ?? "Capture references",
  };
  function discard() {
    change(original.document.value);
    setError(undefined);
  }
  useUnsavedWork({
    id: `workspace-configuration-${base.scope.scopeId}`,
    label: importOpen && importJson ? labels.import : labels.title,
    dirty: dirty || Boolean(importOpen && importJson),
    save:
      importOpen && importJson
        ? candidate && onSave
          ? applyImport
          : undefined
        : save,
    discard: () => {
      discard();
      cancelImport();
    },
  });
  function editView(patch: Partial<WorkspaceView>) {
    if (view)
      change({
        ...draft,
        views: draft.views.map((item) =>
          item.id === view.id ? { ...item, ...patch } : item,
        ),
      });
  }
  function editConfiguration(patch: Partial<SerialConfiguration>) {
    if (binding)
      change({
        ...draft,
        bindings: draft.bindings.map((item) =>
          item.bindingId === binding.bindingId
            ? { ...item, configuration: { ...item.configuration, ...patch } }
            : item,
        ),
      });
  }
  function clone() {
    const next = view && cloneWorkspaceView(draft, view.id);
    if (next) {
      change(next.value);
      setLocalSelection(next.viewId);
      onSelectView?.(next.viewId);
    }
  }
  const locked = disabled || busy;
  const choice = (
    label: string,
    current: string,
    options: readonly string[],
    onValueChange: (next: string) => void,
  ) => (
    <label className="grid min-w-0 gap-1 text-sm">
      <span>{label}</span>
      <Select value={current} onValueChange={onValueChange} disabled={locked}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((item) => (
            <SelectItem key={item} value={item}>
              {item === "text"
                ? labels.text
                : item === "hex"
                  ? labels.hex
                  : label === labels.binding
                    ? (draft.views.find((view) => view.bindingId === item)
                        ?.name ??
                      `${labels.binding} ${draft.bindings.findIndex((binding) => binding.bindingId === item) + 1}`)
                    : item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
  return (
    <section
      aria-label={labels.title}
      aria-busy={busy}
      className="workbench-workspace-editor"
    >
      <h2 className="sr-only">{labels.title}</h2>
      <div className="workbench-workspace-content app-scroll-region">
        <fieldset
          disabled={disabled}
          hidden={importOpen}
          className="workbench-workspace-fields"
        >
          <label className="grid gap-1 text-sm">
            {labels.workspaceName}
            <Input
              value={draft.name}
              placeholder={labels.defaultWorkspaceName}
              onChange={(event) =>
                change({ ...draft, name: event.target.value })
              }
            />
          </label>
          {draft.views.length > 0 && (
            <label className="grid gap-1 text-sm">
              {labels.views ?? labels.viewName}
              <Select
                value={view?.id ?? ""}
                onValueChange={(viewId) => {
                  setLocalSelection(viewId);
                  onSelectView?.(viewId);
                }}
                disabled={locked}
              >
                <SelectTrigger aria-label={labels.views ?? labels.viewName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {draft.views.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {view ? (
            <>
              <div className="workbench-workspace-view-fields">
                <label className="grid gap-1 text-sm">
                  {labels.viewName}
                  <Input
                    value={view.name}
                    onChange={(event) => editView({ name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {labels.color}
                  <Input
                    value={view.color}
                    onChange={(event) =>
                      editView({ color: event.target.value })
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {labels.icon}
                  <Input
                    value={view.icon === "terminal" ? "" : view.icon}
                    placeholder={labels.defaultIcon}
                    onChange={(event) =>
                      editView({ icon: event.target.value || "terminal" })
                    }
                  />
                </label>
                <label
                  htmlFor={`${id}-pinned`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span>{labels.pinned}</span>
                  <Checkbox
                    id={`${id}-pinned`}
                    checked={view.pinned}
                    onCheckedChange={(checked) =>
                      editView({ pinned: checked === true })
                    }
                    disabled={locked}
                  />
                </label>
                {choice(
                  labels.receiveMode,
                  view.receiveMode,
                  ["text", "hex"],
                  (mode) => {
                    if (mode === "text" || mode === "hex")
                      editView({ receiveMode: mode });
                  },
                )}
                {choice(
                  labels.sendMode,
                  view.sendMode,
                  ["text", "hex"],
                  (mode) => {
                    if (mode === "text" || mode === "hex")
                      editView({ sendMode: mode });
                  },
                )}
                {choice(
                  labels.binding,
                  view.bindingId,
                  draft.bindings.map((item) => item.bindingId),
                  (bindingId) => editView({ bindingId }),
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!binding || locked}
                onClick={clone}
              >
                {labels.clone}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{labels.noView}</p>
          )}
          {binding && (
            <fieldset className="workbench-workspace-configuration">
              <legend>{labels.configuration}</legend>
              <SerialConfigurationFields
                id={id + "-binding"}
                value={binding.configuration}
                labels={labels.configurationLabels}
                onChange={(value) => editConfiguration(value)}
              />
            </fieldset>
          )}
        </fieldset>
        {importOpen && (
          <section
            aria-label={labels.import}
            className="workbench-workspace-import"
          >
            <div className="workbench-workspace-import-file">
              <label htmlFor={`${id}-import-file`}>
                {labels.importFile ?? "Configuration file"}
              </label>
              <div className="workbench-file-selection">
                <output>
                  {importFileName ??
                    (importJson
                      ? labels.enteredImportContent
                      : labels.emptyImportFile)}
                </output>
                <WorkbenchIconButton
                  label={labels.chooseImportFile}
                  variant="outline"
                  disabled={disabled || (busy && !importPending.current)}
                  onClick={() => importFileControl.current?.click()}
                >
                  <FolderOpen aria-hidden="true" />
                </WorkbenchIconButton>
                <Input
                  ref={importFileControl}
                  id={`${id}-import-file`}
                  className="sr-only"
                  tabIndex={-1}
                  type="file"
                  accept=".json,application/json"
                  disabled={disabled || (busy && !importPending.current)}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void readImportFile(file).catch(() => {});
                  }}
                />
              </div>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  {labels.importJson ?? "Configuration content"}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="workbench-detail-popover"
                aria-label={labels.importJson ?? "Configuration content"}
              >
                <label className="grid gap-1 text-sm">
                  {labels.importJson ?? "Configuration content"}
                  <Textarea
                    value={importJson}
                    disabled={disabled || (busy && !importPending.current)}
                    rows={6}
                    onChange={(event) => changeImportJson(event.target.value)}
                  />
                </label>
              </PopoverContent>
            </Popover>
            {candidate && (
              <section
                aria-label={labels.changes}
                className="grid min-w-0 gap-2"
              >
                <h3 className="text-sm font-medium">{labels.changes}</h3>
                {importChanges.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {labels.noChanges ?? "No changes"}
                  </p>
                ) : (
                  <ul className="grid max-h-64 gap-3 overflow-auto text-sm">
                    {importChanges.map((item) => (
                      <li
                        key={`${item.section}/${item.key}`}
                        className="grid min-w-0 gap-1"
                      >
                        <p>
                          {sectionLabels[item.section]} · {changeName(item)} ·{" "}
                          <span>
                            {labels[item.kind] ??
                              {
                                added: "Added",
                                removed: "Removed",
                                changed: "Changed",
                              }[item.kind]}
                          </span>
                        </p>
                        {item.section === "name" && item.kind !== "added" && (
                          <div>
                            <span className="text-muted-foreground">
                              {labels.before ?? "Current draft"}
                            </span>
                            <p>
                              {typeof item.before === "string"
                                ? item.before
                                : ""}
                            </p>
                          </div>
                        )}
                        {item.section === "name" && item.kind !== "removed" && (
                          <div>
                            <span className="text-muted-foreground">
                              {labels.after ?? "Import candidate"}
                            </span>
                            <p>
                              {typeof item.after === "string" ? item.after : ""}
                            </p>
                          </div>
                        )}
                        <Popover>
                          <PopoverTrigger asChild>
                            <WorkbenchIconButton label={labels.details}>
                              <Info aria-hidden="true" />
                            </WorkbenchIconButton>
                          </PopoverTrigger>
                          <PopoverContent
                            className="workbench-detail-popover"
                            aria-label={labels.details}
                          >
                            <Textarea
                              readOnly
                              aria-label={labels.details}
                              rows={8}
                              value={JSON.stringify(
                                { before: item.before, after: item.after },
                                null,
                                2,
                              )}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                          </PopoverContent>
                        </Popover>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </section>
        )}
        <WorkbenchNotice
          noticeKey={`workspace-editor:${failureIndex}`}
          eventKey={eventKey}
          log={{
            module: "workspace",
            level: "error",
            code: error,
            message: error
              ? error === "REVISION_CONFLICT"
                ? labels.conflict
                : labels.failure(error)
              : "",
          }}
        >
          {error ? (
            <span role="alert">
              {error === "REVISION_CONFLICT"
                ? labels.conflict
                : labels.failure(error)}
            </span>
          ) : null}
        </WorkbenchNotice>
        {saved && (
          <p role="status" className="sr-only">
            {labels.saved}
          </p>
        )}
      </div>
      <div className="workbench-workspace-actions">
        {importOpen ? (
          <>
            <Button
              size="sm"
              disabled={
                locked ||
                !importJson.trim() ||
                !onPreviewImport ||
                (!!candidate && !onSave)
              }
              onClick={() =>
                void (candidate ? applyImport() : previewImport()).catch(
                  () => {},
                )
              }
            >
              {candidate
                ? labels.apply
                : (labels.previewImport ?? "Preview import")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || (busy && !importPending.current)}
              onClick={cancelImport}
            >
              {labels.cancelImport}
            </Button>
            <WorkbenchIconButton
              label={labels.reload}
              disabled={locked || !onReload}
              onClick={() => void reload().catch(() => {})}
            >
              <RotateCw aria-hidden="true" />
            </WorkbenchIconButton>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={locked || !dirty || !onSave}
              onClick={() => void save().catch(() => {})}
            >
              {labels.save}
            </Button>
            <WorkbenchIconButton
              label={labels.reload}
              disabled={locked || !onReload}
              onClick={() => void reload().catch(() => {})}
            >
              <RotateCw aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.discard}
              disabled={locked || !dirty}
              onClick={discard}
            >
              <Undo2 aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.import}
              tooltip={!onPreviewImport ? labels.importUnavailable : undefined}
              disabled={locked || !onPreviewImport}
              onClick={() => setImportOpen(true)}
            >
              <FileDown aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.export}
              disabled={locked || !onExport}
              onClick={() => {
                if (onExport)
                  void request((signal) => onExport(original, signal)).catch(
                    () => {},
                  );
              }}
            >
              <FileUp aria-hidden="true" />
            </WorkbenchIconButton>
          </>
        )}
      </div>
    </section>
  );
}
