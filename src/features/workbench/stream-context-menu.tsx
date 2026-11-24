import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { ChevronRight } from "lucide-react";
import type { Operation, TextEncoding } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import type { HostContextValue } from "@/providers/host-context";
import type { WorkbenchLabels } from "./labels";
import {
  formatStreamCopy,
  STREAM_COPY_FORMATS,
  type StreamCopyFormat,
  type StreamCopySample,
} from "./stream-copy";
import type { StreamHexSelection } from "./stream-hex-selection";
import type { StreamBookmark } from "./stream-location";
import { workbenchStatus } from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";

export type StreamContextSend = {
  scope: string;
  port: string;
  send: (bytes: Uint8Array, signal: AbortSignal) => Promise<Operation>;
  wait: HostContextValue["waitForOperation"];
};

export type StreamContextPoint = {
  anchor?: StreamBookmark;
  bytes?: { range: StreamHexSelection; sample: StreamCopySample };
  text?: string;
};

type ScopedContext = StreamContextPoint & { sendScope?: string };
type Preview = {
  target: StreamContextSend;
  point: NonNullable<StreamContextPoint["bytes"]>;
  anchor?: StreamBookmark;
};

export function StreamContextMenu({
  children,
  viewport,
  labels,
  receiveEncoding,
  sendEncoding,
  sender,
  sourceAvailable,
  read,
  retained,
  onCopyFeedback,
  onBookmark,
  onSplit,
}: {
  children: ReactElement;
  viewport: RefObject<HTMLDivElement | null>;
  labels: WorkbenchLabels;
  receiveEncoding: TextEncoding;
  sendEncoding: TextEncoding;
  sender?: StreamContextSend;
  sourceAvailable: boolean;
  read: (target: EventTarget | null) => StreamContextPoint;
  retained: (range: StreamHexSelection) => StreamCopySample | undefined;
  onCopyFeedback: (message?: string) => void;
  onBookmark: (anchor: StreamBookmark) => void;
  onSplit: (anchor: StreamBookmark) => void;
}) {
  const [context, setContext] = useState<ScopedContext>();
  const [preview, setPreview] = useState<Preview>();
  const openingPreview = useRef(false);
  const copyGeneration = useRef(0);
  const formats = {
    text: labels.copyFormatText,
    hex: "HEX",
    timed: labels.copyFormatTimed,
    c: labels.copyFormatC,
    python: "Python bytes",
    base64: "Base64",
  };

  function exact(point: Preview["point"] | undefined) {
    if (!sourceAvailable || !point) return;
    const sample = retained(point.range);
    if (
      sample &&
      sample.direction === point.sample.direction &&
      sample.offset === point.sample.offset &&
      sample.bytes.length === point.sample.bytes.length &&
      sample.bytes.every((byte, index) => byte === point.sample.bytes[index])
    )
      return sample;
  }

  async function copy(format: StreamCopyFormat) {
    const generation = ++copyGeneration.current;
    const bytes = exact(context?.bytes);
    const output = bytes
      ? formatStreamCopy(
          bytes,
          format,
          bytes.direction === "RX" ? receiveEncoding : sendEncoding,
          "source",
        )
      : sourceAvailable && !context?.bytes && format === "text"
        ? context?.text
        : undefined;
    if (output === undefined) {
      onCopyFeedback(labels.selectionUnavailable);
      return;
    }
    try {
      await copyText(output);
      if (copyGeneration.current === generation)
        onCopyFeedback(labels.copyDone);
    } catch {
      if (copyGeneration.current === generation)
        onCopyFeedback(labels.copyFailed);
    }
  }

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) {
            copyGeneration.current++;
            onCopyFeedback(undefined);
          } else setContext(undefined);
        }}
      >
        <ContextMenuTrigger
          asChild
          onContextMenuCapture={(event) => {
            setContext({ ...read(event.target), sendScope: sender?.scope });
          }}
          onKeyDownCapture={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.repeat
            )
              return;
            if (
              event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10")
            )
              return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            const selected =
              event.currentTarget.ownerDocument.getSelection()?.anchorNode
                ?.parentElement;
            const target =
              selected && event.currentTarget.contains(selected)
                ? selected
                : event.target;
            if (!(target instanceof HTMLElement)) return;
            target.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + Math.min(20, bounds.width / 2),
                clientY: bounds.top + Math.min(20, bounds.height / 2),
              }),
            );
          }}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent
          aria-label={labels.receiveContext}
          className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!openingPreview.current)
              viewport.current?.focus({ preventScroll: true });
            openingPreview.current = false;
          }}
        >
          <ContextMenuSub>
            <ContextMenuSubTrigger
              disabled={!sourceAvailable || (!context?.bytes && !context?.text)}
            >
              {labels.contextCopyAs}{" "}
              <ChevronRight size={14} aria-hidden="true" />
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              {STREAM_COPY_FORMATS.map((format) => (
                <ContextMenuItem
                  key={format}
                  disabled={!context?.bytes && format !== "text"}
                  onSelect={() => void copy(format)}
                >
                  {formats[format]}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            disabled={
              !context?.bytes || !sender || context.sendScope !== sender.scope
            }
            onSelect={() => {
              if (
                !context?.bytes ||
                !sender ||
                context.sendScope !== sender.scope
              )
                return;
              if (!exact(context.bytes)) {
                toast.info(labels.selectionUnavailable);
                return;
              }
              openingPreview.current = true;
              setPreview({
                point: context.bytes,
                anchor: context.anchor,
                target: sender,
              });
            }}
          >
            {labels.contextSend}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!context?.anchor}
            onSelect={() => context?.anchor && onBookmark(context.anchor)}
          >
            {labels.contextBookmark}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!context?.anchor}
            onSelect={() => context?.anchor && onSplit(context.anchor)}
          >
            {labels.contextSplit}
          </ContextMenuItem>
          {!context?.bytes && (
            <p className="max-w-52 px-2 py-1 text-xs text-muted-foreground">
              {labels.contextHexHint}
            </p>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {preview && (
        <SelectionSendDialog
          spec={preview}
          sender={sender}
          labels={labels}
          confirmSource={() => exact(preview.point)}
          onClose={() => setPreview(undefined)}
          restoreFocus={() => viewport.current?.focus({ preventScroll: true })}
        />
      )}
    </>
  );
}

function SelectionSendDialog({
  spec,
  sender,
  labels,
  confirmSource,
  onClose,
  restoreFocus,
}: {
  spec: Preview;
  sender?: StreamContextSend;
  labels: WorkbenchLabels;
  confirmSource: () => StreamCopySample | undefined;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const [result, setResult] = useState<Operation>();
  const [error, setError] = useState<"selection" | "write">();
  const [busy, setBusy] = useState(false);
  const work = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => work.current?.abort(), []);
  const available = sender?.scope === spec.target.scope;
  const receipt =
    result?.result?.kind === "tx" ? result.result.value : undefined;

  async function send() {
    if (!sender || !available || work.current) return;
    const selected = confirmSource();
    if (!selected) {
      setError("selection");
      return;
    }
    const controller = new AbortController();
    work.current = controller;
    setBusy(true);
    try {
      const accepted = await sender.send(selected.bytes, controller.signal);
      if (controller.signal.aborted) return;
      setResult(accepted);
      const settled = await sender.wait(accepted, controller.signal);
      if (!controller.signal.aborted) setResult(settled);
    } catch {
      if (!controller.signal.aborted) setError("write");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="min-w-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{labels.contextSend}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {spec.target.port} · {spec.point.sample.bytes.length} B
            {spec.anchor &&
              " · " + labels.locationEvent + " " + spec.anchor.event}
          </DialogDescription>
        </DialogHeader>
        {available && (
          <pre
            className="max-h-44 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
            data-surface="reading"
            tabIndex={0}
          >
            {formatHex(spec.point.sample.bytes)}
          </pre>
        )}
        {!available && !busy && !result && !error && (
          <p role="alert">{labels.contextSendUnavailable}</p>
        )}
        {busy && <p role="status">{labels.contextSending}</p>}
        {result && (
          <div role="status" className="grid min-w-0 gap-1 wrap-anywhere">
            <p>{workbenchStatus(receipt?.outcome ?? result.state, labels)}</p>
            <code className="text-xs">{result.operationId}</code>
            {receipt && <TxReceiptFacts receipt={receipt} labels={labels} />}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error === "selection"
              ? labels.selectionUnavailable
              : labels.contextSendError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {labels.closeView}
          </Button>
          <Button
            disabled={!available || busy || !!result || error !== undefined}
            onClick={() => void send()}
          >
            {labels.contextSendConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
