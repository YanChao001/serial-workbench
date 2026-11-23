import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ContractValidationError,
  defaults,
  type ActionSpec,
  type WorkspaceDocumentResult,
  type WorkspaceDocument,
  type ReplayControlParams,
  type Operation,
} from "@serial-workbench/contracts";
import { useI18n } from "@/providers/i18n";
import { useHost } from "@/providers/host-context";
import { WorkspaceLayout } from "@/features/workbench/workspace-layout";
import { sameWorkspace } from "@/features/workbench/workspace-model";
import { SettingsContext } from "@/providers/settings-context";
import { WorkbenchTools } from "@/features/workbench/workbench-tools";
import { workbenchToolLabels } from "@/features/workbench/tool-labels";
import type { WorkbenchLabels } from "@/features/workbench/labels";
import { operationText } from "@/features/workbench/operation-text";
import { Button } from "@/components/ui/button";
import type { ClientDraftStore } from "@/features/workbench/client-drafts";
import { useClientDraftStore } from "@/providers/client-drafts-context";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { rpcJsonObject } from "@/lib/rpc-json";
import { stateScopeKey } from "@/lib/host-scope";
import { createWorkbenchFileActions } from "@/features/workbench/file-actions";
import { connectionKey } from "@/lib/client-connection-defaults";
import { HostConnectionNotice } from "@/features/workbench/host-connection-notice";
import { WorkbenchNotice } from "@/features/workbench/workbench-notice";
import { settingsLocation } from "@/routes";
import { HostRequestError } from "@serial-workbench/host-client";

function advertisesReplayParam(
  catalog: readonly ActionSpec[],
  actionId: string,
  param: string,
) {
  const fields = catalog.find((entry) => entry.actionId === actionId)
    ?.inputSchema.properties;
  return (
    fields !== null &&
    typeof fields === "object" &&
    Object.hasOwn(fields, param)
  );
}

export default function Overview({
  draftStore: suppliedDraftStore,
}: { draftStore?: ClientDraftStore } = {}) {
  const draftStore = useClientDraftStore(suppliedDraftStore);
  const { t } = useI18n();
  const host = useHost();
  const settings = useContext(SettingsContext);
  const toolLabels = useMemo(() => workbenchToolLabels(t), [t]);
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
  function acknowledge(
    result: WorkspaceDocumentResult,
    expected: { key: string; generation: number; request?: number } = {
      key: renderIdentity.key,
      generation: renderIdentity.generation,
    },
    select = false,
  ) {
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
      setWorkspaceDrafts((current) => {
        if (sameWorkspace(value, workspaceBase?.document.value)) {
          const next = { ...current };
          delete next[workspaceScope];
          return next;
        }
        return { ...current, [workspaceScope]: value };
      }),
    [workspaceScope, workspaceBase?.document.value],
  );
  const terminal = settings?.settings.terminal ?? defaults.settings.terminal;
  const currentHost = useRef(host);
  currentHost.current = host;
  const currentWaitModes = useRef(settings?.connections?.waitModes);
  currentWaitModes.current = settings?.connections?.waitModes;
  const files = useMemo(
    () =>
      createWorkbenchFileActions(
        () => currentHost.current,
        (hostId, deviceId) =>
          currentWaitModes.current?.[connectionKey(hostId, deviceId)] ??
          "automatic",
      ),
    [],
  );
  const replayConnection = host.connection;
  const replayPlaybackSupported =
    advertisesReplayParam(host.state.catalog, "replay.read", "singleStep") &&
    advertisesReplayParam(
      host.state.catalog,
      "replay.read",
      "inspectPlayback",
    ) &&
    advertisesReplayParam(host.state.catalog, "replay.control", "playback");
  const replayControl = useCallback(
    async (params: ReplayControlParams, signal?: AbortSignal) => {
      const owner = currentHost.current;
      if (!replayConnection || owner.connection !== replayConnection)
        throw new HostRequestError({
          code: "NOT_FOUND",
          message: "Replay session is unavailable",
          retryable: false,
        });
      const accepted = await owner.invoke(
        {
          actionId: "replay.control",
          target: {
            hostId: replayConnection.attachment.hostId,
            kind: "session",
            id: params.sessionId,
            sessionId: params.sessionId,
            sessionEpoch: params.sessionEpoch,
          },
          params: rpcJsonObject(params),
          executionMode: "interactive",
        },
        signal,
      );
      const completed = await owner.waitForOperation(accepted, signal);
      signal?.throwIfAborted();
      if (currentHost.current.connection !== replayConnection)
        throw new DOMException("Replay connection changed", "AbortError");
      if (completed.result?.kind !== "replay_position")
        throw new ContractValidationError("Replay control result changed");
      return completed.result.value;
    },
    [replayConnection],
  );
  const [draftLoad, setDraftLoad] = useState<{
    drafts?: Record<string, string>;
    error?: unknown;
  }>(() => ({ drafts: draftStore.getSnapshot() }));
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
  const hostErrorCode = nativeErrorCode(host.state.error);
  async function retryHostConnection() {
    if (retrying || host.state.status === "connecting") return;
    setRetrying(true);
    try {
      await host.refresh();
    } catch {
      // Provider 保留真实连接错误；这里只控制当前重试按钮的忙状态。
    } finally {
      setRetrying(false);
    }
  }
  const connectionRecovery =
    retrying ||
    host.state.status === "connecting" ||
    host.state.status === "error"
      ? {
          label: retrying
            ? t("workbench.hostRetrying")
            : host.state.status === "connecting"
              ? t("workbench.hostConnecting")
              : t("workbench.retryHost"),
          busy: retrying || host.state.status === "connecting",
          onRetry: () => {
            void retryHostConnection();
          },
        }
      : undefined;
  const connectionStatus =
    retrying ||
    host.state.status === "connecting" ||
    host.state.status === "error" ||
    host.state.error ? (
      <HostConnectionNotice
        busy={retrying || host.state.status === "connecting"}
        title={
          retrying
            ? t("workbench.hostRetrying")
            : host.state.status === "connecting"
              ? t("workbench.hostConnecting")
              : t("workbench.hostUnavailable")
        }
        description={
          retrying || host.state.status === "connecting"
            ? draftLoad.drafts === undefined && draftLoad.error === undefined
              ? t("workbench.draftLoading")
              : t("workbench.hostWaiting")
            : nativeErrorText({ code: hostErrorCode }, t)
        }
        labels={{
          retry: t("common.retry"),
          diagnostics: t("shell.diagnostics"),
          code: t("logs.code"),
        }}
        errorCode={hostErrorCode}
        onRetry={() => void retryHostConnection()}
      />
    ) : undefined;
  const labels = useMemo<WorkbenchLabels>(
    () => ({
      operationText: operationText(t, (code) => nativeErrorText({ code }, t)),
      logs: t("workbench.logs"),
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
      captureStatusDetails: t("workbench.captureStatusDetails"),
      stopRequested: t("workbench.stopRequested"),
      retry: t("common.retry"),
      captureStates: {
        recording: t("workbench.captureState.recording"),
        finalizing: t("workbench.captureState.finalizing"),
        complete: t("workbench.captureState.complete"),
        incomplete: t("workbench.captureState.incomplete"),
        failed: t("workbench.captureState.failed"),
      },
      closeView: t("workbench.closeView"),
      pluginTransportParameters: t("workbench.pluginTransportParameters"),
      pluginTransportHint: t("workbench.pluginTransportHint"),
      pluginTransportInvalid: t("workbench.pluginTransportInvalid"),
      closeOtherViews: t("workbench.closeOtherViews"),
      closeAllViews: t("workbench.closeAllViews"),
      closeSession: t("workbench.closeSession"),
      disconnect: t("workbench.disconnect"),
      displayedTxBytes: t("workbench.displayedTxBytes"),
      displayedRxBytes: t("workbench.displayedRxBytes"),
      restoreAccess: t("workbench.restoreAccess"),
      restoringAccess: t("workbench.restoringAccess"),
      operationInput: t("workbench.operationInput"),
      redactedInput: t("workbench.redactedInput"),
      replay: t("workbench.replay"),
      openReplay: t("workbench.openReplay"),
      pauseReplay: t("workbench.pauseReplay"),
      resumeReplay: t("workbench.resumeReplay"),
      readReplay: t("workbench.readReplay"),
      seekRecord: t("workbench.seekRecord"),
      stepReplay: t("workbench.stepReplay"),
      replayPlayback: t("workbench.replayPlayback"),
      replayRate: t("workbench.replayRate"),
      replayFastest: t("workbench.replayFastest"),
      replayBreakpoint: t("workbench.replayBreakpoint"),
      setReplayBreakpoint: t("workbench.setReplayBreakpoint"),
      clearReplayBreakpoint: t("workbench.clearReplayBreakpoint"),
      replayBreakpointHit: t("workbench.replayBreakpointHit"),
      replayPaused: t("workbench.replayPaused"),
      replayNextRecord: t("workbench.replayNextRecord"),
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
      sessionLabel: t("workbench.sessionLabel"),
      duplicateView: t("workbench.duplicateView"),
      noSession: t("workbench.noSession"),
      bindingUnavailable: t("workbench.bindingUnavailable"),
      bindingUnmatched: t("workbench.bindingUnmatched"),
      pinned: t("workbench.pinned"),
      readOnly: t("workbench.readOnly"),
      takeover: t("workbench.takeover"),
      takeoverPort: (port) => t("workbench.takeoverPort", { port }),
      takeoverPending: t("workbench.takeoverPending"),
      browserTakeoverPending: t("workbench.browserTakeoverPending"),
      requestTakeoverPort: (port) =>
        t("workbench.requestTakeoverPort", { port }),
      takeoverDone: t("workbench.takeoverDone"),
      terminal: t("workbench.terminal"),
      text: t("workbench.text"),
      hex: t("workbench.hex"),
      split: t("workbench.split"),
      freeze: t("workbench.freeze"),
      resume: t("workbench.resume"),
      displayPaused: t("workbench.displayPaused"),
      pendingUpdates: t("workbench.pendingUpdates"),
      newUpdates: t("workbench.newUpdates"),
      returnToLatest: t("workbench.returnToLatest"),
      clearDraft: t("workbench.clearDraft"),
      search: t("workbench.search"),
      searchCase: t("workbench.searchCase"),
      searchWord: t("workbench.searchWord"),
      searchRegex: t("workbench.searchRegex"),
      searchPrevious: t("workbench.searchPrevious"),
      searchClose: t("workbench.searchClose"),
      searchInvalid: t("workbench.searchInvalid"),
      searchTimeout: t("workbench.searchTimeout"),
      searchEncoding: t("workbench.searchEncoding"),
      receiveEncoding: t("workbench.receiveEncoding"),
      sendEncoding: t("workbench.sendEncoding"),
      encodingAuto: t("workbench.encodingAuto"),
      encodingAutoShort: t("workbench.encodingAutoShort"),
      encodingPending: t("workbench.encodingPending"),
      encodingGuessHelp: t("workbench.encodingGuessHelp"),
      encodingCandidates: t("workbench.encodingCandidates"),
      encodingSampleBytes: t("workbench.encodingSampleBytes"),
      encodingEvidencePending: t("workbench.encodingEvidencePending"),
      encodingEvidenceBom: t("workbench.encodingEvidenceBom"),
      encodingEvidenceUtf8: t("workbench.encodingEvidenceUtf8"),
      encodingEvidenceGuess: t("workbench.encodingEvidenceGuess"),
      invalidEncoding: t("workbench.invalidEncoding"),
      unrepresentableEncoding: t("workbench.unrepresentableEncoding"),
      encodingLoading: t("workbench.encodingLoading"),
      encodingLoadFailed: t("workbench.encodingLoadFailed"),
      searchLimit: t("workbench.searchLimit"),
      searchDirection: t("workbench.searchDirection"),
      searchAllDirections: t("workbench.searchAllDirections"),
      searchMatchVisibility: t("workbench.searchMatchVisibility"),
      searchShowAll: t("workbench.searchShowAll"),
      searchOnlyMatches: t("workbench.searchOnlyMatches"),
      searchHideMatches: t("workbench.searchHideMatches"),
      searchPartial: t("workbench.searchPartial"),
      searchMode: t("workbench.searchMode"),
      find: t("workbench.find"),
      noMatches: t("workbench.noMatches"),
      offset: t("workbench.offset"),
      gap: t("workbench.gap"),
      configurationApplied: t("workbench.configurationApplied"),
      configurationUncertain: t("workbench.configurationUncertain"),
      controlEvent: t("workbench.controlEvent"),
      emptyStream: t("workbench.emptyStream"),
      send: t("workbench.send"),
      draft: t("workbench.draft"),
      unconnectedDraft: t("workbench.unconnectedDraft"),
      sendMode: t("workbench.sendMode"),
      expandSendEscapes: t("workbench.expandSendEscapes"),
      mixedSendInput: t("workbench.mixedSendInput"),
      mixedSendSyntax: t("workbench.mixedSendSyntax"),
      mixedSendPreview: t("workbench.mixedSendPreview"),
      mixedSendInvalidAt: t("workbench.mixedSendInvalidAt"),
      mixedSendUseHex: t("workbench.mixedSendUseHex"),
      mixedSendDraftChanged: t("workbench.mixedSendDraftChanged"),
      invalidSendEscape: t("workbench.invalidSendEscape"),
      escapedDraftTooLong: t("workbench.escapedDraftTooLong"),
      lineEnding: t("workbench.lineEnding"),
      sendChecksum: t("workbench.sendChecksum"),
      checksumAlgorithm: t("workbench.checksumAlgorithm"),
      checksumOrder: t("workbench.checksumOrder"),
      checksumLittleEndian: t("workbench.checksumLittleEndian"),
      checksumBigEndian: t("workbench.checksumBigEndian"),
      checksumStart: t("workbench.checksumStart"),
      checksumEnd: t("workbench.checksumEnd"),
      checksumIncludeEnding: t("workbench.checksumIncludeEnding"),
      checksumRangeHint: t("workbench.checksumRangeHint"),
      checksumInvalidRange: t("workbench.checksumInvalidRange"),
      checksumBytes: t("workbench.checksumBytes"),
      none: t("workbench.none"),
      draftByteCount: t("workbench.draftByteCount"),
      invalidHex: t("workbench.invalidHex"),
      invalidHexDraftAt: t("workbench.invalidHexDraftAt"),
      invalidHexEndingAt: t("workbench.invalidHexEndingAt"),
      invalidUtf8: t("workbench.invalidUtf8"),
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
      mcpClient: t("workbench.mcpClient"),
      mcpUnbound: t("workbench.mcpUnbound"),
      emptyTasks: t("workbench.emptyTasks"),
      locate: t("workbench.locate"),
      follow: t("workbench.follow"),
      pauseFollow: t("workbench.pauseFollow"),
      expand: t("workbench.expand"),
      saveDrafts: t("workbench.saveDrafts"),
      disconnected: t("workbench.disconnected"),
      encodingHelp: t("workbench.encodingHelp"),
      wrapReceiveText: t("workbench.wrapReceiveText"),
      highlightRules: t("workbench.highlightRules"),
      highlightHelp: t("workbench.highlightHelp"),
      highlightRule: t("workbench.highlightRule"),
      highlightEnabled: t("workbench.highlightEnabled"),
      highlightUp: t("workbench.highlightUp"),
      highlightDown: t("workbench.highlightDown"),
      highlightRemove: t("workbench.highlightRemove"),
      highlightMode: t("workbench.highlightMode"),
      highlightKeyword: t("workbench.highlightKeyword"),
      highlightRegex: t("workbench.highlightRegex"),
      highlightPattern: t("workbench.highlightPattern"),
      highlightForeground: t("workbench.highlightForeground"),
      highlightBackground: t("workbench.highlightBackground"),
      highlightBold: t("workbench.highlightBold"),
      highlightAdd: t("workbench.highlightAdd"),
      highlightInvalid: t("workbench.highlightInvalid"),
      highlightLimit: t("workbench.highlightLimit"),
      highlightTimeout: t("workbench.highlightTimeout"),
      highlightFailed: t("workbench.highlightFailed"),
      receiveIdleGap: t("workbench.receiveIdleGap"),
      receiveIdleHelp: t("workbench.receiveIdleHelp"),
      receiveTimeHostRead: t("workbench.receiveTimeHostRead"),
      receiveTimeDevice: t("workbench.receiveTimeDevice"),
      receiveTimeLineCapture: t("workbench.receiveTimeLineCapture"),
      receiveTimeSampleClock: t("workbench.receiveTimeSampleClock"),
      showTransmitEcho: t("workbench.showTransmitEcho"),
      transmitSource: t("workbench.transmitSource"),
      hexColumns: t("workbench.hexColumns"),
      hexGroup: t("workbench.hexGroup"),
      hexLowerCase: t("workbench.hexLowerCase"),
      hexAddresses: t("workbench.hexAddresses"),
      hexAscii: t("workbench.hexAscii"),
      inspectNumber: t("workbench.inspectNumber"),
      numberSelection: t("workbench.numberSelection"),
      numberWidth: t("workbench.numberWidth"),
      numberSourceBytes: t("workbench.numberSourceBytes"),
      numberSigned: t("workbench.numberSigned"),
      numberUnsigned: t("workbench.numberUnsigned"),
      numberFloat: t("workbench.numberFloat"),
      copySelection: t("workbench.copySelection"),
      copySelectionHint: t("workbench.copySelectionHint"),
      copyFormat: t("workbench.copyFormat"),
      copyFormatText: t("workbench.copyFormatText"),
      copyFormatTimed: t("workbench.copyFormatTimed"),
      copyFormatC: t("workbench.copyFormatC"),
      copyEncoding: t("workbench.copyEncoding"),
      copyTimestamp: t("workbench.copyTimestamp"),
      copySourceTime: t("workbench.copySourceTime"),
      copyReceivedTime: t("workbench.copyReceivedTime"),
      copyButton: t("workbench.copyButton"),
      copyWorking: t("workbench.copyWorking"),
      copyDone: t("workbench.copyDone"),
      streamLocation: t("workbench.streamLocation"),
      locationShowNumbers: t("workbench.locationShowNumbers"),
      locationType: t("workbench.locationType"),
      locationReference: t("workbench.locationReference"),
      locationLine: t("workbench.locationLine"),
      locationPacket: t("workbench.locationPacket"),
      locationEvent: t("workbench.locationEvent"),
      locationCopy: t("workbench.locationCopy"),
      locationJump: t("workbench.locationJump"),
      longRecord: t("workbench.longRecord"),
      longRecordPartial: t("workbench.longRecordPartial"),
      longRecordPrevious: t("workbench.longRecordPrevious"),
      longRecordNext: t("workbench.longRecordNext"),
      locationFound: t("workbench.locationFound"),
      locationInvalid: t("workbench.locationInvalid"),
      locationUnavailable: t("workbench.locationUnavailable"),
      locationAmbiguous: t("workbench.locationAmbiguous"),
      copyFailed: t("workbench.copyFailed"),
      automaticColumns: t("workbench.automaticColumns"),
      ansiScreen: t("workbench.ansiScreen"),
      ansiScreenLoading: t("workbench.ansiScreenLoading"),
      ansiScreenBusy: t("workbench.ansiScreenBusy"),
      ansiConvertLf: t("workbench.ansiConvertLf"),
      ansiKeyboard: t("workbench.ansiKeyboard"),
      ansiKeyboardExit: t("workbench.ansiKeyboardExit"),
      ansiLocalEcho: t("workbench.ansiLocalEcho"),
      ansiLocalEchoHint: t("workbench.ansiLocalEchoHint"),
      ansiMouse: t("workbench.ansiMouse"),
      ansiSizeReport: t("workbench.ansiSizeReport"),
      ansiSizeReportHint: t("workbench.ansiSizeReportHint"),
      ansiShell: t("workbench.ansiShell"),
      ansiShellHint: t("workbench.ansiShellHint"),
      ansiShellColor: t("workbench.ansiShellColor"),
      ansiShellMono: t("workbench.ansiShellMono"),
      ansiShellBasic: t("workbench.ansiShellBasic"),
      ansiShellIndexed: t("workbench.ansiShellIndexed"),
      ansiShellTruecolor: t("workbench.ansiShellTruecolor"),
      ansiShellRows: t("workbench.ansiShellRows"),
      ansiShellColumns: t("workbench.ansiShellColumns"),
      ansiShellInsert: t("workbench.ansiShellInsert"),
      ansiShellQueued: t("workbench.ansiShellQueued"),
      ansiLinks: t("workbench.ansiLinks"),
      ansiScrollback: t("workbench.ansiScrollback"),
      ansiScrollbackLimit: t("workbench.ansiScrollbackLimit"),
      ansiScrollbackRange: t("workbench.ansiScrollbackRange"),
      ansiScrollbackTrimmed: t("workbench.ansiScrollbackTrimmed"),
      ansiScrollbackAlternate: t("workbench.ansiScrollbackAlternate"),
      ansiScrollbackFirst: t("workbench.ansiScrollbackFirst"),
      ansiScrollbackLatest: t("workbench.ansiScrollbackLatest"),
      ansiScrollbackLine: t("workbench.ansiScrollbackLine"),
      ansiScrollbackJump: t("workbench.ansiScrollbackJump"),
      ansiScrollbackApply: t("workbench.ansiScrollbackApply"),
      ansiScrollbackHelp: t("workbench.ansiScrollbackHelp"),
      ansiSearch: t("workbench.ansiSearch"),
      ansiSearchNext: t("workbench.ansiSearchNext"),
      ansiSearchPending: t("workbench.ansiSearchPending"),
      ansiSearchChanged: t("workbench.ansiSearchChanged"),
      ansiSearchFailed: t("workbench.ansiSearchFailed"),
      ansiExportColors: t("workbench.ansiExportColors"),
      ansiExportColorsFailed: t("workbench.ansiExportColorsFailed"),
      ansiKeyboardError: t("workbench.ansiKeyboardError"),
      ansiKeyboardOverflow: t("workbench.ansiKeyboardOverflow"),
      ansiPaste: t("workbench.ansiPaste"),
      ansiPasteBracketed: t("workbench.ansiPasteBracketed"),
      ansiPasteBytes: t("workbench.ansiPasteBytes"),
      ansiPasteTooLarge: t("workbench.ansiPasteTooLarge"),
      ansiPasteInvalidBracket: t("workbench.ansiPasteInvalidBracket"),
      ansiPasteSending: t("workbench.ansiPasteSending"),
      ansiPasteCancelling: t("workbench.ansiPasteCancelling"),
      ansiPasteSent: t("workbench.ansiPasteSent"),
      ansiPasteCancelled: t("workbench.ansiPasteCancelled"),
      ansiPasteFailed: t("workbench.ansiPasteFailed"),
      ansiPasteUnconfirmed: t("workbench.ansiPasteUnconfirmed"),
      ansiPasteCancelFailed: t("workbench.ansiPasteCancelFailed"),
      ansiPasteAccepted: t("workbench.ansiPasteAccepted"),
      gapHelp: t("workbench.gapHelp"),
      historyRetention: t("workbench.historyRetention"),
      historyRecords: t("workbench.historyRecords"),
      historyCapacity: t("workbench.historyCapacity"),
      historyHint: t("workbench.historyHint"),
      historyTrimmed: t("workbench.historyTrimmed"),
      disconnectHelp: t("workbench.disconnectHelp"),
      cancel: t("workbench.cancel"),
      status: t("workbench.status"),
      bytes: t("workbench.bytes"),
      requestedBytes: t("workbench.requestedBytes"),
      acceptedBytes: t("workbench.acceptedBytes"),
      unknownBytes: t("workbench.unknownBytes"),
      peerConfirmed: t("workbench.peerConfirmed"),
      peerUnconfirmed: t("workbench.peerUnconfirmed"),
      connected: t("workbench.connected"),
      closed: t("workbench.closed"),
      closing: t("workbench.closing"),
      ready: t("workbench.ready"),
      configurationPending: t("workbench.configurationPending"),
      controlUnknown: t("workbench.controlUnknown"),
      queued: t("workbench.queued"),
      running: t("workbench.running"),
      cancelRequested: t("workbench.cancelRequested"),
      succeeded: t("workbench.succeeded"),
      failed: t("workbench.failed"),
      cancelled: t("workbench.cancelled"),
      interrupted: t("workbench.interrupted"),
      unknown: t("workbench.unknown"),
      accepted: t("workbench.accepted"),
      partial: t("workbench.partial"),
      rejected: t("workbench.rejected"),
      emptyDraft: t("workbench.emptyDraft"),
      sendLimit: t("workbench.sendLimit"),
      sendNotAllowed: t("workbench.sendNotAllowed"),
      streamUnavailable: t("workbench.streamUnavailable"),
      errorDetails: t("workbench.errorDetails"),
      unavailable: t("workbench.unavailable"),
    }),
    [t],
  );
  return (
    <section
      className="studio-page workbench-page"
      data-testid="serial-workbench-shell"
      aria-label={t("shell.title")}
    >
      <WorkspaceLayout
        draftsReady={draftLoad.drafts !== undefined}
        connectionLog={
          connectionStatus
            ? {
                module: "connection",
                level:
                  host.state.error || host.state.status === "error"
                    ? "error"
                    : "info",
                message: retrying
                  ? t("workbench.hostRetrying")
                  : host.state.status === "connecting"
                    ? t("workbench.hostConnecting")
                    : t("workbench.hostUnavailable"),
                code: hostErrorCode,
              }
            : undefined
        }
        connectionRecovery={connectionRecovery}
        host={host}
        connectionDefaults={settings?.connections?.values}
        connectionWaitModes={settings?.connections?.waitModes}
        connectionDefaultsLoading={settings?.connections?.status === "loading"}
        onRememberConnection={settings?.connections?.remember}
        labels={labels}
        connectionStatus={connectionStatus}
        formatError={(error) => nativeErrorText(error, t)}
        unboundDraftMessage={t("workbench.unboundDraft")}
        initialWorkspace={workspaceDraft ?? workspaceBase?.document.value}
        savedWorkspace={workspaceBase?.document.value}
        preserveWorkspacePresets={workspaceDraft !== undefined}
        workspaceKey={workspaceScope}
        draftScopeKey={
          workspaceBase ? stateScopeKey(workspaceBase.scope) : undefined
        }
        workspaceRevision={workspaceBase?.document.revision}
        workspaceSelection={renderIdentity.generation}
        readCaptureTail={host.readCaptureTail}
        terminalSettings={terminal}
        receiveHistory={settings?.settings.receiveHistory}
        onReceiveHistoryChange={
          settings
            ? (value) => settings.update({ receiveHistory: value })
            : undefined
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
                if (signal?.aborted) return;
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
              if (acknowledge(result))
                setWorkspaceDrafts((current) => {
                  if (
                    !sameWorkspace(
                      current[workspaceScope],
                      result.document.value,
                    )
                  )
                    return current;
                  const next = { ...current };
                  delete next[workspaceScope];
                  return next;
                });
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
        onCancelOperation={async (operation, signal) => {
          const input = {
            actionId: "operation.cancel",
            target: {
              hostId: operation.executionHostId,
              kind: "operation",
              id: operation.operationId,
            },
            params: { reason: "user" },
          };
          const check = await host.checkAction(input, signal);
          signal?.throwIfAborted();
          if (!check.allowed) throw { code: "PERMISSION_DENIED" };
          const accepted = await host.invoke(
            { ...input, executionMode: "independent" },
            signal,
          );
          const receipt = await host.waitForOperation(accepted, signal);
          signal?.throwIfAborted();
          if (
            receipt.actionId !== input.actionId ||
            receipt.executionHostId !== operation.executionHostId ||
            receipt.target.hostId !== input.target.hostId ||
            receipt.target.kind !== input.target.kind ||
            receipt.target.id !== operation.operationId
          )
            throw { code: "CONTRACT_MISMATCH" };
          if (receipt.state !== "succeeded")
            throw { code: receipt.error?.code ?? "OPERATION_FAILED" };
          if (
            receipt.result?.kind !== "cancellation_requested" ||
            receipt.result.value.operationId !== operation.operationId
          )
            throw { code: "CONTRACT_MISMATCH" };
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
          playbackSupported: replayPlaybackSupported,
        }}
        onStopCapture={async (captureRef, signal) => {
          signal?.throwIfAborted();
          const target = {
            hostId: captureRef.hostId,
            kind: captureRef.kind,
            id: captureRef.id,
          };
          const matches = (operation: Operation) =>
            operation.actionId === "capture.stop" &&
            operation.executionHostId === target.hostId &&
            operation.target.hostId === target.hostId &&
            operation.target.kind === target.kind &&
            operation.target.id === target.id &&
            operation.target.sessionId === undefined &&
            operation.target.sessionEpoch === undefined;
          const accepted = await host.invoke(
            {
              actionId: "capture.stop",
              target,
              params: { captureRef },
              executionMode: "independent",
            },
            signal,
          );
          signal?.throwIfAborted();
          if (!matches(accepted)) throw { code: "CONTRACT_MISMATCH" };
          const receipt = await host.waitForOperation(accepted, signal);
          signal?.throwIfAborted();
          if (receipt.operationId !== accepted.operationId || !matches(receipt))
            throw { code: "CONTRACT_MISMATCH" };
          if (receipt.state !== "succeeded" || receipt.error)
            throw {
              code: receipt.error?.code ?? "OPERATION_ABORTED",
              executionHostId: receipt.executionHostId,
              operationId: receipt.operationId,
            };
        }}
      />
      <WorkbenchNotice
        noticeKey={`drafts:${draftLoad.error === undefined ? "loading" : nativeErrorCode(draftLoad.error)}`}
        duration={Infinity}
      >
        {draftLoad.drafts === undefined &&
          (draftLoad.error !== undefined ? (
            <>
              <p>{t("workbench.draftLoadFailed")}</p>
              <p role="alert">
                {nativeErrorText({ code: nativeErrorCode(draftLoad.error) }, t)}
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
              <a
                className="underline"
                href={`#${settingsLocation("recovery")}`}
              >
                {t("shell.diagnostics")}
              </a>
            </>
          ) : !connectionRecovery?.busy ? (
            <p role="status">{t("workbench.draftLoading")}</p>
          ) : null)}
      </WorkbenchNotice>
    </section>
  );
}
