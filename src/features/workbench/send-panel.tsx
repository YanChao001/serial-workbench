import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Code2,
  Eraser,
  FileUp,
  Send,
  Save,
  Settings2,
  ReceiptText,
} from "lucide-react";
import type {
  LineEnding,
  Operation,
  SessionSnapshot,
  TerminalSettings,
  TerminalMode,
  TextEncoding,
} from "@serial-workbench/contracts";
import { TX_MAX_BYTES } from "@serial-workbench/contracts";
import {
  encodeSend,
  formatHex,
  HexInputError,
  parseHex,
} from "@serial-workbench/host-client";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { useComposerToastOffset } from "./use-composer-toast-offset";
import {
  operationFailureEventKey,
  operationFailureKey,
  WorkbenchNotice,
} from "./workbench-notice";
import { nativeErrorCode } from "@/lib/native-error";
import { formatByteSize } from "./metric-format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatShortcut,
  matchesShortcut,
  SEND_EDITOR_SHORTCUT,
} from "@/commands/shortcuts";
import type { WorkbenchLabels } from "./labels";
import {
  terminalTypographyStyle,
  workbenchStatus,
} from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";
import {
  appendSendChecksum,
  DEFAULT_SEND_CHECKSUM,
  type SendChecksum,
} from "./send-checksum";
import { SendChecksumSettings } from "./send-checksum-settings";
import { convertSendDraft } from "./send-draft-conversion";
import { expandSendEscapes, SendEscapeError } from "./send-escapes";
import { MixedSendInput } from "./mixed-send-input";
import { SendDraftEditor } from "./send-draft-editor";
import { TextEncodingSelect } from "./text-encoding-select";
import {
  createTextSendPreview,
  encodeTextSend,
  TextEncodingError,
  type TextSendPreview,
} from "@/lib/text-encoding";
import { useTextEncoding } from "@/hooks/use-text-encoding";
const NO_LINE_ENDING: LineEnding = { kind: "none" };
function sameReceiptIdentity(value: Operation, admitted: Operation): boolean {
  return (
    value.operationId === admitted.operationId &&
    value.executionHostId === admitted.executionHostId &&
    value.actionId === admitted.actionId &&
    value.target.hostId === admitted.target.hostId &&
    value.target.kind === admitted.target.kind &&
    value.target.id === admitted.target.id &&
    value.target.sessionId === admitted.target.sessionId &&
    value.target.sessionEpoch === admitted.target.sessionEpoch
  );
}
export type SendPanelProps = {
  /** 只约束发送能力；本地草稿仍可编辑。 */
  readOnly?: boolean;
  /** 本地草稿尚未恢复时锁定编辑及变换，不影响离线草稿的正常编辑能力。 */
  draftReadOnly?: boolean;
  draftCaption?: string;
  draftActions?: ReactNode;
  onSaveDrafts?: () => void;
  draftsDirty?: boolean;
  mode?: TerminalMode;
  /** 与同一事件中的 onDraftChange 一并提交转换后的模式与正文。 */
  onSendModeChange?: (mode: TerminalMode) => void;
  encoding?: TextEncoding;
  onEncodingChange?: (encoding: TextEncoding) => void;
  terminalSettings?: TerminalSettings;
  presentationLabels?: {
    customLineEnding: string;
    customLineEndingHex: string;
  };
  initialMode?: "text" | "hex";
  session?: SessionSnapshot;
  draft: string;
  checksumDraftKey?: string;
  onDraftChange: (value: string) => void;
  labels: WorkbenchLabels;
  onSend: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Operation>;
  /** 最终发送字节的不可变快照，非法输入和卸载时为 null。 */
  onPreviewChange?: (preview: TextSendPreview | null) => void;
  permissionAllowed?: boolean;
  onSendFile?: () => void;
  onOpenTransfer?: () => void;
  transferLabel?: string;
  fileBusy?: boolean;
  operations?: readonly Operation[];
  formatError?: (error: { code?: string }) => string;
  deviceName?: string;
  disconnectedReason?: string;
};
export function SendPanel({
  readOnly = false,
  draftReadOnly = false,
  draftCaption,
  draftActions,
  onSaveDrafts,
  draftsDirty = false,
  session,
  draft,
  checksumDraftKey,
  onDraftChange,
  labels,
  onSend,
  onPreviewChange,
  permissionAllowed,
  onSendFile,
  onOpenTransfer,
  transferLabel,
  fileBusy = false,
  operations = [],
  formatError,
  deviceName,
  disconnectedReason,
  initialMode = "text",
  mode: controlledMode,
  onSendModeChange,
  encoding: controlledEncoding,
  onEncodingChange,
  terminalSettings,
  presentationLabels,
}: SendPanelProps) {
  const composer = useComposerToastOffset();
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const id = useId();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [conversionError, setConversionError] = useState<
    "INVALID_HEX" | "INVALID_UTF8" | "INVALID_ENCODING" | "UNREPRESENTABLE"
  >();
  const [escapeError, setEscapeError] = useState<SendEscapeError>();
  const [localMode, setMode] = useState<TerminalMode | null>(null);
  const mode =
    controlledMode ?? localMode ?? terminalSettings?.sendMode ?? initialMode;
  const [localEncoding, setEncoding] = useState<TextEncoding>();
  const encoding =
    controlledEncoding ??
    localEncoding ??
    terminalSettings?.sendEncoding ??
    "utf-8";
  const encodingStatus = useTextEncoding(encoding);
  const [localEnding, setEnding] = useState<LineEnding | null>(null);
  const ending = localEnding ?? terminalSettings?.lineEnding ?? NO_LINE_ENDING;
  const [customHex, setCustomHex] = useState<string | null>(null);
  const suffixHex =
    customHex ??
    (ending.kind === "custom" ? formatHex(encodeSend("", "text", ending)) : "");
  const sessionScope = session
    ? JSON.stringify([session.sessionId, session.sessionEpoch])
    : null;
  const checksumOwner = JSON.stringify([checksumDraftKey, sessionScope]);
  const [checksumState, setChecksumState] = useState({
    owner: checksumOwner,
    value: DEFAULT_SEND_CHECKSUM,
  });
  const checksum =
    checksumState.owner === checksumOwner
      ? checksumState.value
      : DEFAULT_SEND_CHECKSUM;
  if (checksumState.owner !== checksumOwner)
    setChecksumState({ owner: checksumOwner, value: DEFAULT_SEND_CHECKSUM });
  const [sendState, setSendState] = useState<{
    scope: string | null;
    busy: boolean;
    receipt?: Operation;
    error?: string;
    errorCode?: string;
    errorEventKey?: string;
  }>({ scope: null, busy: false });
  const currentSend = sendState.scope === sessionScope ? sendState : undefined;
  const busy = currentSend?.busy ?? false;
  const admittedReceipt = currentSend?.receipt;
  const receiptId = admittedReceipt?.operationId;
  const receipt =
    operations.find(
      (operation) =>
        admittedReceipt && sameReceiptIdentity(operation, admittedReceipt),
    ) ?? admittedReceipt;
  const error = currentSend?.error;
  const errorCode =
    error !== undefined
      ? currentSend?.errorCode
      : (receipt?.error?.code ??
        (receipt?.result?.kind === "tx"
          ? receipt.result.value.backendError?.code
          : undefined));
  const outcome =
    receipt?.result?.kind === "tx"
      ? receipt.result.value.outcome
      : receipt?.state === "failed"
        ? "rejected"
        : receipt?.state === "unknown"
          ? "unknown"
          : undefined;
  const receiptFault =
    !busy &&
    receipt &&
    receipt.state !== "queued" &&
    receipt.state !== "running" &&
    receipt.state !== "cancel_requested" &&
    outcome &&
    (outcome === "partial" || outcome === "unknown" || outcome === "rejected")
      ? errorCode && formatError
        ? formatError({ code: errorCode })
        : `${labels.send}: ${workbenchStatus(outcome, labels)}`
      : undefined;
  const noticeMessage = error ?? receiptFault;
  const noticeEventKey = error
    ? currentSend?.errorEventKey
    : receiptFault && receipt
      ? operationFailureKey(receipt)
      : undefined;
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setReceiptOpen(false);
    setConversionError(undefined);
    setEscapeError(undefined);
    setSendState((current) =>
      current.scope === sessionScope
        ? current
        : { scope: sessionScope, busy: false },
    );
    return () => {
      // 结束旧会话代次的等待；Host 已提交操作仍由真实回执决定结果。
      pending.current?.abort();
      pending.current = null;
    };
  }, [sessionScope]);
  const endingKind = ending.kind;
  const customSuffixHex = endingKind === "custom" ? suffixHex : "";
  const preview = useMemo<{
    prepared?: TextSendPreview;
    invalid: boolean;
    reason?: "unrepresentable" | "loading" | "hex" | "limit" | "checksum";
    checksumHex?: string;
    hexIssue?: { field: "draft" | "ending"; start: number; end: number };
  }>(() => {
    let field: "draft" | "ending" = "ending";
    try {
      if (mode !== "hex" && encodingStatus !== "ready")
        return { invalid: true, reason: "loading" };
      const suffix: LineEnding =
        endingKind === "custom"
          ? {
              kind: "custom",
              bytesBase64: btoa(
                Array.from(parseHex(customSuffixHex), (byte) =>
                  String.fromCharCode(byte),
                ).join(""),
              ),
            }
          : { kind: endingKind };
      field = "draft";
      let prepared = createTextSendPreview(draft, mode, suffix, encoding);
      let checksumHex: string | undefined;
      if (checksum.algorithm !== "none") {
        const bytes = prepared.readBytes();
        const endingLength = encodeTextSend("", mode, suffix, encoding).length;
        const checked = appendSendChecksum(bytes, bytes.length - endingLength, {
          ...checksum,
          algorithm: checksum.algorithm,
        });
        if (!checked) return { invalid: true, reason: "checksum" };
        checksumHex = formatHex(checked.checksum);
        prepared = Object.freeze({
          byteLength: checked.bytes.length,
          readBytes: () => checked.bytes.slice(),
        });
      }
      return {
        prepared,
        checksumHex,
        invalid: prepared.byteLength > TX_MAX_BYTES,
        reason: prepared.byteLength > TX_MAX_BYTES ? "limit" : undefined,
      };
    } catch (error) {
      return {
        invalid: true,
        reason: error instanceof TextEncodingError ? error.code : "hex",
        hexIssue:
          error instanceof HexInputError
            ? { field, start: error.start, end: error.end }
            : undefined,
      };
    }
  }, [
    draft,
    mode,
    endingKind,
    customSuffixHex,
    encoding,
    encodingStatus,
    checksum,
  ]);
  const hexIssue = preview.hexIssue;
  const hexPosition = hexIssue
    ? Array.from(
        (hexIssue.field === "draft" ? draft : customSuffixHex).slice(
          0,
          hexIssue.start,
        ),
      ).length + 1
    : undefined;
  const previewError =
    preview.reason === "limit"
      ? labels.sendLimit.replace(
          "{limit}",
          formatByteSize(String(TX_MAX_BYTES)),
        )
      : preview.reason === "checksum"
        ? labels.checksumInvalidRange
        : preview.reason === "loading"
          ? encodingStatus === "error"
            ? labels.encodingLoadFailed
            : labels.encodingLoading
          : preview.reason === "unrepresentable"
            ? labels.unrepresentableEncoding
            : hexPosition === undefined
              ? labels.invalidHex
              : (hexIssue?.field === "ending"
                  ? labels.invalidHexEndingAt
                  : labels.invalidHexDraftAt
                ).replace("{position}", String(hexPosition));
  const conversionMessage =
    conversionError === "INVALID_HEX"
      ? labels.invalidHex
      : conversionError === "UNREPRESENTABLE"
        ? labels.unrepresentableEncoding
        : conversionError === "INVALID_ENCODING"
          ? labels.invalidEncoding
          : labels.invalidUtf8;
  const previewCallback = useRef(onPreviewChange);
  useEffect(() => {
    previewCallback.current = onPreviewChange;
  }, [onPreviewChange]);
  useEffect(() => {
    previewCallback.current?.(
      preview.invalid ? null : (preview.prepared ?? null),
    );
  }, [preview]);
  useEffect(() => () => previewCallback.current?.(null), []);
  const disabled =
    draftReadOnly ||
    readOnly ||
    permissionAllowed === false ||
    !session ||
    session.readOnly ||
    session.state !== "open" ||
    session.txGate !== "ready";
  const disabledReason = draftReadOnly
    ? labels.unavailable
    : readOnly
      ? labels.readOnly
      : !session || session.state !== "open"
        ? (disconnectedReason ?? labels.disconnected)
        : session.readOnly
          ? labels.readOnly
          : session.txGate !== "ready"
            ? workbenchStatus(session.txGate, labels)
            : permissionAllowed === false &&
                (preview.prepared?.byteLength ?? 0) > 0
              ? labels.sendNotAllowed
              : undefined;
  const sendHint =
    disabledReason ??
    (preview.invalid
      ? previewError
      : busy
        ? labels.sending
        : !preview.prepared?.byteLength
          ? labels.emptyDraft
          : `${formatShortcut(SEND_EDITOR_SHORTCUT)} ${labels.send}`);
  async function send() {
    const prepared = preview.prepared;
    if (disabled || preview.invalid || busy || !prepared?.byteLength) return;
    const controller = new AbortController();
    pending.current = controller;
    setSendState({ scope: sessionScope, busy: true, receipt: admittedReceipt });
    const isCurrent = () =>
      !controller.signal.aborted && pending.current === controller;
    try {
      const result = await onSend(prepared.readBytes(), controller.signal);
      if (isCurrent())
        setSendState({ scope: sessionScope, busy: false, receipt: result });
    } catch (reason) {
      const code = nativeErrorCode(reason);
      if (isCurrent())
        setSendState({
          scope: sessionScope,
          busy: false,
          receipt: admittedReceipt,
          error: formatError?.({ code }) ?? `${labels.send}: ${labels.failed}`,
          errorCode: code,
          errorEventKey: operationFailureEventKey(reason),
        });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  const emptyDraft = draft.length === 0;
  const invalidChecksum = preview.reason === "checksum";
  const toolbar = useMemo(
    () => (
      <div
        className="workbench-toolbar workbench-compose-toolbar"
        data-surface="transparent"
      >
        <h2 className="sr-only">{labels.send}</h2>
        <ToggleGroup
          disabled={draftReadOnly}
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={mode}
          aria-label={labels.sendMode}
          onValueChange={(value) => {
            if (value !== "text" && value !== "hex") return;
            if (value === mode) return;
            const converted = convertSendDraft(
              currentDraft.current,
              mode,
              value,
              encoding,
            );
            if (!converted.ok) {
              setConversionError(converted.code);
              return;
            }
            setConversionError(undefined);
            setEscapeError(undefined);
            onDraftChange(converted.draft);
            setMode(value);
            onSendModeChange?.(value);
          }}
        >
          {(["text", "hex"] as const).map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              disabled={
                mode === "text" && value !== mode && encodingStatus !== "ready"
              }
            >
              {labels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <TextEncodingSelect
          disabled={draftReadOnly}
          value={encoding}
          label={labels.sendEncoding}
          onChange={(value) => {
            if (!value) return;
            setEncoding(value);
            setConversionError(undefined);
            setEscapeError(undefined);
            onEncodingChange?.(value);
          }}
        />
        {mode === "text" && (
          <WorkbenchIconButton
            label={labels.expandSendEscapes}
            disabled={draftReadOnly || emptyDraft || encodingStatus !== "ready"}
            onClick={() => {
              setEscapeError(undefined);
              setConversionError(undefined);
              const original = currentDraft.current;
              try {
                const hex = expandSendEscapes(original, encoding);
                onDraftChange(hex);
                setMode("hex");
                onSendModeChange?.("hex");
                draftInput.current?.focus();
              } catch (error) {
                if (!(error instanceof SendEscapeError)) {
                  setConversionError("UNREPRESENTABLE");
                  return;
                }
                setEscapeError(error);
                const input = draftInput.current;
                if (input) {
                  input.focus();
                  input.setSelectionRange(error.start, error.end);
                }
              }
            }}
          >
            <Code2 aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        <MixedSendInput
          key={`mixed-${checksumDraftKey ?? ""}`}
          readDraft={() => currentDraft.current}
          encoding={encoding}
          disabled={draftReadOnly === true || encodingStatus !== "ready"}
          labels={labels}
          onApply={(hex) => {
            setConversionError(undefined);
            setEscapeError(undefined);
            onDraftChange(hex);
            setMode("hex");
            onSendModeChange?.("hex");
          }}
        />
        <Select
          disabled={draftReadOnly}
          value={ending.kind}
          onValueChange={(kind) => {
            if (
              kind === "none" ||
              kind === "cr" ||
              kind === "lf" ||
              kind === "crlf"
            )
              setEnding({ kind });
            else if (kind === "custom")
              setEnding({ kind: "custom", bytesBase64: "" });
          }}
        >
          <SelectTrigger size="sm" aria-label={labels.lineEnding}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["none", "cr", "lf", "crlf"] as const).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind === "none" ? labels.none : kind.toUpperCase()}
              </SelectItem>
            ))}
            {presentationLabels && (
              <SelectItem value="custom">
                {presentationLabels.customLineEnding}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {presentationLabels && ending.kind === "custom" && (
          <Popover>
            <PopoverTrigger asChild>
              <WorkbenchIconButton
                label={presentationLabels.customLineEnding}
                disabled={draftReadOnly}
              >
                <Settings2 aria-hidden="true" />
              </WorkbenchIconButton>
            </PopoverTrigger>
            <PopoverContent
              aria-label={presentationLabels.customLineEnding}
              className="workbench-detail-popover"
              side="top"
              align="start"
            >
              <label className="workbench-custom-ending">
                {presentationLabels.customLineEndingHex}
                <Input
                  disabled={draftReadOnly}
                  value={suffixHex}
                  onChange={(event) => setCustomHex(event.target.value)}
                  aria-invalid={hexIssue?.field === "ending"}
                  aria-describedby={
                    hexIssue?.field === "ending" ? `${id}-invalid` : undefined
                  }
                  onKeyDown={(event) => {
                    if (
                      hexIssue?.field === "ending" &&
                      matchesShortcut(event.nativeEvent, SEND_EDITOR_SHORTCUT)
                    ) {
                      event.preventDefault();
                      event.currentTarget.setSelectionRange(
                        hexIssue.start,
                        hexIssue.end,
                      );
                    }
                  }}
                />
              </label>
            </PopoverContent>
          </Popover>
        )}
        <SendChecksumSettings
          key={checksumOwner}
          value={checksum}
          disabled={draftReadOnly}
          checksumHex={preview.checksumHex}
          invalid={invalidChecksum}
          labels={labels}
          onChange={(value: SendChecksum) =>
            setChecksumState({ owner: checksumOwner, value })
          }
        />
        <span className="workbench-toolbar-spacer" />
        {draftActions}
        {onSaveDrafts && (
          <WorkbenchIconButton
            label={labels.saveDrafts}
            disabled={draftReadOnly || !draftsDirty}
            onClick={onSaveDrafts}
          >
            <Save aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        <Popover open={receiptOpen} onOpenChange={setReceiptOpen}>
          <PopoverTrigger asChild>
            <WorkbenchIconButton label={labels.receipt} disabled={!receipt}>
              <ReceiptText aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          {receipt && (
            <PopoverContent
              aria-label={labels.receipt}
              className="workbench-detail-popover workbench-send-receipt"
              side="top"
              align="end"
            >
              <div role="status" aria-label={labels.receipt}>
                <p>{workbenchStatus(receipt.state, labels)}</p>
                <p className="font-mono">{receiptId}</p>
                {receipt.result?.kind === "tx" && (
                  <TxReceiptFacts
                    receipt={receipt.result.value}
                    labels={labels}
                  />
                )}
              </div>
            </PopoverContent>
          )}
        </Popover>
        {onOpenTransfer && (
          <WorkbenchIconButton
            label={transferLabel ?? labels.sendFile}
            onClick={onOpenTransfer}
            disabled={
              draftReadOnly ||
              !session ||
              session.state !== "open" ||
              readOnly ||
              fileBusy
            }
          >
            <Settings2 aria-hidden="true" />
          </WorkbenchIconButton>
        )}
        <WorkbenchIconButton
          label={labels.sendFile}
          onClick={onSendFile}
          disabled={
            draftReadOnly ||
            !session ||
            session.state !== "open" ||
            !onSendFile ||
            fileBusy
          }
          tooltip={!onSendFile ? labels.fileUnavailable : labels.sendFile}
        >
          <FileUp aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={labels.clearDraft}
          disabled={draftReadOnly || emptyDraft}
          onClick={() => {
            setConversionError(undefined);
            setEscapeError(undefined);
            onDraftChange("");
            draftInput.current?.focus();
          }}
        >
          <Eraser aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
    ),
    [
      id,
      mode,
      encodingStatus,
      encoding,
      onDraftChange,
      onSendModeChange,
      onEncodingChange,
      ending.kind,
      suffixHex,
      presentationLabels,
      hexIssue,
      draftActions,
      onSaveDrafts,
      draftsDirty,
      receiptOpen,
      receipt,
      receiptId,
      labels,
      onOpenTransfer,
      transferLabel,
      session,
      readOnly,
      draftReadOnly,
      fileBusy,
      onSendFile,
      emptyDraft,
      checksumDraftKey,
      checksumOwner,
      checksum,
      preview.checksumHex,
      invalidChecksum,
    ],
  );
  return (
    <section
      ref={composer}
      aria-label={labels.send}
      className="workbench-send"
      data-panel-id="send"
    >
      {toolbar}
      <span role="status" className="sr-only">
        {receipt
          ? `${labels.receipt}: ${workbenchStatus(receipt.state, labels)}`
          : ""}
      </span>
      {draftCaption && (
        <span id={`${id}-draft-owner`} className="sr-only">
          {draftCaption}
        </span>
      )}
      <div className="workbench-compose-body">
        <label htmlFor={`${id}-draft`} className="sr-only">
          {labels.draft}
        </label>
        <div
          className="workbench-draft-frame"
          data-surface="reading"
          data-invalid={preview.invalid || undefined}
        >
          <SendDraftEditor
            grammar={mode === "hex" ? "hex" : "text"}
            value={draft}
            readOnly={draftReadOnly}
            ref={draftInput}
            id={`${id}-draft`}
            spellCheck={false}
            data-surface="transparent"
            onValueChange={(value) => {
              if (draftReadOnly) return;
              setConversionError(undefined);
              setEscapeError(undefined);
              onDraftChange(value);
            }}
            aria-invalid={
              (preview.invalid &&
                !invalidChecksum &&
                hexIssue?.field !== "ending") ||
              !!escapeError
            }
            aria-describedby={
              [
                draftCaption ? `${id}-draft-owner` : undefined,
                preview.invalid &&
                !invalidChecksum &&
                hexIssue?.field !== "ending"
                  ? `${id}-invalid`
                  : undefined,
                escapeError ? `${id}-escape` : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            className="workbench-draft font-mono"
            style={terminalTypographyStyle(terminalSettings?.typography)}
            rows={3}
            onKeyDown={(event) => {
              if (matchesShortcut(event.nativeEvent, SEND_EDITOR_SHORTCUT)) {
                event.preventDefault();
                if (hexIssue?.field === "draft") {
                  event.currentTarget.setSelectionRange(
                    hexIssue.start,
                    hexIssue.end,
                  );
                  return;
                }
                void send();
              }
            }}
          />
          <span
            role="note"
            className="workbench-draft-bytes"
            aria-label={labels.draftByteCount}
          >
            {preview.invalid && preview.reason !== "limit"
              ? "—"
              : formatByteSize(String(preview.prepared?.byteLength ?? 0))}
          </span>
        </div>
        <WorkbenchIconButton
          label={busy ? labels.sending : labels.send}
          tooltip={sendHint}
          variant="default"
          className="workbench-send-button"
          aria-describedby={`${id}-send-reason`}
          onClick={() => void send()}
          disabled={
            disabled || preview.invalid || !preview.prepared?.byteLength || busy
          }
        >
          <Send aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
      {preview.invalid && (
        <p
          id={`${id}-invalid`}
          className={hexIssue ? "text-xs text-destructive" : "sr-only"}
        >
          {previewError}
        </p>
      )}
      <div className="sr-only">
        <span id={`${id}-send-reason`}>{sendHint}</span>
      </div>
      <WorkbenchNotice
        noticeKey={`draft-validation:${encoding}:${preview.reason ?? "none"}:${encodingStatus}`}
      >
        {invalidChecksum ||
        preview.reason === "limit" ||
        preview.reason === "unrepresentable" ||
        (preview.reason === "loading" && encodingStatus === "error") ? (
          <p role="alert">{previewError}</p>
        ) : null}
      </WorkbenchNotice>
      <WorkbenchNotice
        noticeKey={`draft-escape:${escapeError?.kind ?? "none"}:${escapeError?.start ?? ""}`}
      >
        {escapeError && (
          <p id={`${id}-escape`} role="alert">
            {escapeError.kind === "limit"
              ? labels.escapedDraftTooLong
              : labels.invalidSendEscape}
          </p>
        )}
      </WorkbenchNotice>
      <WorkbenchNotice
        noticeKey={`draft-conversion:${conversionError ?? "none"}`}
        log={
          conversionError
            ? {
                module: "serial",
                level: "error",
                code: conversionError,
                message: conversionMessage,
              }
            : undefined
        }
      >
        {conversionError ? <p role="alert">{conversionMessage}</p> : null}
      </WorkbenchNotice>
      <WorkbenchNotice
        eventKey={noticeEventKey}
        noticeKey={
          error
            ? `send:${sessionScope}:${errorCode}:${error}`
            : `receipt:${receiptId}:${receipt?.revision}`
        }
        log={
          noticeMessage
            ? {
                module: "serial",
                level:
                  error === undefined &&
                  (outcome === "partial" || outcome === "unknown")
                    ? "warning"
                    : "error",
                message: noticeMessage,
                code: errorCode,
                context: deviceName,
              }
            : undefined
        }
      >
        {noticeMessage && <p role="alert">{noticeMessage}</p>}
      </WorkbenchNotice>
    </section>
  );
}
