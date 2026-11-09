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
import { diffWorkspaceImport } from "./workspace-import";

export type WorkspaceEditorLabels = {
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
    <WorkspaceEditorDraft key={JSON.stringify(props.base.scope)} {...props} />
  );
}

function WorkspaceEditorDraft({
  base,
  value,
  selectedViewId,
  disabled = false,
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
  const [saved, setSaved] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
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
    setSaved(false);
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (reason) {
      if (!controller.signal.aborted) {
        const code =
          typeof reason === "object" && reason !== null && "code" in reason
            ? reason.code
            : undefined;
        const message =
          reason instanceof Error
            ? reason.message
            : typeof reason === "object" &&
                reason !== null &&
                "message" in reason
              ? String(reason.message)
              : String(reason);
        setError(code === "REVISION_CONFLICT" ? labels.conflict : message);
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
  }
  function cancelImport() {
    invalidateImport();
    setImportOpen(false);
    setImportJson("");
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
    const generation = importGeneration.current;
    importPending.current = true;
    try {
      const json = await request(() => file.text());
      if (generation === importGeneration.current) setImportJson(json);
    } finally {
      if (generation === importGeneration.current)
        importPending.current = false;
    }
  }
  async function applyImport() {
    if (!onSave || !candidate || disabled) return;
    const snapshot = latest.current;
    const imported = candidate;
    const result = await request((signal) =>
      onSave(original, imported, signal),
    );
    setOriginal(result);
    if (JSON.stringify(latest.current) === JSON.stringify(snapshot))
      change(result.document.value);
    setSaved(JSON.stringify(latest.current) === JSON.stringify(snapshot));
    setCandidate(undefined);
    setImportOpen(false);
    onAcknowledged?.(result);
  }
  const importChanges = candidate ? diffWorkspaceImport(draft, candidate) : [];
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
    label: labels.title,
    dirty,
    save,
    discard,
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
      className="grid gap-3 p-3"
    >
      <h2 className="text-sm font-medium">{labels.title}</h2>
      <fieldset disabled={disabled} className="grid min-w-0 gap-3">
        <label className="grid gap-1 text-sm">
          {labels.workspaceName}
          <Input
            value={draft.name}
            onChange={(event) => change({ ...draft, name: event.target.value })}
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
            <div className="grid gap-3 sm:grid-cols-2">
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
                  onChange={(event) => editView({ color: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {labels.icon}
                <Input
                  value={view.icon}
                  onChange={(event) => editView({ icon: event.target.value })}
                />
              </label>
              <label
                htmlFor={`${id}-pinned`}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={`${id}-pinned`}
                  checked={view.pinned}
                  onCheckedChange={(checked) =>
                    editView({ pinned: checked === true })
                  }
                  disabled={locked}
                />
                {labels.pinned}
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
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="text-sm font-medium">
              {labels.configuration}
            </legend>
            {(
              [
                "baudRate",
                "readWaitMs",
                "writeWaitMs",
                "reconnectBackoffMs",
              ] as const
            ).map((key) => (
              <label key={key} className="grid gap-1 text-sm">
                {labels[key]}
                <Input
                  inputMode="numeric"
                  value={binding.configuration[key]}
                  onChange={(event) =>
                    editConfiguration({ [key]: event.target.value })
                  }
                />
              </label>
            ))}
            {choice(
              labels.dataBits,
              binding.configuration.dataBits,
              ["5", "6", "7", "8"],
              (dataBits) => {
                if (
                  dataBits === "5" ||
                  dataBits === "6" ||
                  dataBits === "7" ||
                  dataBits === "8"
                )
                  editConfiguration({ dataBits });
              },
            )}
            {choice(
              labels.parity,
              binding.configuration.parity,
              ["none", "even", "odd", "mark", "space"],
              (parity) => {
                if (
                  parity === "none" ||
                  parity === "even" ||
                  parity === "odd" ||
                  parity === "mark" ||
                  parity === "space"
                )
                  editConfiguration({ parity });
              },
            )}
            {choice(
              labels.stopBits,
              binding.configuration.stopBits,
              ["one", "onePointFive", "two"],
              (stopBits) => {
                if (
                  stopBits === "one" ||
                  stopBits === "onePointFive" ||
                  stopBits === "two"
                )
                  editConfiguration({ stopBits });
              },
            )}
            {choice(
              labels.flowControl,
              binding.configuration.flowControl,
              ["none", "rtsCts", "xonXoff", "dsrDtr"],
              (flowControl) => {
                if (
                  flowControl === "none" ||
                  flowControl === "rtsCts" ||
                  flowControl === "xonXoff" ||
                  flowControl === "dsrDtr"
                )
                  editConfiguration({ flowControl });
              },
            )}
          </fieldset>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {(["sidebarWidth", "panelHeight"] as const).map((key) => (
            <label key={key} className="grid gap-1 text-sm">
              {labels[key]}
              <Input
                type="number"
                value={draft.layout[key]}
                onChange={(event) => {
                  if (Number.isFinite(event.target.valueAsNumber))
                    change({
                      ...draft,
                      layout: {
                        ...draft.layout,
                        [key]: event.target.valueAsNumber,
                      },
                    });
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={locked || !dirty || !onSave}
          onClick={() => void save().catch(() => {})}
        >
          {labels.save}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || !onReload}
          onClick={() => void reload().catch(() => {})}
        >
          {labels.reload}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || !dirty}
          onClick={discard}
        >
          {labels.discard}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || !onPreviewImport}
          onClick={() => setImportOpen(true)}
        >
          {labels.import}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || !onExport}
          onClick={() => {
            if (onExport)
              void request((signal) => onExport(original, signal)).catch(
                () => {},
              );
          }}
        >
          {labels.export}
        </Button>
      </div>
      {!onPreviewImport && (
        <p className="text-sm text-muted-foreground">
          {labels.importUnavailable}
        </p>
      )}
      {importOpen && (
        <section aria-label={labels.import} className="grid min-w-0 gap-3">
          <label className="grid gap-1 text-sm">
            {labels.importJson ?? "Workspace JSON"}
            <Textarea
              value={importJson}
              disabled={disabled || (busy && !importPending.current)}
              rows={6}
              onChange={(event) => changeImportJson(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            {labels.importFile ?? "Workspace JSON file"}
            <Input
              type="file"
              accept=".json,application/json"
              disabled={disabled || (busy && !importPending.current)}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readImportFile(file).catch(() => {});
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !importJson.trim() || !onPreviewImport}
              onClick={() => void previewImport().catch(() => {})}
            >
              {labels.previewImport ?? "Preview import"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || (busy && !importPending.current)}
              onClick={cancelImport}
            >
              {labels.cancelImport}
            </Button>
          </div>
          {candidate && (
            <section aria-label={labels.changes} className="grid min-w-0 gap-2">
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
                        {sectionLabels[item.section]} ·{" "}
                        {item.key === "$order"
                          ? (labels.order ?? "Order")
                          : item.key}{" "}
                        ·{" "}
                        <span>
                          {labels[item.kind] ??
                            {
                              added: "Added",
                              removed: "Removed",
                              changed: "Changed",
                            }[item.kind]}
                        </span>
                      </p>
                      {item.kind !== "added" && (
                        <div>
                          <span className="text-muted-foreground">
                            {labels.before ?? "Current draft"}
                          </span>
                          <pre className="whitespace-pre-wrap break-all font-mono">
                            {JSON.stringify(item.before, null, 2)}
                          </pre>
                        </div>
                      )}
                      {item.kind !== "removed" && (
                        <div>
                          <span className="text-muted-foreground">
                            {labels.after ?? "Import candidate"}
                          </span>
                          <pre className="whitespace-pre-wrap break-all font-mono">
                            {JSON.stringify(item.after, null, 2)}
                          </pre>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Button
                size="sm"
                disabled={locked || !onSave}
                onClick={() => void applyImport().catch(() => {})}
              >
                {labels.apply}
              </Button>
            </section>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm">
          {labels.saved}
        </p>
      )}
    </section>
  );
}
