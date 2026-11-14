import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
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
import { OptionsSelect } from "@/components/options-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { OperationDetails } from "./operation-details";
import type { OperationText } from "./operation-text";
import { nativeErrorCode } from "@/lib/native-error";
import { parseU64, U64_MAX } from "@/lib/u64";
import { WorkbenchNotice } from "./workbench-notice";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { useToolAction, useToolDraft } from "./transfer-capture-actions";
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
> & {
  recording: string;
  playback: string;
  advanced: string;
  targetFile: string;
  sourceFile: string;
  destinationFile: string;
  operationText: OperationText;
};
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
  const [page, setPage] = useState("recording");
  const [target, setTarget] = useState<SelectedFileResource>();
  const [metadataResult, setMetadataResult] = useState<{
    target: SelectedFileResource;
    read: typeof readMetadata;
    value: FileMetadata;
  }>();
  const [metadataFailure, setMetadataFailure] = useState<{ code?: string }>();
  const metadataError = metadataFailure
    ? labels.operationText.failure(metadataFailure.code)
    : undefined;
  const metadata =
    metadataResult &&
    metadataResult.target === target &&
    metadataResult.read === readMetadata
      ? metadataResult.value
      : undefined;
  useEffect(() => {
    setConfirmed(false);
    setMetadataResult(undefined);
    setMetadataFailure(undefined);
    if (!target || !readMetadata) return;
    const controller = new AbortController();
    void readMetadata(target.reference, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setMetadataResult({ target, read: readMetadata, value });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setMetadataFailure({ code: nativeErrorCode(reason) });
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
  const action = useToolAction((reason) =>
    labels.operationText.failure(nativeErrorCode(reason)),
  );
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
    const capacity = parseU64(draft.capacityMiB),
      reserve = parseU64(draft.reserveMiB);
    if (capacity === undefined || capacity === 0n || reserve === undefined)
      return;
    const capacityBytes = capacity * 1048576n,
      reserveBytes = reserve * 1048576n;
    if (capacityBytes > U64_MAX || reserveBytes > U64_MAX) return;
    return {
      capacityBytes: capacityBytes.toString(),
      reserveBytes: reserveBytes.toString(),
    };
  }, [draft.capacityMiB, draft.reserveMiB]);
  const expectedFingerprint =
    draft.writeMode === "replace" ? metadata?.fingerprint : undefined;
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
            ...(draft.writeMode === "replace" ? { expectedFingerprint } : {}),
          }
        : undefined,
    [
      target,
      sessionRefs,
      replacementReady,
      draft.writeMode,
      expectedFingerprint,
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
      className="workbench-tool-form"
    >
      <Tabs
        value={page}
        onValueChange={setPage}
        className="workbench-tool-pages"
      >
        <TabsList aria-label={labels.captureTools}>
          <TabsTrigger value="recording">{labels.recording}</TabsTrigger>
          <TabsTrigger value="playback">{labels.playback}</TabsTrigger>
          <TabsTrigger value="advanced">{labels.advanced}</TabsTrigger>
        </TabsList>
        <TabsContent value="recording" className="workbench-tool-page">
          <fieldset disabled={locked}>
            <legend className="sr-only">{labels.startCapture}</legend>
            <div className="workbench-form-fields">
              <div className="workbench-form-row">
                <span>{labels.targetFile}</span>
                <div className="workbench-file-selection">
                  <output title={target?.name} data-surface="control">
                    {target?.name ?? labels.selectTarget}
                  </output>
                  <WorkbenchIconButton
                    label={labels.selectTarget}
                    variant="outline"
                    disabled={!pickFile}
                    onClick={() => void action.run(chooseTarget)}
                  >
                    <FolderOpen aria-hidden="true" />
                  </WorkbenchIconButton>
                </div>
              </div>
              <label>
                <span>{labels.writeMode}</span>
                <OptionsSelect<CaptureWriteMode>
                  label={labels.writeMode}
                  value={draft.writeMode}
                  disabled={locked}
                  onValueChange={(value) => {
                    setDraft((current) => ({ ...current, writeMode: value }));
                    setConfirmed(false);
                  }}
                  options={[
                    { value: "create_new", label: labels.createNew },
                    { value: "append", label: labels.append },
                    { value: "replace", label: labels.replace },
                  ]}
                />
              </label>

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
                  <label>
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
            </div>
          </fieldset>
        </TabsContent>
        <TabsContent value="playback" className="workbench-tool-page">
          <fieldset disabled={locked}>
            <legend className="sr-only">{labels.recoveryPreview}</legend>
            <div className="workbench-form-fields">
              <div className="workbench-form-row">
                <span>{labels.sourceFile}</span>
                <div className="workbench-file-selection">
                  <output title={source?.name} data-surface="control">
                    {source?.name ?? labels.selectCapture}
                  </output>
                  <WorkbenchIconButton
                    label={labels.selectCapture}
                    variant="outline"
                    disabled={!pickFile}
                    onClick={() =>
                      void action.run(async (signal) => {
                        const selected = await pickFile!(
                          "captureSource",
                          signal,
                        );
                        if (!signal.aborted && selected) {
                          setSource(selected);
                          setVerificationOperation(undefined);
                          setResult(undefined);
                          setRecoveryUsed(false);
                        }
                      })
                    }
                  >
                    <FolderOpen aria-hidden="true" />
                  </WorkbenchIconButton>
                </div>
              </div>
              <div className="workbench-form-row">
                <span>{labels.destinationFile}</span>
                <div className="workbench-file-selection">
                  <output title={target?.name} data-surface="control">
                    {target?.name ?? labels.selectTarget}
                  </output>
                  <WorkbenchIconButton
                    label={labels.selectTarget}
                    variant="outline"
                    disabled={!pickFile}
                    onClick={() => void action.run(chooseTarget)}
                  >
                    <FolderOpen aria-hidden="true" />
                  </WorkbenchIconButton>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !verifyParams || !onVerify || !canAct("capture.verify")
                  }
                  onClick={() =>
                    void action.run(async (signal) => {
                      if (
                        !verifyParams ||
                        !onVerify ||
                        !canAct("capture.verify")
                      )
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
                  disabled={
                    !exportParams || !onExport || !canAct("capture.export")
                  }
                  onClick={() =>
                    void action.run(async (signal) => {
                      if (
                        !exportParams ||
                        !onExport ||
                        !canAct("capture.export")
                      )
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
                <p>{labels.operationText.states[currentVerification.state]}</p>
              )}
              {currentVerification?.error && (
                <p role="alert">
                  {labels.operationText.failure(currentVerification.error.code)}
                </p>
              )}
              {report && (
                <div aria-label={labels.recoveryPreview} className="space-y-2">
                  <dl className="space-y-1">
                    <div>
                      <dt>{labels.verifiedPrefix}</dt>
                      <dd title={report.verifiedPrefix}>
                        {new Intl.NumberFormat().format(
                          BigInt(report.verifiedPrefix),
                        )}{" "}
                        {labels.operationText.records}
                      </dd>
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
                      <dd>{report.unsettledOperations.length}</dd>
                    </div>
                  </dl>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="outline">
                        {labels.operationText.details}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="workbench-detail-popover">
                      <Textarea
                        readOnly
                        aria-label={labels.operationText.details}
                        value={JSON.stringify(report, null, 2)}
                        onFocus={(event) => event.currentTarget.select()}
                        className="workbench-log-details"
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              )}
              <label>
                <span>{labels.replayMode}</span>
                <OptionsSelect<ReplayMode>
                  label={labels.replayMode}
                  value={draft.replayMode}
                  disabled={locked}
                  onValueChange={(value) => {
                    setDraft((current) => ({
                      ...current,
                      replayMode: value,
                    }));
                  }}
                  options={[
                    { value: "original_timing", label: labels.originalTiming },
                    { value: "fastest", label: labels.fastest },
                  ]}
                />
              </label>
            </div>
          </fieldset>
        </TabsContent>
        <TabsContent value="advanced" className="workbench-tool-page">
          <fieldset disabled={locked}>
            <legend className="sr-only">{labels.advanced}</legend>
            <div className="workbench-form-fields">
              <div className="workbench-form-row">
                <span>{labels.overflowPolicy}</span>
                <output>{labels.stop}</output>
              </div>
              {(["capacityMiB", "reserveMiB"] as const).map((field) => (
                <label key={field}>
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
            </div>
          </fieldset>
        </TabsContent>
      </Tabs>
      <div className="workbench-tool-footer">
        {currentResult && (
          <div className="workbench-toolbar">
            <span>{labels.operationText.states[currentResult.state]}</span>
            <OperationDetails
              operation={currentResult}
              label={labels.operationText.details}
            />
          </div>
        )}
        {page === "playback" ? (
          <>
            {" "}
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
            </Button>{" "}
          </>
        ) : (
          <>
            {" "}
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
            </Button>{" "}
          </>
        )}
      </div>
      <WorkbenchNotice
        noticeKey={`capture-metadata:${target?.reference.id}`}
        log={
          metadataError
            ? {
                module: "capture",
                level: "error",
                message: metadataError,
                code: metadataFailure?.code,
              }
            : undefined
        }
      >
        {metadataError && <p role="alert">{metadataError}</p>}
      </WorkbenchNotice>
      <WorkbenchNotice
        noticeKey={`capture:${action.failureIndex}`}
        eventKey={action.eventKey}
        log={
          action.error
            ? {
                module: "capture",
                level: "error",
                message: action.error,
                code: action.errorCode,
              }
            : undefined
        }
      >
        {action.error && <p role="alert">{action.error}</p>}
      </WorkbenchNotice>
    </section>
  );
}
