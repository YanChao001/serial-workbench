import { useRef, useState, type RefObject } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/zh-CN";
import { readVerifiedFile } from "@/lib/host-reader";
import { nativeErrorText } from "@/lib/native-error";
import type { SelectedFileResource } from "@/lib/tauri";
import { parseU64 } from "@/lib/u64";
import type { CommandBodyFileAccess } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useToolAction } from "./transfer-capture-actions";
import { useTransferFileDrop } from "./use-transfer-file-drop";
import { useBrowserFileDrop } from "./use-browser-file-drop";

export const COMMAND_BODY_MAX_BYTES = 65_536;
const FILE_MAX_BYTES = Math.floor((COMMAND_BODY_MAX_BYTES + 1) / 3);
const PREVIEW_HEX_LENGTH = 3 * 12 - 1;

class BodyFileError extends Error {
  constructor(readonly key: MessageKey) {
    super(key);
  }
}

type FilePreview = { name: string; size: string; hex: string };

export function CommandBodyFile({
  access,
  owner,
  zone,
  fieldId,
  hasBody,
  disabled,
  onApply,
}: {
  access: CommandBodyFileAccess;
  owner: AbortSignal;
  zone: RefObject<HTMLDivElement | null>;
  fieldId: string;
  hasBody: boolean;
  disabled: boolean;
  onApply(hex: string): void;
}) {
  const { language, t } = useI18n();
  const [preview, setPreview] = useState<FilePreview>();
  const choose = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useToolAction((error) =>
    error instanceof BodyFileError
      ? t(error.key, { limit: FILE_MAX_BYTES.toLocaleString(language) })
      : nativeErrorText(error, t),
  );
  const locked = disabled || action.busy || owner.aborted;
  const native = access.kind === "native" ? access : undefined;
  function select(
    pick: (signal: AbortSignal) => Promise<SelectedFileResource | File | null>,
  ) {
    if (locked) return;
    void action.run(async (waiting) => {
      const signal = AbortSignal.any([waiting, owner]);
      const file = await pick(signal);
      if (!file || signal.aborted) return;
      setPreview(undefined);
      const length = "reference" in file ? file.length : String(file.size);
      const size = parseU64(length);
      if (size === 0n) throw new BodyFileError("commandLibrary.emptyBodyFile");
      if (size === undefined || size > FILE_MAX_BYTES)
        throw new BodyFileError("commandLibrary.largeBodyFile");
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        if ("reference" in file) {
          if (!native)
            throw new BodyFileError("commandLibrary.changedBodyFile");
          const metadata = await native.fileMetadata(file.reference, signal);
          if (metadata.purpose !== "read_file" || metadata.length !== length)
            throw new BodyFileError("commandLibrary.changedBodyFile");
          bytes = await readVerifiedFile(
            file.reference,
            native.readFile,
            signal,
            { totalBytes: metadata.length, fingerprint: metadata.fingerprint },
          );
        } else {
          bytes = new Uint8Array(await file.arrayBuffer());
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        if (!("reference" in file) || error instanceof ContractValidationError)
          throw new BodyFileError("commandLibrary.changedBodyFile");
        throw error;
      }
      signal.throwIfAborted();
      setPreview({ name: file.name, size: length, hex: formatHex(bytes) });
    });
  }
  useTransferFileDrop(zone, !!native?.pickDroppedFile, (drop) => {
    const pick = native?.pickDroppedFile;
    if (pick) select((signal) => pick(drop, signal));
  });
  function selectBrowserFiles(files: FileList | null) {
    if (locked || !files?.length) return;
    const file = files.length === 1 ? files.item(0) : null;
    if (file) select(async () => file);
    else
      void action.run(async () => {
        setPreview(undefined);
        throw new BodyFileError("commandLibrary.oneBodyFile");
      });
  }
  const browser = access.kind === "browser";
  const dragging = useBrowserFileDrop(
    zone,
    browser,
    !locked,
    selectBrowserFiles,
  );

  return (
    <div className="workbench-command-file grid gap-1">
      {browser && (
        <input
          type="file"
          className="hidden"
          ref={fileInput}
          disabled={locked}
          onChange={(event) => {
            selectBrowserFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      )}
      <div
        className={
          dragging
            ? "flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md ring-1 ring-ring"
            : "flex min-w-0 flex-wrap items-center justify-between gap-2"
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          <label htmlFor={fieldId}>{t("commandLibrary.body")}</label>
          {(browser || native?.pickDroppedFile) && (
            <span className="text-xs text-muted-foreground">
              {t("workbench.tools.dropSource")}
            </span>
          )}
        </div>
        <Button
          ref={choose}
          type="button"
          size="sm"
          variant="outline"
          aria-disabled={locked || undefined}
          onClick={() => {
            if (locked) return;
            if (native) select(native.choose);
            else fileInput.current?.click();
          }}
        >
          {t("commandLibrary.chooseBodyFile")}
        </Button>
      </div>
      {action.busy && <p role="status">{t("common.loading")}</p>}
      {action.error && (
        <p role="alert" className="wrap-anywhere text-destructive">
          {action.error}
        </p>
      )}
      {preview && (
        <div
          role="group"
          aria-labelledby={fieldId + "-selected-file"}
          className="grid min-w-0 gap-2 rounded-md border border-border p-2"
        >
          <div role="status" className="min-w-0 wrap-anywhere">
            <p id={fieldId + "-selected-file"} className="font-medium">
              {preview.name}
            </p>
            <p className="text-muted-foreground">
              {t(
                hasBody
                  ? "commandLibrary.replaceBodyFileHint"
                  : "commandLibrary.loadBodyFileHint",
                {
                  bytes: Number(preview.size).toLocaleString(language),
                },
              )}
            </p>
          </div>
          <div className="wrap-anywhere text-xs">
            <span className="sr-only">{t("commandLibrary.filePrefix")}</span>
            <code>
              {preview.hex.slice(0, PREVIEW_HEX_LENGTH)}
              {preview.hex.length > PREVIEW_HEX_LENGTH ? " …" : ""}
            </code>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => {
                setPreview(undefined);
                choose.current?.focus();
              }}
            >
              {t("commandLibrary.cancelBodyFile")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => {
                setPreview(undefined);
                onApply(preview.hex);
              }}
            >
              {t(
                hasBody
                  ? "commandLibrary.replaceBodyFromFile"
                  : "commandLibrary.loadBodyFromFile",
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
