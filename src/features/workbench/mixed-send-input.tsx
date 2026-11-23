import { useId, useMemo, useRef, useState } from "react";
import { Binary } from "lucide-react";
import type { TextEncoding } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";
import { useUnsavedWork } from "@/providers/unsaved-work";
import type { WorkbenchLabels } from "./labels";
import { convertMixedSendDraft } from "./mixed-send-draft";
import { SendEscapeError } from "./send-escapes";
import { WorkbenchIconButton } from "./workbench-icon-button";

export function MixedSendInput({
  readDraft,
  encoding,
  disabled,
  labels,
  onApply,
}: {
  readDraft: () => string;
  encoding: TextEncoding;
  disabled: boolean;
  labels: WorkbenchLabels;
  onApply: (hex: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [baseline, setBaseline] = useState("");
  const [draftChanged, setDraftChanged] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useUnsavedWork({
    id,
    label: labels.mixedSendInput,
    dirty: open && source !== baseline,
    retainAfterUnmount: false,
    discard: () => {
      setSource(baseline);
      setOpen(false);
    },
  });
  const preview = useMemo(() => {
    if (!open) return {};
    try {
      return { hex: convertMixedSendDraft(source, encoding) };
    } catch (error) {
      if (error instanceof SendEscapeError) {
        const message =
          error.kind === "limit"
            ? labels.escapedDraftTooLong
            : labels.mixedSendInvalidAt.replace(
                "{position}",
                String(Array.from(source.slice(0, error.start)).length + 1),
              );
        return { message, selection: error };
      }
      return { message: labels.unrepresentableEncoding };
    }
  }, [encoding, labels, open, source]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const draft = readDraft();
          setBaseline(draft);
          setSource(draft);
          setDraftChanged(false);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <WorkbenchIconButton label={labels.mixedSendInput} disabled={disabled}>
          <Binary aria-hidden="true" />
        </WorkbenchIconButton>
      </DialogTrigger>
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{labels.mixedSendInput}</DialogTitle>
          <DialogDescription>{labels.mixedSendSyntax}</DialogDescription>
        </DialogHeader>
        <Textarea
          ref={input}
          aria-label={labels.mixedSendInput}
          aria-invalid={!!preview.message}
          aria-describedby={preview.message ? `${id}-error` : undefined}
          maxLength={CLIENT_DRAFT_MAX_BYTES}
          value={source}
          spellCheck={false}
          onChange={(event) => setSource(event.currentTarget.value)}
        />
        <div>
          <p className="text-sm">{labels.mixedSendPreview}</p>
          <p className="max-h-40 overflow-auto break-all font-mono text-sm">
            {preview.hex}
          </p>
          {preview.message && (
            <div id={`${id}-error`} role="status" className="text-sm">
              {preview.selection ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    const selection = preview.selection;
                    if (!selection) return;
                    input.current?.focus();
                    input.current?.setSelectionRange(
                      selection.start,
                      selection.end,
                    );
                  }}
                >
                  {preview.message}
                </Button>
              ) : (
                preview.message
              )}
            </div>
          )}
        </div>
        {draftChanged && (
          <p role="status" className="text-sm">
            {labels.mixedSendDraftChanged}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{labels.cancel}</Button>
          </DialogClose>
          <Button
            disabled={disabled || !preview.hex || draftChanged}
            onClick={() => {
              if (disabled || !preview.hex) return;
              if (readDraft() !== baseline) {
                setDraftChanged(true);
                return;
              }
              onApply(preview.hex);
              setOpen(false);
            }}
          >
            {labels.mixedSendUseHex}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
