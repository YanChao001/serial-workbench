import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/providers/i18n";
import { useSettings } from "@/providers/settings";
import type { MediaPort, ResolvedMedia } from "@/lib/media";
import { reportClientError } from "@/lib/report-error";
import {
  createClientGallery,
  sameGalleryReference,
  type GalleryEntry,
} from "@/lib/client-gallery";

function GalleryPreview({
  entry,
  media,
}: {
  entry: GalleryEntry;
  media: MediaPort;
}) {
  const [resolved, setResolved] = useState<{
    port: MediaPort;
    value: ResolvedMedia;
  }>();
  const { hostId, kind, id, revision } = entry.reference;
  useEffect(() => {
    const request = new AbortController();
    let resource: ResolvedMedia | undefined;
    void media
      .resolve({ hostId, kind, id, revision }, request.signal)
      .then((value) => {
        if (request.signal.aborted) {
          value.dispose();
          return;
        }
        resource = value;
        setResolved({ port: media, value });
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted)
          reportClientError(error, "Gallery preview");
      });
    return () => {
      request.abort();
      resource?.dispose();
    };
  }, [media, hostId, kind, id, revision]);
  const resource = resolved?.port === media ? resolved.value : undefined;
  if (!resource)
    return <span className="block aspect-video bg-muted" aria-hidden="true" />;
  return resource.mime.startsWith("video/") ? (
    <video
      src={resource.url}
      className="aspect-video w-full object-cover"
      muted
      preload="metadata"
      tabIndex={-1}
      aria-hidden="true"
    />
  ) : (
    <img
      src={resource.url}
      alt=""
      draggable={false}
      className="aspect-video w-full object-cover"
    />
  );
}

/** Gallery metadata stays in ClientState; applying a selection changes Host preferences. */
export function CustomBackgroundPicker() {
  const { settings, update, persistence, media } = useSettings();
  const { t } = useI18n();
  const id = useId();
  const [gallery] = useState(createClientGallery);
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [renaming, setRenaming] = useState<GalleryEntry | null>(null);
  const [name, setName] = useState("");
  const importButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreAfterRemoval = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<{ port: MediaPort | undefined }>();
  useEffect(() => () => request.current?.abort(), [media]);
  useEffect(() => {
    const controller = new AbortController();
    void gallery
      .read(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setEntries(value);
        setLoadFailed(false);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [gallery, retry]);
  const selected =
    settings.background.kind === "media" ? settings.background : null;
  const busy = pending !== undefined && pending.port === media;
  useEffect(() => {
    if (busy || !restoreAfterRemoval.current) return;
    restoreAfterRemoval.current = false;
    (importButton.current?.disabled
      ? heading.current
      : importButton.current
    )?.focus();
  }, [busy, entries]);
  const disabled = busy || loading || loadFailed;
  async function perform(
    action: (signal: AbortSignal) => Promise<GalleryEntry[]>,
    complete?: () => void,
  ) {
    if (disabled || (request.current && !request.current.signal.aborted))
      return;
    const controller = new AbortController();
    request.current = controller;
    setPending({ port: media });
    setFailed(false);
    try {
      const value = await action(controller.signal);
      if (controller.signal.aborted) return;
      setEntries(value);
      complete?.();
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        setPending(undefined);
        request.current = null;
      }
    }
  }
  function choose() {
    if (!media) return;
    void perform(async (signal) => {
      const chosen = await media.choose(signal);
      signal.throwIfAborted();
      if (!chosen) return entries;
      const name = Array.from(
        chosen.name.replace(/\p{Cc}/gu, "").trim() || chosen.reference.id,
      )
        .slice(0, 120)
        .join("");
      const value = await gallery.upsert(
        { reference: chosen.reference, name },
        signal,
      );
      signal.throwIfAborted();
      update({
        background: {
          kind: "media",
          reference: chosen.reference,
          fit: selected?.fit ?? "cover",
        },
      });
      return value;
    });
  }
  function reload() {
    setLoading(true);
    setRetry((value) => value + 1);
  }
  return (
    <section aria-label={t("settings.bgCustom")} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-medium">
          {t("settings.bgCustom")}
        </h3>
        <Button
          ref={importButton}
          type="button"
          onClick={choose}
          disabled={!media || disabled || persistence === "loading"}
        >
          {t("settings.importBackground")}
        </Button>
      </div>
      {!media ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("settings.mediaUnavailable")}
        </p>
      ) : null}
      {failed || loadFailed ? (
        <div
          role="alert"
          className="flex items-center gap-3 text-sm text-destructive"
        >
          <span>{t("settings.libraryError")}</span>
          <Button
            type="button"
            variant="outline"
            onClick={reload}
            disabled={busy || loading}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p className="sr-only" aria-live="polite">
          {t("common.loading")}
        </p>
      ) : entries.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {entries.map((entry) => (
            <li
              key={JSON.stringify([entry.reference.hostId, entry.reference.id])}
              className="min-w-0 overflow-hidden rounded-lg border bg-background"
            >
              <button
                data-surface="artwork"
                type="button"
                className="block w-full rounded-md text-left transition-shadow hover:ring-2 hover:ring-ring/60 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
                aria-label={t("settings.chooseWallpaper", { name: entry.name })}
                aria-pressed={
                  !!selected &&
                  sameGalleryReference(selected.reference, entry.reference)
                }
                disabled={!media || disabled}
                onClick={() =>
                  update({
                    background: {
                      kind: "media",
                      reference: entry.reference,
                      fit: selected?.fit ?? "cover",
                    },
                  })
                }
              >
                {media ? (
                  <GalleryPreview
                    key={entry.reference.revision}
                    entry={entry}
                    media={media}
                  />
                ) : null}
                <span className="block truncate px-2 py-1 text-sm">
                  {entry.name}
                </span>
              </button>
              <div className="flex flex-wrap gap-1 p-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("settings.renameWallpaper", {
                    name: entry.name,
                  })}
                  disabled={disabled}
                  onClick={() => {
                    setName(entry.name);
                    setRenaming(entry);
                  }}
                >
                  {t("settings.renameWallpaperTitle")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("settings.deleteWallpaper", {
                    name: entry.name,
                  })}
                  disabled={disabled}
                  onClick={() =>
                    void perform(
                      (signal) => gallery.remove(entry.reference, signal),
                      () => {
                        restoreAfterRemoval.current = true;
                      },
                    )
                  }
                >
                  {t("settings.removeWallpaper")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("settings.libraryEmpty")}
        </p>
      )}
      {selected ? (
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-2 text-sm">
            {t("settings.backgroundFit")}
          </legend>
          {(["cover", "contain"] as const).map((fit) => (
            <label key={fit} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-fit`}
                checked={selected.fit === fit}
                onChange={() => update({ background: { ...selected, fit } })}
              />
              {t(
                fit === "cover"
                  ? "settings.backgroundCover"
                  : "settings.backgroundContain",
              )}
            </label>
          ))}
        </fieldset>
      ) : null}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.renameWallpaperTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.renameWallpaperHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming)
                void perform(
                  (signal) => gallery.rename(renaming.reference, name, signal),
                  () => setRenaming(null),
                );
            }}
          >
            <Label htmlFor={`${id}-name`}>{t("settings.wallpaperName")}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={busy}
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenaming(null)}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !name.trim() ||
                  Array.from(name).length > 120 ||
                  /\p{Cc}/u.test(name)
                }
              >
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
