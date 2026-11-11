import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileUp, Send, Save, Settings2, ReceiptText } from "lucide-react";
import type {
  LineEnding,
  Operation,
  SessionSnapshot,
  TerminalSettings,
  TerminalMode,
} from "@serial-workbench/contracts";
import { encodeSend, formatHex, parseHex } from "@serial-workbench/host-client";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { useComposerToastOffset } from "./use-composer-toast-offset";
import {
  operationFailureEventKey,
  operationFailureKey,
  WorkbenchNotice,
} from "./workbench-notice";
import { nativeErrorCode } from "@/lib/native-error";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  type Shortcut,
} from "@/commands/shortcuts";
import type { WorkbenchLabels } from "./labels";
import {
  terminalTypographyStyle,
  workbenchStatus,
} from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";
import { convertSendDraft } from "./send-draft-conversion";
const SEND_SHORTCUT: Shortcut = {
  key: "Enter",
  primary: true,
  allowInEditable: true,
};
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
  draftCaption?: string;
  draftActions?: ReactNode;
  onSaveDrafts?: () => void;
  draftsDirty?: boolean;
  mode?: TerminalMode;
  /** 与同一事件中的 onDraftChange 一并提交转换后的模式与正文。 */
  onSendModeChange?: (mode: TerminalMode) => void;
  terminalSettings?: TerminalSettings;
  presentationLabels?: {
    customLineEnding: string;
    customLineEndingHex: string;
  };
  initialMode?: "text" | "hex";
  session?: SessionSnapshot;
  draft: string;
  onDraftChange: (value: string) => void;
  labels: WorkbenchLabels;
  onSend: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Operation>;
  /** 最终编码与行尾后的字节副本；非法输入和卸载时为 null。 */
  onPreviewChange?: (bytes: Uint8Array | null) => void;
  permissionAllowed?: boolean;
  onSendFile?: () => void;
  fileBusy?: boolean;
  operations?: readonly Operation[];
  formatError?: (error: { code?: string }) => string;
  deviceName?: string;
};
export function SendPanel({
  readOnly = false,
  draftCaption,
  draftActions,
  onSaveDrafts,
  draftsDirty = false,
  session,
  draft,
  onDraftChange,
  labels,
  onSend,
  onPreviewChange,
  permissionAllowed,
  onSendFile,
  fileBusy = false,
  operations = [],
  formatError,
  deviceName,
  initialMode = "text",
  mode: controlledMode,
  onSendModeChange,
  terminalSettings,
  presentationLabels,
}: SendPanelProps) {
  const composer = useComposerToastOffset();
  const id = useId();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [conversionError, setConversionError] = useState<
    "INVALID_HEX" | "INVALID_UTF8"
  >();
  const [localMode, setMode] = useState<TerminalMode | null>(null);
  const mode =
    controlledMode ?? localMode ?? terminalSettings?.sendMode ?? initialMode;
  const [localEnding, setEnding] = useState<LineEnding | null>(null);
  const ending = localEnding ?? terminalSettings?.lineEnding ?? NO_LINE_ENDING;
  const [customHex, setCustomHex] = useState<string | null>(null);
  const suffixHex =
    customHex ??
    (ending.kind === "custom" ? formatHex(encodeSend("", "text", ending)) : "");
  const sessionScope = session
    ? JSON.stringify([session.sessionId, session.sessionEpoch])
    : null;
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
  const preview = useMemo(() => {
    try {
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
      return { bytes: encodeSend(draft, mode, suffix), invalid: false };
    } catch {
      return { bytes: new Uint8Array(), invalid: true };
    }
  }, [draft, mode, endingKind, customSuffixHex]);
  const previewCallback = useRef(onPreviewChange);
  useEffect(() => {
    previewCallback.current = onPreviewChange;
  }, [onPreviewChange]);
  useEffect(() => {
    previewCallback.current?.(preview.invalid ? null : preview.bytes.slice());
  }, [preview]);
  useEffect(() => () => previewCallback.current?.(null), []);
  const disabled =
    readOnly ||
    permissionAllowed === false ||
    !session ||
    session.readOnly ||
    session.state !== "open" ||
    session.txGate !== "ready";
  const disabledReason = readOnly
    ? labels.readOnly
    : !session || session.state !== "open"
      ? labels.disconnected
      : session.readOnly
        ? labels.readOnly
        : session.txGate !== "ready"
          ? workbenchStatus(session.txGate, labels)
          : permissionAllowed === false && preview.bytes.length > 0
            ? labels.sendNotAllowed
            : undefined;
  const sendHint =
    disabledReason ??
    (preview.invalid
      ? labels.invalidHex
      : busy
        ? labels.sending
        : !preview.bytes.length
          ? labels.emptyDraft
          : `${formatShortcut(SEND_SHORTCUT)} ${labels.send}`);
  async function send() {
    if (disabled || preview.invalid || busy || !preview.bytes.length) return;
    const controller = new AbortController();
    pending.current = controller;
    setSendState({ scope: sessionScope, busy: true, receipt: admittedReceipt });
    const isCurrent = () =>
      !controller.signal.aborted && pending.current === controller;
    try {
      const result = await onSend(preview.bytes, controller.signal);
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
  return (
    <section
      ref={composer}
      aria-label={labels.send}
      className="workbench-send"
      data-panel-id="send"
    >
      <div
        className="workbench-toolbar workbench-compose-toolbar"
        data-surface="transparent"
      >
        <h2 className="sr-only">{labels.send}</h2>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={mode}
          aria-label={labels.sendMode}
          onValueChange={(value) => {
            if (value !== "text" && value !== "hex") return;
            if (value === mode) return;
            const converted = convertSendDraft(draft, mode, value);
            if (!converted.ok) {
              setConversionError(converted.code);
              return;
            }
            setConversionError(undefined);
            onDraftChange(converted.draft);
            setMode(value);
            onSendModeChange?.(value);
          }}
        >
          {(["text", "hex"] as const).map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {labels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select
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
              <WorkbenchIconButton label={presentationLabels.customLineEnding}>
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
                  value={suffixHex}
                  onChange={(event) => setCustomHex(event.target.value)}
                  aria-invalid={preview.invalid}
                  aria-describedby={
                    preview.invalid ? `${id}-invalid` : undefined
                  }
                />
              </label>
            </PopoverContent>
          </Popover>
        )}
        <span className="workbench-toolbar-spacer" />
        {draftActions}
        {onSaveDrafts && (
          <WorkbenchIconButton
            label={labels.saveDrafts}
            disabled={!draftsDirty}
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
        <WorkbenchIconButton
          label={labels.sendFile}
          onClick={onSendFile}
          disabled={
            !session || session.state !== "open" || !onSendFile || fileBusy
          }
          tooltip={!onSendFile ? labels.fileUnavailable : labels.sendFile}
        >
          <FileUp aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
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
          data-surface="control"
          data-invalid={preview.invalid || undefined}
        >
          <Textarea
            id={`${id}-draft`}
            spellCheck={false}
            data-surface="transparent"
            value={draft}
            onChange={(event) => {
              setConversionError(undefined);
              onDraftChange(event.target.value);
            }}
            aria-invalid={preview.invalid}
            aria-describedby={
              [
                draftCaption ? `${id}-draft-owner` : undefined,
                preview.invalid ? `${id}-invalid` : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            className="workbench-draft font-mono"
            style={terminalTypographyStyle(terminalSettings?.typography)}
            rows={3}
            onKeyDown={(event) => {
              if (matchesShortcut(event.nativeEvent, SEND_SHORTCUT)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <span
            role="note"
            className="workbench-draft-bytes"
            aria-label={labels.draftByteCount}
          >
            {preview.invalid ? "—" : preview.bytes.length} {labels.bytes}
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
            disabled || preview.invalid || !preview.bytes.length || busy
          }
        >
          <Send aria-hidden="true" />
        </WorkbenchIconButton>
        {preview.invalid && (
          <span id={`${id}-invalid`} className="sr-only">
            {labels.invalidHex}
          </span>
        )}
      </div>
      <div className="sr-only">
        <span id={`${id}-send-reason`}>{sendHint}</span>
      </div>
      <WorkbenchNotice
        noticeKey={`draft-conversion:${conversionError ?? "none"}`}
        log={
          conversionError
            ? {
                module: "serial",
                level: "error",
                code: conversionError,
                message:
                  conversionError === "INVALID_HEX"
                    ? labels.invalidHex
                    : labels.invalidUtf8,
              }
            : undefined
        }
      >
        {conversionError ? (
          <p role="alert">
            {conversionError === "INVALID_HEX"
              ? labels.invalidHex
              : labels.invalidUtf8}
          </p>
        ) : null}
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
