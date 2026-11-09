import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaults,
  type WorkspaceDocumentResult,
  type WorkspaceDocument,
  type ReplayControlParams,
} from "@serial-workbench/contracts";
import { useI18n } from "@/providers/i18n";
import { useHost } from "@/providers/host-context";
import { WorkspaceLayout } from "@/features/workbench/workspace-layout";
import { SettingsContext } from "@/providers/settings-context";
import { WorkbenchTools } from "@/features/workbench/workbench-tools";
import { workbenchToolLabels } from "@/features/workbench/tool-labels";
import type { WorkbenchLabels } from "@/features/workbench/labels";
import { Button } from "@/components/ui/button";
import {
  createClientDraftStore,
  type ClientDraftStore,
} from "@/features/workbench/client-drafts";
import {
  readClientWindowState,
  saveClientWindowState,
} from "@/lib/client-settings";
import { nativeErrorText } from "@/lib/native-error";
import { stateScopeKey } from "@/lib/host-scope";
import { createWorkbenchFileActions } from "@/features/workbench/file-actions";

const windowDraftStore = createClientDraftStore({
  read: readClientWindowState,
  save: saveClientWindowState,
});
export default function Overview({
  draftStore = windowDraftStore,
}: { draftStore?: ClientDraftStore } = {}) {
  const { t } = useI18n();
  const host = useHost();
  const settings = useContext(SettingsContext);
  const toolLabels = workbenchToolLabels(t);
  const [savedWorkspace, setSavedWorkspace] = useState<{
    attachment: string;
    observedHostScope: string;
    result: WorkspaceDocumentResult;
  }>();
  const [workspaceDrafts, setWorkspaceDrafts] = useState<
    Record<string, WorkspaceDocument>
  >({});
  const hostWorkspace = host.state.workspace;
  const scopeOf = (value: WorkspaceDocumentResult | undefined) =>
    stateScopeKey(value?.scope);
  const attachmentKey = JSON.stringify([
    host.connection?.attachment.hostId ?? hostWorkspace?.scope.target.hostId,
    host.connection?.attachment.instanceEpoch,
    host.connection?.generation,
  ]);
  const hostScope = scopeOf(hostWorkspace);
  const savedResult =
    savedWorkspace?.attachment === attachmentKey &&
    (hostScope === savedWorkspace.observedHostScope ||
      hostScope === scopeOf(savedWorkspace.result))
      ? savedWorkspace.result
      : undefined;
  const workspaceBase =
    savedResult &&
    hostWorkspace &&
    scopeOf(savedResult) === scopeOf(hostWorkspace) &&
    BigInt(hostWorkspace.document.revision) >
      BigInt(savedResult.document.revision)
      ? hostWorkspace
      : (savedResult ?? hostWorkspace);
  const identityKey = JSON.stringify([attachmentKey, scopeOf(workspaceBase)]);
  const activeIdentity = useRef({
    key: identityKey,
    generation: 0,
    request: 0,
  });
  if (activeIdentity.current.key !== identityKey)
    activeIdentity.current = {
      key: identityKey,
      generation: activeIdentity.current.generation + 1,
      request: 0,
    };
  const renderIdentity = { ...activeIdentity.current };
  const receiptEvidence = useRef(new Map<string, WorkspaceDocumentResult>());
  function acknowledge(
    result: WorkspaceDocumentResult,
    expected: { key: string; generation: number; request?: number } = {
      key: renderIdentity.key,
      generation: renderIdentity.generation,
    },
    select = false,
  ) {
    receiptEvidence.current.set(
      JSON.stringify([attachmentKey, scopeOf(result)]),
      result,
    );
    const current = activeIdentity.current;
    if (
      current.key !== expected.key ||
      current.generation !== expected.generation ||
      (expected.request !== undefined && current.request !== expected.request)
    )
      return false;
    if (!select && scopeOf(result) !== scopeOf(workspaceBase)) return false;
    if (select)
      activeIdentity.current = {
        key: JSON.stringify([attachmentKey, scopeOf(result)]),
        generation: current.generation + 1,
        request: 0,
      };
    setSavedWorkspace({
      attachment: attachmentKey,
      observedHostScope: hostScope,
      result,
    });
    return true;
  }
  const latestWorkspaceDrafts = useRef(workspaceDrafts);
  latestWorkspaceDrafts.current = workspaceDrafts;
  const workspaceScope = JSON.stringify([
    attachmentKey,
    scopeOf(workspaceBase),
  ]);
  const workspaceDraft = workspaceDrafts[workspaceScope];
  const setWorkspaceDraft = useCallback(
    (value: WorkspaceDocument) =>
      setWorkspaceDrafts((current) => ({
        ...current,
        [workspaceScope]: value,
      })),
    [workspaceScope],
  );
  const terminal = settings?.settings.terminal ?? defaults.settings.terminal;
  const currentHost = useRef(host);
  currentHost.current = host;
  const files = useMemo(
    () => createWorkbenchFileActions(() => currentHost.current),
    [],
  );
  const replayControl = useCallback(
    (params: ReplayControlParams, signal?: AbortSignal) => {
      const source = host.state.operations.find(
        (operation) =>
          operation.actionId === "replay.open" &&
          operation.result?.kind === "opened" &&
          operation.result.value.sessionId === params.sessionId,
      );
      if (!source) return Promise.reject(new Error("SESSION_NOT_FOUND"));
      return host.invoke(
        {
          actionId: "replay.control",
          target: {
            hostId: source.executionHostId,
            kind: "session",
            id: params.sessionId,
            sessionId: params.sessionId,
            sessionEpoch: params.sessionEpoch,
          },
          params,
          executionMode: "interactive",
        },
        signal,
      );
    },
    [host],
  );
  const [draftLoad, setDraftLoad] = useState<{
    drafts?: Record<string, string>;
    error?: unknown;
  }>({});
  const [draftAttempt, setDraftAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void draftStore
      .read(controller.signal)
      .then((drafts) => {
        if (!controller.signal.aborted) setDraftLoad({ drafts });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDraftLoad({ error });
      });
    return () => controller.abort();
  }, [draftStore, draftAttempt]);
  function errorCode(error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    )
      return error.code;
    return undefined;
  }
  const hostErrorCode = errorCode(host.state.error);
  const connectionStatus =
    retrying ||
    host.state.status === "connecting" ||
    host.state.status === "error" ||
    host.state.error ? (
      <div className="px-3 py-2 text-sm space-y-2">
        <p role={host.state.error && !retrying ? "alert" : "status"}>
          {retrying
            ? t("workbench.hostRetrying")
            : host.state.status === "connecting"
              ? t("workbench.hostConnecting")
              : t("workbench.hostUnavailable")}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={retrying || host.state.status === "connecting"}
          onClick={async () => {
            setRetrying(true);
            try {
              await host.refresh();
            } catch {
              // The Provider keeps the actual connection error and diagnostics.
            } finally {
              setRetrying(false);
            }
          }}
        >
          {t("common.retry")}
        </Button>
        {host.state.error && (
          <details>
            <summary>{t("common.details")}</summary>
            {hostErrorCode && <code>{hostErrorCode}</code>}
            <p>{nativeErrorText({ code: hostErrorCode }, t)}</p>
            <a className="underline" href="#/settings">
              {t("shell.diagnostics")}
            </a>
          </details>
        )}
      </div>
    ) : undefined;
  const labels: WorkbenchLabels = {
    captureSource: t("workbench.captureSource"),
    captureFirstRecord: t("workbench.captureFirstRecord"),
    captureTail: t("workbench.captureTail"),
    capturePartial: t("workbench.capturePartial"),
    captureEmpty: t("workbench.captureEmpty"),
    captureLoading: t("workbench.captureLoading"),
    captureFingerprint: t("workbench.captureFingerprint"),
    captureLargeRecord: t("workbench.captureLargeRecord"),
    captureActive: t("workbench.captureActive"),
    captureBusy: t("workbench.captureBusy"),
    captureChanged: t("workbench.captureChanged"),
    captureRevision: t("workbench.captureRevision"),
    captureDenied: t("workbench.captureDenied"),
    captureYes: t("workbench.captureYes"),
    captureNo: t("workbench.captureNo"),
    closeView: t("workbench.closeView"),
    closeSession: t("workbench.closeSession"),
    operationInput: t("workbench.operationInput"),
    redactedInput: t("workbench.redactedInput"),
    replay: t("workbench.replay"),
    openReplay: t("workbench.openReplay"),
    pauseReplay: t("workbench.pauseReplay"),
    resumeReplay: t("workbench.resumeReplay"),
    readReplay: t("workbench.readReplay"),
    seekRecord: t("workbench.seekRecord"),
    atEnd: t("workbench.atEnd"),
    sessionMetrics: t("workbench.sessionMetrics"),
    connectionDuration: t("workbench.connectionDuration"),
    rxBytes: t("workbench.rxBytes"),
    txAcceptedBytes: t("workbench.txAcceptedBytes"),
    txUnknownBytes: t("workbench.txUnknownBytes"),
    rxReadErrors: t("workbench.rxReadErrors"),
    txWriteErrors: t("workbench.txWriteErrors"),
    rxBytesPerSecond: t("workbench.rxBytesPerSecond"),
    txAcceptedBytesPerSecond: t("workbench.txAcceptedBytesPerSecond"),
    metricUnavailable: t("workbench.metricUnavailable"),
    lineErrors: t("workbench.lineErrors"),
    frameCounts: t("workbench.frameCounts"),
    metrics: t("workbench.metrics"),
    observedAt: t("workbench.observedAt"),
    rss: t("workbench.rss"),
    rssPeak: t("workbench.rssPeak"),
    sourceMemory: t("workbench.sourceMemory"),
    readerMemory: t("workbench.readerMemory"),
    captureMemory: t("workbench.captureMemory"),
    peak: t("workbench.peak"),
    written: t("workbench.written"),
    flushed: t("workbench.flushed"),
    synced: t("workbench.synced"),
    verified: t("workbench.verified"),
    containerComplete: t("workbench.containerComplete"),
    sourceContinuous: t("workbench.sourceContinuous"),
    title: t("workbench.title"),
    devices: t("workbench.devices"),
    refresh: t("workbench.refresh"),
    open: t("workbench.open"),
    opening: t("workbench.opening"),
    noDevices: t("workbench.noDevices"),
    sessions: t("workbench.sessions"),
    duplicateView: t("workbench.duplicateView"),
    noSession: t("workbench.noSession"),
    bindingUnavailable: t("workbench.bindingUnavailable"),
    pinned: t("workbench.pinned"),
    readOnly: t("workbench.readOnly"),
    takeover: t("workbench.takeover"),
    terminal: t("workbench.terminal"),
    text: t("workbench.text"),
    hex: t("workbench.hex"),
    split: t("workbench.split"),
    freeze: t("workbench.freeze"),
    resume: t("workbench.resume"),
    search: t("workbench.search"),
    searchMode: t("workbench.searchMode"),
    find: t("workbench.find"),
    noMatches: t("workbench.noMatches"),
    offset: t("workbench.offset"),
    gap: t("workbench.gap"),
    emptyStream: t("workbench.emptyStream"),
    send: t("workbench.send"),
    draft: t("workbench.draft"),
    unconnectedDraft: t("workbench.unconnectedDraft"),
    sendMode: t("workbench.sendMode"),
    lineEnding: t("workbench.lineEnding"),
    none: t("workbench.none"),
    preview: t("workbench.preview"),
    invalidHex: t("workbench.invalidHex"),
    sending: t("workbench.sending"),
    receipt: t("workbench.receipt"),
    awaitingReceipt: t("workbench.awaitingReceipt"),
    previousPage: t("common.previous"),
    nextPage: t("common.next"),
    sendFile: t("workbench.sendFile"),
    fileUnavailable: t("workbench.fileUnavailable"),
    capture: t("workbench.capture"),
    startCapture: t("workbench.startCapture"),
    stopCapture: t("workbench.stopCapture"),
    tasks: t("workbench.tasks"),
    activity: t("workbench.activity"),
    emptyTasks: t("workbench.emptyTasks"),
    locate: t("workbench.locate"),
    follow: t("workbench.follow"),
    pauseFollow: t("workbench.pauseFollow"),
    expand: t("workbench.expand"),
    saveDrafts: t("workbench.saveDrafts"),
    disconnected: t("workbench.disconnected"),
    connectionHelp: t("workbench.connectionHelp"),
    encodingHelp: t("workbench.encodingHelp"),
    gapHelp: t("workbench.gapHelp"),
    disconnectHelp: t("workbench.disconnectHelp"),
    cancel: t("workbench.cancel"),
    status: t("workbench.status"),
    bytes: t("workbench.bytes"),
    requestedBytes: t("workbench.requestedBytes"),
    acceptedBytes: t("workbench.acceptedBytes"),
    unknownBytes: t("workbench.unknownBytes"),
    peerConfirmed: t("workbench.peerConfirmed"),
    peerUnconfirmed: t("workbench.peerUnconfirmed"),
    unavailable: t("workbench.unavailable"),
  };
  return (
    <section
      className="studio-page workbench-page"
      data-testid="serial-workbench-shell"
      aria-label={t("shell.title")}
    >
      {draftLoad.drafts ? (
        <WorkspaceLayout
          host={host}
          labels={labels}
          connectionStatus={connectionStatus}
          formatError={(error) => nativeErrorText(error, t)}
          unboundDraftMessage={t("workbench.unboundDraft")}
          initialWorkspace={workspaceDraft ?? workspaceBase?.document.value}
          workspaceKey={workspaceScope}
          workspaceRevision={workspaceBase?.document.revision}
          workspaceSelection={renderIdentity.generation}
          readCaptureTail={host.readCaptureTail}
          terminalSettings={terminal}
          viewColor={
            settings?.settings.customAccent ?? defaults.settings.customAccent
          }
          onSaveWindowLayout={
            workspaceBase
              ? async (value, signal) => {
                  const expected = {
                    ...activeIdentity.current,
                    request: activeIdentity.current.request + 1,
                  };
                  activeIdentity.current = expected;
                  const before = latestWorkspaceDrafts.current[workspaceScope];
                  const result = await host.saveWorkspace(
                    workspaceBase,
                    value,
                    signal,
                  );
                  if (signal?.aborted) {
                    receiptEvidence.current.set(
                      JSON.stringify([attachmentKey, scopeOf(result)]),
                      result,
                    );
                    return;
                  }
                  if (!acknowledge(result, expected)) return;
                  if (latestWorkspaceDrafts.current[workspaceScope] === before)
                    setWorkspaceDrafts((current) => ({
                      ...current,
                      [workspaceScope]: result.document.value,
                    }));
                }
              : undefined
          }
          presentationLabels={toolLabels.presentation}
          toolLabels={toolLabels.layout}
          renderTool={(tool, context) => (
            <WorkbenchTools
              tool={tool}
              context={context}
              host={host}
              base={workspaceBase}
              draft={workspaceDraft ?? workspaceBase?.document.value}
              onChange={setWorkspaceDraft}
              onAcknowledged={(result) => {
                acknowledge(result);
              }}
              onLoaded={(result) => {
                acknowledge(
                  result,
                  {
                    key: renderIdentity.key,
                    generation: renderIdentity.generation,
                  },
                  true,
                );
              }}
            />
          )}
          onCloseSession={(sessionId, signal) => {
            const session = host.state.sessions.find(
              (value) => value.sessionId === sessionId,
            );
            const hostId =
              host.state.devices.find(
                (value) => value.deviceId === session?.deviceId,
              )?.hostId ?? host.connection?.attachment.hostId;
            if (!session || !hostId)
              return Promise.reject(new Error("SESSION_NOT_FOUND"));
            return host.invoke(
              {
                actionId: "session.close",
                target: {
                  hostId,
                  kind: "session",
                  id: sessionId,
                  sessionId,
                  sessionEpoch: session.sessionEpoch,
                },
                params: {},
                executionMode: "interactive",
              },
              signal,
            );
          }}
          initialDrafts={draftLoad.drafts}
          onSaveDrafts={draftStore.save}
          readMetrics={host.metrics}
          readSessionMetrics={host.sessionMetrics}
          readFileReceipts={host.readFileReceipts}
          readCaptureStatus={host.captureStatus}
          readOperationInput={host.operationInput}
          onSendFile={files.send}
          onStartCapture={files.capture}
          onOpenReplay={files.replay}
          replay={{
            read: host.readReplay,
            readRecord: host.readReplayRecord,
            control: replayControl,
          }}
          onStopCapture={(captureRef, signal) =>
            host.invoke(
              {
                actionId: "capture.stop",
                target: {
                  hostId: captureRef.hostId,
                  kind: captureRef.kind,
                  id: captureRef.id,
                },
                params: { captureRef },
                executionMode: "independent",
              },
              signal,
            )
          }
        />
      ) : (
        <div aria-busy={draftLoad.error === undefined}>
          <h1 className="sr-only">{labels.title}</h1>
          {connectionStatus}
          <p role="status">
            {draftLoad.error === undefined
              ? t("workbench.draftLoading")
              : t("workbench.draftLoadFailed")}
          </p>
          {draftLoad.error !== undefined && (
            <>
              <p role="alert">
                {nativeErrorText({ code: errorCode(draftLoad.error) }, t)}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraftLoad({});
                  setDraftAttempt((attempt) => attempt + 1);
                }}
              >
                {t("workbench.retryDrafts")}
              </Button>
              <a className="underline" href="#/settings">
                {t("shell.diagnostics")}
              </a>
            </>
          )}
        </div>
      )}
    </section>
  );
}
