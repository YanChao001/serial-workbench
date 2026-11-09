import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileUp, Send } from "lucide-react";
import type {
  LineEnding,
  Operation,
  SessionSnapshot,
  TerminalSettings,
  TerminalMode,
} from "@serial-workbench/contracts";
import { encodeSend, formatHex, parseHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
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
import { terminalTypographyStyle } from "./stream-presentation";
const SEND_SHORTCUT: Shortcut = {
  key: "Enter",
  primary: true,
  allowInEditable: true,
};
const NO_LINE_ENDING: LineEnding = { kind: "none" };
export type SendPanelProps = {
  /** 只约束发送能力；本地草稿仍可编辑。 */
  readOnly?: boolean;
  draftCaption?: string;
  draftActions?: ReactNode;
  mode?: TerminalMode;
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
};
export function SendPanel({
  readOnly = false,
  draftCaption,
  draftActions,
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
  initialMode = "text",
  mode: controlledMode,
  onSendModeChange,
  terminalSettings,
  presentationLabels,
}: SendPanelProps) {
  const id = useId();
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
  }>({ scope: null, busy: false });
  const currentSend = sendState.scope === sessionScope ? sendState : undefined;
  const busy = currentSend?.busy ?? false;
  const admittedReceipt = currentSend?.receipt;
  const receiptId = admittedReceipt?.operationId;
  const receipt =
    operations.find((operation) => operation.operationId === receiptId) ??
    admittedReceipt;
  const error = currentSend?.error;
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
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
          ? `${labels.status}: ${session.txGate}`
          : permissionAllowed === false
            ? labels.unavailable
            : undefined;
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
      if (isCurrent())
        setSendState({
          scope: sessionScope,
          busy: false,
          receipt: admittedReceipt,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <section
      aria-label={labels.send}
      className="workbench-send"
      data-panel-id="send"
      style={readOnly && draftActions ? { rowGap: "0.25rem" } : undefined}
    >
      <div
        className="workbench-toolbar workbench-compose-toolbar"
        data-surface="transparent"
      >
        <h2>{labels.send}</h2>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={mode}
          aria-label={labels.sendMode}
          onValueChange={(value) => {
            if (value !== "text" && value !== "hex") return;
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
        <span className="workbench-toolbar-spacer" />
        <Button
          size="sm"
          variant="ghost"
          aria-label={labels.sendFile}
          onClick={onSendFile}
          disabled={
            !session || session.state !== "open" || !onSendFile || fileBusy
          }
          title={!onSendFile ? labels.fileUnavailable : undefined}
        >
          <FileUp aria-hidden="true" />
          <span className="workbench-tool-label">{labels.sendFile}</span>
        </Button>
        <output
          aria-label={labels.preview}
          tabIndex={0}
          className="workbench-byte-preview font-mono"
        >
          {formatHex(preview.bytes)}{" "}
          <span className="text-muted-foreground">
            ({preview.bytes.length} {labels.bytes})
          </span>
        </output>
      </div>
      {presentationLabels && ending.kind === "custom" && (
        <label className="workbench-custom-ending">
          {presentationLabels.customLineEndingHex}
          <Input
            value={suffixHex}
            onChange={(event) => setCustomHex(event.target.value)}
            aria-invalid={preview.invalid}
            aria-describedby={preview.invalid ? `${id}-invalid` : undefined}
          />
        </label>
      )}
      {(draftCaption || draftActions) && (
        <div className="flex items-center justify-between gap-2">
          {draftCaption && (
            <p
              id={`${id}-draft-owner`}
              className="text-xs text-muted-foreground"
            >
              {draftCaption}
            </p>
          )}
          {draftActions && (
            <div className="flex items-center gap-2">{draftActions}</div>
          )}
        </div>
      )}
      <div className="workbench-compose-body">
        <label htmlFor={`${id}-draft`} className="sr-only">
          {labels.draft}
        </label>
        <Textarea
          id={`${id}-draft`}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
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
        <Button
          size="sm"
          className="workbench-send-button"
          aria-describedby={disabledReason ? `${id}-send-reason` : undefined}
          onClick={() => void send()}
          disabled={
            disabled || preview.invalid || !preview.bytes.length || busy
          }
        >
          <Send aria-hidden="true" />
          {busy ? labels.sending : labels.send}
        </Button>
      </div>
      <div className="workbench-compose-hint text-muted-foreground">
        <span id={`${id}-send-reason`}>
          {disabledReason ?? `${formatShortcut(SEND_SHORTCUT)} ${labels.send}`}
        </span>
        <span>
          UTF-8 ·{" "}
          {ending.kind === "none"
            ? labels.none
            : ending.kind === "custom"
              ? presentationLabels?.customLineEnding
              : ending.kind.toUpperCase()}
        </span>
      </div>
      {preview.invalid && (
        <p role="alert" id={`${id}-invalid`}>
          {labels.invalidHex}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {receipt && (
        <div
          role="status"
          aria-label={labels.receipt}
          className="workbench-send-receipt"
        >
          <details>
            <summary>
              {labels.receipt}: {receipt.state}
              {receipt?.result?.kind === "tx"
                ? ` · ${receipt.result.value.outcome} [${receipt.result.value.byteStart}, ${receipt.result.value.byteEnd})`
                : ""}
            </summary>
            <p className="font-mono">{receiptId}</p>
          </details>
        </div>
      )}
    </section>
  );
}
