import { useEffect, useId, useRef, useState } from "react";
import type {
  SerialConfiguration,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  WorkspaceView,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/color-picker";
import { HelpTooltip } from "@/components/help-tooltip";
import {
  DEFAULT_CUSTOM_ACCENT,
  normalizeAccentColor,
} from "@/lib/accent-colors";
import { hexToHsl, hslToHex } from "@/lib/color-picker-model";
import {
  WorkspaceViewIconPicker,
  type WorkspaceViewIconLabels,
} from "./workspace-view-icon";
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
  uniqueViewName,
  distinctWorkspaceLabels,
  sameWorkspace,
} from "./workspace-model";
import {
  RotateCw,
  Undo2,
  FileDown,
  FileUp,
  Info,
  FolderOpen,
  Save,
  Copy,
  Plus,
  Minus,
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
  viewSettings?: string;
  chooseColor?: string;
  customIcon?: string;
  customIconPlaceholder?: string;
  viewIcons?: WorkspaceViewIconLabels;
  viewsHint?: string;
  configurationHint?: string;
  addView?: string;
  removeView?: string;
  availableDevices?: string;
};
export type WorkspaceEditorProps = {
  base: WorkspaceDocumentResult;
  value?: WorkspaceDocument;
  selectedViewId?: string;
  bindingNames?: Readonly<Record<string, string>>;
  devices?: readonly { value: string; label: string }[];
  onAddDevice?: (
    document: WorkspaceDocument,
    deviceId: string,
  ) => { document: WorkspaceDocument; viewId: string } | undefined;
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
      views: [
        ...value.views,
        {
          ...source,
          id,
          bindingId,
          name: uniqueViewName(source.name, value.views),
        },
      ],
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
  bindingNames,
  devices = [],
  onAddDevice,
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
  const [addingDevice, setAddingDevice] = useState("");
  const [local, setLocal] = useState(base.document.value);
  const [localSelection, setLocalSelection] = useState(
    selectedViewId ?? base.document.value.views[0]?.id,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [eventKey, setEventKey] = useState<string>();
  const [failureIndex, setFailureIndex] = useState(0);
  const [saved, setSaved] = useState(false);
  const [pickerColor, setPickerColor] = useState(() =>
    hexToHsl(DEFAULT_CUSTOM_ACCENT),
  );
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
  const view =
    draft.views.find(
      (item) => item.id === (selectedViewId ?? localSelection),
    ) ?? draft.views[0];
  const viewChoices = distinctWorkspaceLabels(
    draft.views.map((item) => ({ value: item.id, label: item.name })),
  );
  const bindingChoices = distinctWorkspaceLabels(
    draft.bindings
      .filter(
        (item) =>
          draft.views.some((view) => view.bindingId === item.bindingId) ||
          draft.favoriteBindingIds.includes(item.bindingId),
      )
      .map((item, index) => ({
        value: item.bindingId,
        label:
          bindingNames?.[item.bindingId] ??
          draft.views.find((view) => view.bindingId === item.bindingId)?.name ??
          `${labels.binding} ${index + 1}`,
      })),
  );
  const binding = draft.bindings.find(
    (item) => item.bindingId === view?.bindingId,
  );
  const dirty = !sameWorkspace(draft, original.document.value);
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
    const unchanged = sameWorkspace(latest.current, snapshot);
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
    if (sameWorkspace(latest.current, snapshot)) {
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
    const unchanged = sameWorkspace(latest.current, snapshot);
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
  const modes = [
    { value: "text", label: labels.text },
    { value: "hex", label: labels.hex },
  ];
  const choice = (
    label: string,
    current: string,
    options: readonly { value: string; label: string }[],
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
            <SelectItem key={item.value} value={item.value}>
              {item.label}
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
          <div className="workbench-workspace-columns">
            <fieldset
              className="workbench-workspace-view-fields"
              aria-labelledby={`${id}-views-label`}
            >
              <legend>
                <span id={`${id}-views-label`}>
                  {labels.viewSettings ?? labels.views ?? labels.viewName}
                </span>
                {labels.viewsHint && (
                  <HelpTooltip label={labels.details}>
                    {labels.viewsHint}
                  </HelpTooltip>
                )}
              </legend>
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
                      {viewChoices.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              {view ? (
                <>
                  <label className="grid gap-1 text-sm">
                    {labels.viewName}
                    <Input
                      value={view.name}
                      onChange={(event) =>
                        editView({ name: event.target.value })
                      }
                    />
                  </label>
                  <div className="workbench-workspace-row">
                    <label htmlFor={`${id}-color`}>{labels.color}</label>
                    <div className="workbench-workspace-color">
                      <Popover
                        key={view.id}
                        onOpenChange={(open) => {
                          if (open)
                            setPickerColor(
                              hexToHsl(
                                normalizeAccentColor(view.color) ??
                                  DEFAULT_CUSTOM_ACCENT,
                              ),
                            );
                        }}
                      >
                        <PopoverTrigger asChild>
                          <WorkbenchIconButton
                            label={labels.chooseColor ?? labels.color}
                            variant="outline"
                            disabled={locked}
                          >
                            <span
                              aria-hidden="true"
                              className="workbench-workspace-color-swatch"
                              style={{ backgroundColor: view.color }}
                            />
                          </WorkbenchIconButton>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          aria-label={labels.chooseColor ?? labels.color}
                        >
                          <ColorPicker
                            label={labels.chooseColor ?? labels.color}
                            value={pickerColor}
                            onValueChange={(next) => {
                              setPickerColor(next);
                              editView({ color: hslToHex(next) });
                            }}
                          />
                        </PopoverContent>
                      </Popover>
                      <Input
                        id={`${id}-color`}
                        value={view.color}
                        onChange={(event) =>
                          editView({ color: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="workbench-workspace-row">
                    <span>{labels.icon}</span>
                    <WorkspaceViewIconPicker
                      key={view.id}
                      value={view.icon}
                      disabled={locked}
                      label={labels.icon}
                      defaultLabel={labels.defaultIcon}
                      customLabel={labels.customIcon ?? labels.icon}
                      customPlaceholder={
                        labels.customIconPlaceholder ?? labels.defaultIcon
                      }
                      optionLabels={labels.viewIcons}
                      onValueChange={(icon) => editView({ icon })}
                    />
                  </div>
                  <label
                    htmlFor={`${id}-pinned`}
                    className="workbench-workspace-pinned text-sm"
                  >
                    <span>{labels.pinned}</span>
                    <Switch
                      id={`${id}-pinned`}
                      checked={view.pinned}
                      onCheckedChange={(checked) =>
                        editView({ pinned: checked })
                      }
                      disabled={locked}
                    />
                  </label>
                  {choice(
                    labels.receiveMode,
                    view.receiveMode,
                    modes,
                    (mode) => {
                      if (mode === "text" || mode === "hex")
                        editView({ receiveMode: mode });
                    },
                  )}
                  {choice(labels.sendMode, view.sendMode, modes, (mode) => {
                    if (mode === "text" || mode === "hex")
                      editView({ sendMode: mode });
                  })}
                  {choice(
                    labels.binding,
                    view.bindingId,
                    bindingChoices,
                    (bindingId) => editView({ bindingId }),
                  )}
                  <div className="workbench-workspace-view-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!binding || locked}
                      onClick={clone}
                    >
                      <Copy aria-hidden="true" />
                      {labels.clone}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={locked}
                      onClick={() =>
                        change({
                          ...draft,
                          views: draft.views.filter(
                            (item) => item.id !== view.id,
                          ),
                        })
                      }
                    >
                      <Minus aria-hidden="true" />
                      {labels.removeView ?? "Remove view"}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{labels.noView}</p>
              )}
              {onAddDevice && (
                <div className="workbench-workspace-add-view">
                  <Select
                    value={addingDevice}
                    onValueChange={setAddingDevice}
                    disabled={locked || devices.length === 0}
                  >
                    <SelectTrigger
                      aria-label={
                        labels.availableDevices ?? "Available serial ports"
                      }
                    >
                      <SelectValue
                        placeholder={
                          labels.availableDevices ?? "Available serial ports"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked || !addingDevice}
                    onClick={() => {
                      const added = onAddDevice(draft, addingDevice);
                      if (added) {
                        change(added.document);
                        setLocalSelection(added.viewId);
                        onSelectView?.(added.viewId);
                      }
                    }}
                  >
                    <Plus aria-hidden="true" />
                    {labels.addView ?? "Add serial view"}
                  </Button>
                </div>
              )}
            </fieldset>
            {binding && (
              <fieldset
                className="workbench-workspace-configuration"
                aria-labelledby={`${id}-configuration-label`}
              >
                <legend>
                  <span id={`${id}-configuration-label`}>
                    {labels.configuration}
                  </span>
                  {labels.configurationHint && (
                    <HelpTooltip label={labels.details}>
                      {labels.configurationHint}
                    </HelpTooltip>
                  )}
                </legend>
                <SerialConfigurationFields
                  id={id + "-binding"}
                  value={binding.configuration}
                  labels={labels.configurationLabels}
                  onChange={(value) => editConfiguration(value)}
                />
              </fieldset>
            )}
          </div>
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
                <output data-surface="control">
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
              <FileDown aria-hidden="true" />
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
              <Undo2 aria-hidden="true" />
              {labels.cancelImport}
            </Button>
            <WorkbenchIconButton
              label={labels.reload}
              variant="outline"
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
              className="workbench-workspace-save"
              disabled={locked || !dirty || !onSave}
              onClick={() => void save().catch(() => {})}
            >
              <Save aria-hidden="true" />
              {labels.save}
            </Button>
            <WorkbenchIconButton
              label={labels.reload}
              variant="outline"
              disabled={locked || !onReload}
              onClick={() => void reload().catch(() => {})}
            >
              <RotateCw aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.discard}
              variant="outline"
              disabled={locked || !dirty}
              onClick={discard}
            >
              <Undo2 aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.import}
              variant="outline"
              className="workbench-workspace-import-action"
              tooltip={!onPreviewImport ? labels.importUnavailable : undefined}
              disabled={locked || !onPreviewImport}
              onClick={() => setImportOpen(true)}
            >
              <FileDown aria-hidden="true" />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              label={labels.export}
              variant="outline"
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
