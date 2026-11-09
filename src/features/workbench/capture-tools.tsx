import { useEffect, useMemo, useState } from "react";
import { defaults } from "@serial-workbench/contracts";
import type {
  CaptureStorageLimits,
  CaptureStartParams,
  FileMetadata,
  CaptureVerifyParams,
  CaptureWriteMode,
  Operation,
  OverflowPolicy,
  RecoverPrefixParams,
  ReplayMode,
  ReplayOpenParams,
  Target,
  TextExportParams,
} from "@serial-workbench/contracts";
import type { FileResourceRole, SelectedFileResource } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  unsigned,
  useToolAction,
  useToolDraft,
} from "./transfer-capture-actions";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

import { useToolActionAvailability } from "./use-tool-action-availability";

export type CaptureToolsLabels = Record<
  | "captureTools"
  | "selectTarget"
  | "selectCapture"
  | "writeMode"
  | "createNew"
  | "append"
  | "replace"
  | "raw"
  | "overflowPolicy"
  | "stop"
  | "dropWithGap"
  | "flowControl"
  | "expectedFingerprint"
  | "targetRevision"
  | "confirmReplacement"
  | "startCapture"
  | "capacityMiB"
  | "reserveMiB"
  | "invalidLimits"
  | "metadataSnapshot"
  | "verify"
  | "recoveryPreview"
  | "recoverPrefix"
  | "exportText"
  | "originalTiming"
  | "fastest"
  | "replayMode"
  | "openReplay"
  | "fingerprint"
  | "verifiedPrefix"
  | "containerComplete"
  | "sourceContinuous"
  | "recoverable"
  | "unsettledOperations"
  | "yes"
  | "no"
  | "unavailable"
  | "draft"
  | "saveUnavailable",
  string
>;
export type CaptureToolsDraft = {
  writeMode: CaptureWriteMode;
  replayMode: ReplayMode;
  capacityMiB: string;
  reserveMiB: string;
};
type Action<T> = (params: T, signal?: AbortSignal) => Promise<Operation>;
export type CaptureToolsProps = {
  /** Include attachment generation; selection and verification never survive an attachment change. */
  contextKey: string;
  watchActions: HostContextValue["watchActions"];
  labels: CaptureToolsLabels;
  sessionRefs: Target[];
  disabled?: boolean;
  operations?: readonly Operation[];
  initialDraft?: CaptureToolsDraft;
  pickFile?: (
    role: FileResourceRole,
    signal?: AbortSignal,
  ) => Promise<SelectedFileResource | null>;
  readMetadata?: HostContextValue["fileMetadata"];
  onStart?: Action<CaptureStartParams>;
  onVerify?: Action<CaptureVerifyParams>;
  onRecover?: Action<RecoverPrefixParams>;
  onExport?: Action<TextExportParams>;
  onReplay?: Action<ReplayOpenParams>;
  onSaveDraft?: (
    draft: CaptureToolsDraft,
    signal?: AbortSignal,
  ) => Promise<void>;
};
export function CaptureTools(props: CaptureToolsProps) {
  return <CaptureToolsForm key={props.contextKey} {...props} />;
}
function CaptureToolsForm({
  labels,
  sessionRefs,
  disabled,
  operations,
  initialDraft,
  pickFile,
  readMetadata,
  onStart,
  onVerify,
  onRecover,
  onExport,
  onReplay,
  onSaveDraft,
  watchActions,
}: CaptureToolsProps) {
  const [target, setTarget] = useState<SelectedFileResource>();
  const [metadataResult, setMetadataResult] = useState<{
    target: SelectedFileResource;
    read: typeof readMetadata;
    value: FileMetadata;
  }>();
  const [metadataError, setMetadataError] = useState<string>();
  const metadata =
    metadataResult &&
    metadataResult.target === target &&
    metadataResult.read === readMetadata
      ? metadataResult.value
      : undefined;
  useEffect(() => {
    setConfirmed(false);
    setMetadataResult(undefined);
    setMetadataError(undefined);
    if (!target || !readMetadata) return;
    const controller = new AbortController();
    void readMetadata(target.reference, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setMetadataResult({ target, read: readMetadata, value });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setMetadataError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => controller.abort();
  }, [target, readMetadata]);
  const [source, setSource] = useState<SelectedFileResource>();
  const [verificationOperation, setVerificationOperation] =
    useState<Operation>();
  const [result, setResult] = useState<Operation>();
  const [recoveryUsed, setRecoveryUsed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState<CaptureToolsDraft>(
    initialDraft ?? {
      writeMode: "create_new",
      replayMode: "original_timing",
      capacityMiB: (
        BigInt(defaults.captureStorageLimits.capacityBytes) / 1048576n
      ).toString(),
      reserveMiB: (
        BigInt(defaults.captureStorageLimits.reserveBytes) / 1048576n
      ).toString(),
    },
  );
  const action = useToolAction();
  useToolDraft(
    draft,
    labels.draft,
    labels.saveUnavailable,
    (value) => {
      setDraft(value);
      setConfirmed(false);
    },
    onSaveDraft,
  );
  const currentVerification =
    operations?.find(
      (value) => value.operationId === verificationOperation?.operationId,
    ) ?? verificationOperation;
  const report =
    currentVerification?.result?.kind === "capture_verification"
      ? currentVerification.result.value
      : undefined;
  const currentResult =
    operations?.find((value) => value.operationId === result?.operationId) ??
    result;
  const locked = Boolean(disabled || action.busy);
  const replacementReady =
    draft.writeMode !== "replace" || (metadata !== undefined && confirmed);
  const overflowPolicy: OverflowPolicy = "stop";
  const storageLimits = useMemo<CaptureStorageLimits | undefined>(() => {
    const capacity = unsigned(draft.capacityMiB),
      reserve = unsigned(draft.reserveMiB);
    if (capacity === undefined || capacity === 0n || reserve === undefined)
      return;
    const capacityBytes = capacity * 1048576n,
      reserveBytes = reserve * 1048576n;
    if (
      capacityBytes > 18446744073709551615n ||
      reserveBytes > 18446744073709551615n
    )
      return;
    return {
      capacityBytes: capacityBytes.toString(),
      reserveBytes: reserveBytes.toString(),
    };
  }, [draft.capacityMiB, draft.reserveMiB]);
  const startParams = useMemo(
    () =>
      target && sessionRefs.length && replacementReady && storageLimits
        ? {
            targetRef: target.reference,
            sessionRefs,
            mode: "raw" as const,
            overflowPolicy,
            writeMode: draft.writeMode,
            storageLimits,
            ...(draft.writeMode === "replace"
              ? { expectedFingerprint: metadata?.fingerprint }
              : {}),
          }
        : undefined,
    [
      target,
      sessionRefs,
      replacementReady,
      draft.writeMode,
      metadata,
      overflowPolicy,
      storageLimits,
    ],
  );
  const recoverParams = useMemo(
    () =>
      target && report?.recoverable && !recoveryUsed
        ? {
            verificationId: report.verificationId,
            sourceFingerprint: report.sourceFingerprint,
            targetRef: target.reference,
          }
        : undefined,
    [target, report, recoveryUsed],
  );
  const exportParams = useMemo(
    () =>
      source && target
        ? { captureRef: source.reference, targetRef: target.reference }
        : undefined,
    [source, target],
  );
  const verifyParams = useMemo(
    () => (source ? { captureRef: source.reference } : undefined),
    [source],
  );
  const replayParams = useMemo(
    () =>
      source
        ? { captureRef: source.reference, mode: draft.replayMode }
        : undefined,
    [source, draft.replayMode],
  );
  const inputs = useMemo<HostActionCheckInput[]>(() => {
    const values: HostActionCheckInput[] = [];
    const refTarget = (
      reference: SelectedFileResource["reference"],
    ): Target => ({
      hostId: reference.hostId,
      kind: reference.kind,
      id: reference.id,
    });
    if (startParams)
      values.push({
        actionId: "capture.start",
        target: refTarget(startParams.targetRef),
        params: startParams,
      });
    if (verifyParams)
      values.push({
        actionId: "capture.verify",
        target: refTarget(verifyParams.captureRef),
        params: verifyParams,
      });
    if (recoverParams)
      values.push({
        actionId: "capture.recover",
        target: refTarget(recoverParams.targetRef),
        params: recoverParams,
      });
    if (exportParams)
      values.push({
        actionId: "capture.export",
        target: refTarget(exportParams.captureRef),
        params: exportParams,
      });
    if (replayParams)
      values.push({
        actionId: "replay.open",
        target: refTarget(replayParams.captureRef),
        params: replayParams,
      });
    return values;
  }, [startParams, verifyParams, recoverParams, exportParams, replayParams]);
  const allowed = useToolActionAvailability(inputs, watchActions);
  const canAct = (actionId: string) =>
    !locked && allowed(inputs.find((input) => input.actionId === actionId));
  async function chooseTarget(signal: AbortSignal) {
    setConfirmed(false);
    setMetadataResult(undefined);
    setTarget(undefined);
    const selected = await pickFile!("captureTarget", signal);
    if (!signal.aborted && selected) {
      setTarget(selected);
    }
  }
  return (
    <section
      aria-label={labels.captureTools}
      aria-busy={action.busy}
      className="space-y-3"
    >
      <h3>{labels.captureTools}</h3>
      <fieldset disabled={locked}>
        <legend>{labels.startCapture}</legend>
        <div className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!pickFile}
            onClick={() => void action.run(chooseTarget)}
          >
            {labels.selectTarget}
          </Button>
          {target && (
            <p>
              <span>{target.name}</span> · {target.reference.id}
            </p>
          )}
          <p>{labels.raw}</p>
          <label className="block space-y-1">
            <span>{labels.writeMode}</span>
            <select
              value={draft.writeMode}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "create_new" ||
                  value === "append" ||
                  value === "replace"
                ) {
                  setDraft((current) => ({ ...current, writeMode: value }));
                  setConfirmed(false);
                }
              }}
            >
              <option value="create_new">{labels.createNew}</option>
              <option value="append">{labels.append}</option>
              <option value="replace">{labels.replace}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span>{labels.overflowPolicy}</span>
            <select value={overflowPolicy} disabled>
              <option value="stop">{labels.stop}</option>
              <option value="drop_with_gap" disabled>
                {labels.dropWithGap}
              </option>
              <option value="flow_control" disabled>
                {labels.flowControl}
              </option>
            </select>
          </label>
          {(["capacityMiB", "reserveMiB"] as const).map((field) => (
            <label key={field} className="block space-y-1">
              <span>{labels[field]}</span>
              <Input
                inputMode="numeric"
                value={draft[field]}
                aria-invalid={!storageLimits}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
          {!storageLimits && <p role="alert">{labels.invalidLimits}</p>}
          {draft.writeMode === "replace" && (
            <>
              {metadata && (
                <p>
                  {labels.targetRevision}:{" "}
                  <span aria-label={labels.targetRevision}>
                    {metadata.fileRef.revision}
                  </span>
                </p>
              )}
              <label className="block space-y-1">
                <span>{labels.expectedFingerprint}</span>
                <Input value={metadata?.fingerprint ?? ""} readOnly />
              </label>
              <p className="text-xs text-muted-foreground">
                {labels.metadataSnapshot}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!metadata}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {labels.confirmReplacement}
              </label>
            </>
          )}
          <Button
            size="sm"
            disabled={!startParams || !onStart || !canAct("capture.start")}
            onClick={() =>
              void action.run(async (signal) => {
                if (!startParams || !onStart || !canAct("capture.start"))
                  return;
                const operation = await onStart(startParams, signal);
                if (!signal.aborted) {
                  setResult(operation);
                  setConfirmed(false);
                }
              })
            }
          >
            {labels.startCapture}
          </Button>
        </div>
      </fieldset>
      <fieldset disabled={locked}>
        <legend>{labels.recoveryPreview}</legend>
        <div className="space-y-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!pickFile}
            onClick={() =>
              void action.run(async (signal) => {
                const selected = await pickFile!("captureSource", signal);
                if (!signal.aborted && selected) {
                  setSource(selected);
                  setVerificationOperation(undefined);
                  setResult(undefined);
                  setRecoveryUsed(false);
                }
              })
            }
          >
            {labels.selectCapture}
          </Button>
          {source && (
            <p>
              <span>{source.name}</span> · {source.reference.id}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!verifyParams || !onVerify || !canAct("capture.verify")}
              onClick={() =>
                void action.run(async (signal) => {
                  if (!verifyParams || !onVerify || !canAct("capture.verify"))
                    return;
                  const operation = await onVerify(verifyParams, signal);
                  if (!signal.aborted) {
                    setVerificationOperation(operation);
                    setRecoveryUsed(false);
                  }
                })
              }
            >
              {labels.verify}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !recoverParams || !onRecover || !canAct("capture.recover")
              }
              onClick={() =>
                void action.run(async (signal) => {
                  if (
                    !recoverParams ||
                    !onRecover ||
                    !canAct("capture.recover")
                  )
                    return;
                  const operation = await onRecover(recoverParams, signal);
                  if (!signal.aborted) {
                    setResult(operation);
                    setRecoveryUsed(true);
                  }
                })
              }
            >
              {labels.recoverPrefix}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!exportParams || !onExport || !canAct("capture.export")}
              onClick={() =>
                void action.run(async (signal) => {
                  if (!exportParams || !onExport || !canAct("capture.export"))
                    return;
                  const operation = await onExport(exportParams, signal);
                  if (!signal.aborted) setResult(operation);
                })
              }
            >
              {labels.exportText}
            </Button>
          </div>
          {currentVerification && (
            <p>
              {currentVerification.operationId} · {currentVerification.state}
            </p>
          )}
          {currentVerification?.error && (
            <p role="alert">
              {currentVerification.error.code}:{" "}
              {currentVerification.error.message}
            </p>
          )}
          {report && (
            <div aria-label={labels.recoveryPreview} className="space-y-2">
              <dl className="space-y-1">
                <div>
                  <dt>{labels.fingerprint}</dt>
                  <dd className="break-all">{report.sourceFingerprint}</dd>
                </div>
                <div>
                  <dt>{labels.verifiedPrefix}</dt>
                  <dd>{report.verifiedPrefix}</dd>
                </div>
                {(
                  [
                    "containerComplete",
                    "sourceContinuous",
                    "recoverable",
                  ] as const
                ).map((field) => (
                  <div key={field}>
                    <dt>{labels[field]}</dt>
                    <dd aria-label={labels[field]}>
                      {report[field] ? labels.yes : labels.no}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>{labels.unsettledOperations}</dt>
                  <dd>{report.unsettledOperations.join(", ") || labels.no}</dd>
                </div>
              </dl>
              <ul>
                {report.volumeResults.map((volume) => (
                  <li key={volume.volumeId}>
                    {volume.volumeId} · <span>{volume.status}</span> ·{" "}
                    {volume.verifiedPrefix}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="block space-y-1">
            <span>{labels.replayMode}</span>
            <select
              value={draft.replayMode}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "original_timing" || value === "fastest")
                  setDraft((current) => ({ ...current, replayMode: value }));
              }}
            >
              <option value="original_timing">{labels.originalTiming}</option>
              <option value="fastest">{labels.fastest}</option>
            </select>
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!replayParams || !onReplay || !canAct("replay.open")}
            onClick={() =>
              void action.run(async (signal) => {
                if (!replayParams || !onReplay || !canAct("replay.open"))
                  return;
                const operation = await onReplay(replayParams, signal);
                if (!signal.aborted) setResult(operation);
              })
            }
          >
            {labels.openReplay}
          </Button>
        </div>
      </fieldset>
      {!pickFile && <p>{labels.unavailable}</p>}
      {currentResult && (
        <div>
          <p>
            {currentResult.operationId} · {currentResult.state}
          </p>
          {currentResult.error && (
            <p role="alert">
              {currentResult.error.code}: {currentResult.error.message}
            </p>
          )}
          {currentResult.result?.kind === "reference" && (
            <p>
              {currentResult.result.value.resultRef.id} @{" "}
              {currentResult.result.value.resultRef.revision}
            </p>
          )}
        </div>
      )}
      {metadataError && <p role="alert">{metadataError}</p>}
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
