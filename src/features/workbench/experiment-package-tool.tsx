import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type {
  ExperimentDependency,
  ExperimentExportParams,
  ExperimentInspection,
  ExperimentPackage,
  NodePackageId,
  NodePackageSummary,
  ObjectRef,
  OperationState,
  OperationSummary,
  SessionSnapshot,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { HostConnection } from "@/lib/host-client";
import { nativeErrorText } from "@/lib/native-error";
import { reportClientError } from "@/lib/report-error";
import { saveTextExport } from "@/lib/tauri";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { FolderOpen } from "lucide-react";
import { loadInstalledPlugins } from "../plugins/node-management";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { formatSerialLine } from "./serial-configuration";

const exportAction = "workspace.experiment.export";
const inspectAction = "workspace.experiment.inspect";
const maxArchiveBytes = 192 * 1024;
const maxSelection = 64;
const terminalStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
const dependencyLabels = {
  matched: "workbench.experiment.matched",
  missing: "workbench.experiment.missing",
  changed: "workbench.experiment.changed",
  unavailable: "workbench.experiment.unavailable",
  other_host: "workbench.experiment.otherHost",
} as const satisfies Record<ExperimentDependency, string>;

interface Props {
  base: WorkspaceDocumentResult;
  connection: HostConnection;
  summaries: readonly OperationSummary[];
  sessions: readonly SessionSnapshot[];
  disabled: boolean;
  canSave: boolean;
  onSave: HostContextValue["saveWorkspace"];
  onAcknowledged: (result: WorkspaceDocumentResult) => void;
  pickRecording?: (
    signal: AbortSignal,
  ) => ReturnType<HostContextValue["pickFile"]>;
  onBack: () => void;
}

function toggle<T>(items: readonly T[], value: T) {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value];
}

function recordingKey(reference: ObjectRef) {
  return JSON.stringify([
    reference.hostId,
    reference.kind,
    reference.id,
    reference.revision,
  ]);
}

function operationLabel(state: OperationState) {
  return state === "cancel_requested"
    ? "workbench.operation.cancelRequested"
    : (`workbench.operation.${state}` as const);
}

export function ExperimentPackageTool({
  base,
  connection,
  summaries,
  sessions,
  disabled,
  canSave,
  onSave,
  onAcknowledged,
  pickRecording,
  onBack,
}: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"export" | "import">("export");
  const [packages, setPackages] = useState<NodePackageSummary[]>();
  const [packagesError, setPackagesError] = useState<string>();
  const [parsers, setParsers] = useState<NodePackageId[]>([]);
  const [recordings, setRecordings] = useState<string[]>([]);
  const [pickedRecordings, setPickedRecordings] = useState<
    ReadonlyMap<
      string,
      {
        reference: ObjectRef;
        name: string;
      }
    >
  >(new Map());
  const [operations, setOperations] = useState<string[]>([]);
  const [firmware, setFirmware] = useState<Record<string, string>>({});
  const [exportPreview, setExportPreview] = useState<{
    value: ExperimentPackage;
    params: ExperimentExportParams;
  }>();
  const [file, setFile] = useState<File>();
  const [importPreview, setImportPreview] = useState<{
    result: ExperimentInspection;
    base: WorkspaceDocumentResult;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const fileControl = useRef<HTMLInputElement>(null);
  const previewRegion = useRef<HTMLDivElement>(null);
  const document = base.document.value;

  useEffect(() => {
    first.current?.focus();
    return () => {
      const pending = request.current;
      request.current = null;
      pending?.abort();
    };
  }, []);
  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    void connection
      .onCatalogChanged(() => {
        if (!current) return;
        request.current?.abort();
        setExportPreview(undefined);
        setImportPreview(undefined);
      })
      .then(
        (stop) => {
          if (current) unsubscribe = stop;
          else stop();
        },
        (reason: unknown) => {
          if (current)
            reportClientError(
              reason,
              "Experiment package catalog notifications",
            );
        },
      );
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [connection]);
  useEffect(() => {
    if (exportPreview || importPreview)
      previewRegion.current?.focus({ preventScroll: true });
  }, [exportPreview, importPreview]);
  useEffect(() => {
    if (mode !== "export" || disabled) return;
    const controller = new AbortController();
    void loadInstalledPlugins(connection, controller.signal, {
      parserOnly: true,
    }).then(
      ({ packages }) => {
        if (controller.signal.aborted) return;
        setPackages(packages.filter((item) => item.version !== undefined));
        setPackagesError(undefined);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setPackages(undefined);
        setPackagesError(nativeErrorText(reason, t));
      },
    );
    return () => controller.abort();
  }, [connection, disabled, mode, t]);

  function clear() {
    setParsers([]);
    setRecordings([]);
    setOperations([]);
    setFirmware({});
    setExportPreview(undefined);
    setFile(undefined);
    setImportPreview(undefined);
    setError(undefined);
  }

  useUnsavedWork({
    id: "experiment-package-" + base.scope.scopeId,
    label: t("workbench.experiment.title"),
    dirty:
      busy ||
      Boolean(
        file ||
        exportPreview ||
        parsers.length ||
        recordings.length ||
        operations.length ||
        Object.values(firmware).some(Boolean),
      ),
    discard: () => {
      request.current?.abort();
      setBusy(false);
      clear();
    },
  });

  const references = new Map(
    document.captures
      .filter(
        (ref) =>
          ref.hostId === base.scope.target.hostId &&
          (ref.kind === "capture" || ref.kind === "file") &&
          ref.revision !== undefined,
      )
      .map((reference) => [
        recordingKey(reference),
        { reference, name: reference.id },
      ]),
  );
  for (const [key, entry] of pickedRecordings) references.set(key, entry);
  const workspaceDevices = new Set(
    document.bindings
      .filter((item) => item.hostId === base.scope.target.hostId)
      .map((item) => item.deviceId),
  );
  const workspaceSessions = new Set(
    sessions
      .filter((item) => workspaceDevices.has(item.deviceId))
      .map((item) => item.sessionId),
  );
  const settledRuns = summaries.filter(
    (summary) =>
      summary.executionHostId === base.scope.target.hostId &&
      (summary.revealTarget.workspaceId === base.scope.target.id ||
        (summary.revealTarget.workspaceId === undefined &&
          workspaceSessions.has(
            summary.target.sessionId ?? summary.revealTarget.sessionId ?? "",
          ))) &&
      terminalStates.has(summary.state),
  );
  const firmwareInvalid = Object.values(firmware).some(
    (version) => version !== "" && !/^[a-z0-9_.+-]{1,64}$/i.test(version),
  );
  const exportCurrent =
    exportPreview?.params.workspaceRevision === base.document.revision;
  const importCurrent =
    importPreview?.base.document.revision === base.document.revision;
  const locked = busy || disabled;

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (request.current || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await action(controller.signal);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setError(nativeErrorText(reason, t));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  async function readExport(
    params: ExperimentExportParams,
    signal: AbortSignal,
  ) {
    const result = await connection.client.query(
      connection.buildQuery(exportAction, base.scope.target, params),
      signal,
    );
    if (result.kind !== "experiment_package")
      throw new ContractValidationError();
    return result.value;
  }

  function previewExport() {
    void run(async (signal) => {
      const configuration = document.bindings.flatMap((binding, index) => {
        const version = firmware[binding.bindingId];
        return version ? [{ binding: index + 1, version }] : [];
      });
      const params: ExperimentExportParams = {
        workspaceRevision: base.document.revision,
        parsers,
        recordings: recordings.flatMap((key) => {
          const entry = references.get(key);
          return entry ? [entry.reference] : [];
        }),
        operations: settledRuns
          .filter((item) => operations.includes(item.operationId))
          .map((item) => item.operationId),
        firmware: configuration,
      };
      const value = await readExport(params, signal);
      signal.throwIfAborted();
      setExportPreview({ value, params });
    });
  }

  function chooseRecording() {
    if (!pickRecording) return;
    void run(async (signal) => {
      const selected = await pickRecording(signal);
      signal.throwIfAborted();
      if (!selected) return;
      const key = recordingKey(selected.reference);
      setPickedRecordings((current) => new Map(current).set(key, selected));
      setRecordings((current) =>
        current.includes(key) ? current : [...current, key],
      );
    });
  }

  function previewImport(selected: File) {
    setFile(selected);
    setImportPreview(undefined);
    void run(async (signal) => {
      if (selected.size > maxArchiveBytes) throw { code: "LIMIT_EXCEEDED" };
      const json = await selected.text();
      signal.throwIfAborted();
      const result = await connection.client.query(
        connection.buildQuery(inspectAction, base.scope.target, { json }),
        signal,
      );
      signal.throwIfAborted();
      if (result.kind !== "experiment_inspection")
        throw new ContractValidationError();
      if (
        result.value.experiment.parsers.length !==
          result.value.parserStatus.length ||
        result.value.experiment.recordings.length !==
          result.value.recordingStatus.length
      )
        throw new ContractValidationError();
      setImportPreview({ result: result.value, base });
    });
  }

  function confirmImport() {
    if (!importPreview || !importCurrent || !canSave) return;
    void run(async (signal) => {
      const result = await onSave(
        importPreview.base,
        {
          ...importPreview.result.experiment.workspace,
          name: importPreview.base.document.value.name,
        },
        signal,
      );
      signal.throwIfAborted();
      onAcknowledged(result);
      setFile(undefined);
      setImportPreview(undefined);
      setStatus(t("workbench.experiment.imported"));
    });
  }

  function saveExport() {
    if (!exportPreview || !exportCurrent) return;
    void run(async (signal) => {
      let value;
      try {
        value = await readExport(exportPreview.params, signal);
        signal.throwIfAborted();
      } catch (reason: unknown) {
        if (!signal.aborted) setExportPreview(undefined);
        throw reason;
      }
      const content = JSON.stringify(value);
      if (content !== JSON.stringify(exportPreview.value)) {
        setExportPreview({ value, params: exportPreview.params });
        setStatus(t("workbench.experiment.previewChanged"));
        return;
      }
      const fileName = await saveTextExport(
        t("workbench.experiment.fileName"),
        content,
      );
      signal.throwIfAborted();
      if (fileName !== null) {
        clear();
        setStatus(t("workbench.experiment.saved"));
      }
    });
  }

  return (
    <section
      className="workbench-workspace-editor workbench-experiment"
      aria-label={t("workbench.experiment.title")}
    >
      <div className="workbench-workspace-actions">
        <Button
          ref={first}
          size="sm"
          type="button"
          variant={mode === "export" ? "secondary" : "ghost"}
          aria-pressed={mode === "export"}
          disabled={locked}
          onClick={() => {
            setMode("export");
            setError(undefined);
            setStatus(undefined);
          }}
        >
          {t("workbench.experiment.export")}
        </Button>
        <Button
          size="sm"
          type="button"
          variant={mode === "import" ? "secondary" : "ghost"}
          aria-pressed={mode === "import"}
          disabled={locked}
          onClick={() => {
            setMode("import");
            setError(undefined);
            setStatus(undefined);
          }}
        >
          {t("workbench.experiment.import")}
        </Button>
      </div>
      <div className="workbench-workspace-content" aria-busy={busy}>
        <p className="workbench-experiment-context">
          {document.name || t("workbench.experiment.unnamed")}
          <span>
            {t("workbench.experiment.revision")}{" "}
            <code>{base.document.revision}</code>
          </span>
        </p>
        {mode === "export" ? (
          exportPreview && exportCurrent ? (
            <div tabIndex={-1} ref={previewRegion}>
              <ExperimentPreview value={exportPreview.value} />
            </div>
          ) : (
            <div className="workbench-experiment-columns">
              <section>
                <h3>{t("workbench.experiment.configuration")}</h3>
                {document.bindings.length === 0 && (
                  <p>{t("workbench.experiment.none")}</p>
                )}
                {document.bindings.map((binding, index) => (
                  <label
                    className="workbench-experiment-firmware"
                    key={binding.bindingId}
                  >
                    <span>
                      {t("workbench.experiment.binding")} {index + 1}{" "}
                      {binding.portName && <span>{binding.portName} </span>}
                      <code>{formatSerialLine(binding.configuration)}</code>
                    </span>
                    <span>{t("workbench.experiment.firmware")}</span>
                    <Input
                      disabled={locked}
                      value={firmware[binding.bindingId] ?? ""}
                      placeholder="v1.4.2"
                      maxLength={64}
                      onChange={(event) =>
                        setFirmware({
                          ...firmware,
                          [binding.bindingId]: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                ))}
                {firmwareInvalid && (
                  <p role="alert">
                    {t("workbench.experiment.invalidFirmware")}
                  </p>
                )}
              </section>
              <section>
                <h3>{t("workbench.experiment.evidence")}</h3>

                <EvidenceOptions
                  title={t("workbench.experiment.parsers")}
                  options={
                    packages?.map((item) => ({
                      value: item.id,
                      label: item.displayName ?? item.id,
                    })) ?? []
                  }
                  hint={
                    packagesError ??
                    (packages
                      ? undefined
                      : t("workbench.experiment.loadingParsers"))
                  }
                  selected={parsers}
                  onChange={setParsers}
                  disabled={locked}
                />
                <EvidenceOptions
                  title={t("workbench.experiment.recordings")}
                  options={Array.from(references, ([value, item]) => ({
                    value,
                    label: item.name,
                  }))}
                  selected={recordings}
                  onChange={setRecordings}
                  disabled={locked}
                >
                  {pickRecording && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={chooseRecording}
                      disabled={locked || recordings.length >= maxSelection}
                    >
                      <FolderOpen aria-hidden="true" />
                      {t("workbench.experiment.chooseRecording")}
                    </Button>
                  )}
                </EvidenceOptions>
                <EvidenceOptions
                  title={t("workbench.experiment.runs")}
                  options={settledRuns.map((item) => ({
                    value: item.operationId,
                    label: (
                      <>
                        <code>{item.actionId}</code>{" "}
                        {t(operationLabel(item.state))}
                      </>
                    ),
                  }))}
                  selected={operations}
                  onChange={setOperations}
                  disabled={locked}
                />
              </section>
            </div>
          )
        ) : (
          <div className="workbench-experiment-import">
            <div className="workbench-experiment-file">
              <Input
                aria-label={t("workbench.experiment.packageFile")}
                readOnly
                tabIndex={file ? undefined : -1}
                value={file?.name ?? ""}
                title={file?.name}
                placeholder={t("workbench.experiment.noFile")}
              />
              <WorkbenchIconButton
                label={t("workbench.experiment.chooseFile")}
                variant="outline"
                disabled={locked}
                onClick={() => fileControl.current?.click()}
              >
                <FolderOpen aria-hidden="true" />
              </WorkbenchIconButton>
              <Input
                ref={fileControl}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                type="file"
                accept=".json,application/json"
                disabled={locked}
                onChange={(event) => {
                  const selected = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (selected) previewImport(selected);
                }}
              />
            </div>
            {importPreview && (
              <div tabIndex={-1} ref={previewRegion}>
                <ExperimentPreview
                  value={importPreview.result.experiment}
                  inspection={importPreview.result}
                />
              </div>
            )}
            {importPreview && importCurrent && (
              <p>
                {t(
                  canSave
                    ? "workbench.experiment.replaceNotice"
                    : "workbench.experiment.readOnly",
                )}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="workbench-error">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
        {((importPreview && !importCurrent && mode === "import") ||
          (exportPreview && !exportCurrent && mode === "export")) && (
          <p role="status">{t("workbench.experiment.revisionChanged")}</p>
        )}
      </div>
      <div className="workbench-workspace-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onBack}
        >
          {t("workbench.experiment.back")}
        </Button>
        {mode === "export" &&
          (exportPreview && exportCurrent ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => setExportPreview(undefined)}
              >
                {t("workbench.experiment.editSelection")}
              </Button>
              <Button type="button" disabled={locked} onClick={saveExport}>
                {t("workbench.experiment.save")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={locked || firmwareInvalid}
              onClick={previewExport}
            >
              {t("workbench.experiment.preview")}
            </Button>
          ))}
        {mode === "import" &&
          (importCurrent ? (
            <Button
              type="button"
              disabled={locked || !canSave}
              onClick={confirmImport}
            >
              {t("workbench.experiment.confirmImport")}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={locked || !file}
              onClick={() => {
                if (file) previewImport(file);
              }}
            >
              {t("workbench.experiment.inspect")}
            </Button>
          ))}
      </div>
    </section>
  );
}

function EvidenceOptions<T extends string>({
  title,
  options,
  hint,
  selected,
  onChange,
  disabled,
  children,
}: {
  title: string;
  options: readonly { value: T; label: ReactNode }[];
  hint?: string;
  selected: readonly T[];
  onChange: (next: T[]) => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const { t } = useI18n();
  return (
    <fieldset disabled={disabled} className="workbench-experiment-picks">
      <legend>{title}</legend>
      {hint && <p role="status">{hint}</p>}
      {options.length === 0 && !hint && <p>{t("workbench.experiment.none")}</p>}
      {options.map(({ value, label }, index) => {
        const control = id + "-" + index;
        const checked = selected.includes(value);
        return (
          <div className="workbench-experiment-option" key={value}>
            <Checkbox
              id={control}
              checked={checked}
              disabled={
                disabled || (selected.length >= maxSelection && !checked)
              }
              onCheckedChange={() => onChange(toggle(selected, value))}
            />
            <label htmlFor={control}>{label}</label>
          </div>
        );
      })}
      {children}
    </fieldset>
  );
}

function ExperimentPreview({
  value,
  inspection,
}: {
  value: ExperimentPackage;
  inspection?: ExperimentInspection;
}) {
  const { t } = useI18n();
  return (
    <div className="workbench-experiment-columns">
      <section>
        <h3>{t("workbench.experiment.configuration")}</h3>
        <p>
          {t("workbench.experiment.views")}{" "}
          <code>{value.workspace.views.length}</code>
        </p>
        <ul>
          {value.workspace.bindings.map((binding, index) => (
            <li key={binding.bindingId}>
              {t("workbench.experiment.binding")} {index + 1}{" "}
              <code>{formatSerialLine(binding.configuration)}</code>
              {inspection && <span> {t("workbench.experiment.rebind")}</span>}
            </li>
          ))}
        </ul>
        {value.firmware.length > 0 && (
          <>
            <h3>{t("workbench.experiment.firmware")}</h3>
            <ul>
              {value.firmware.map((item) => (
                <li key={item.binding}>
                  {t("workbench.experiment.binding")} {item.binding}{" "}
                  <code>{item.version}</code>
                  {inspection && (
                    <span> {t("workbench.experiment.verifyFirmware")}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section>
        <h3>
          {t(
            inspection
              ? "workbench.experiment.dependencies"
              : "workbench.experiment.evidence",
          )}
        </h3>
        <ul>
          {value.parsers.map((item, index) => (
            <li key={item.id}>
              <code>
                {item.id} {item.version}
              </code>
              {inspection && (
                <span>
                  {" "}
                  {t(dependencyLabels[inspection.parserStatus[index]!])}
                </span>
              )}
              <details>
                <summary>{t("workbench.experiment.digest")}</summary>
                <code>{item.archiveSha256}</code>
              </details>
            </li>
          ))}
          {value.recordings.map((item, index) => (
            <li key={recordingKey(item.reference)}>
              <code>{item.reference.id}</code>
              {inspection && (
                <span>
                  {" "}
                  {t(dependencyLabels[inspection.recordingStatus[index]!])}
                </span>
              )}
              <details>
                <summary>{t("workbench.experiment.digest")}</summary>
                <code>{item.fingerprint}</code>
              </details>
            </li>
          ))}
          {value.runs.map((item, index) => (
            <li key={index}>
              <code>{item.actionId}</code> {t(operationLabel(item.state))}{" "}
              <time dateTime={item.settledAt}>{item.settledAt}</time>
            </li>
          ))}
        </ul>
        {value.parsers.length + value.recordings.length + value.runs.length ===
          0 && <p>{t("workbench.experiment.none")}</p>}
        {!inspection && <p>{t("workbench.experiment.redactions")}</p>}
      </section>
    </div>
  );
}
