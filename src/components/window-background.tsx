import { useEffect, useState } from "react";
import type { BackgroundSelection } from "@serial-workbench/contracts";
import type { MediaPort, ResolvedMedia } from "@/lib/media";
import { useSettings } from "@/providers/settings";
import { PatternArtwork } from "@/components/skin-artwork";
import { VideoBackground } from "@/components/video-background";
import { getBundledWallpaper } from "@/lib/bundled-wallpapers";
export { PatternArtwork } from "@/components/skin-artwork";

function MediaBackground({
  selection,
  media,
  enabled,
}: {
  selection: Extract<BackgroundSelection, { kind: "media" }>;
  media: MediaPort;
  enabled: boolean;
}) {
  const [resolvedState, setResolvedState] = useState<{
    media: MediaPort;
    resource: ResolvedMedia;
  }>();
  const { hostId, kind, id, revision } = selection.reference;
  useEffect(() => {
    const request = new AbortController();
    let resolved: ResolvedMedia | undefined;
    void media
      .resolve(
        { hostId, kind, id, ...(revision !== undefined ? { revision } : {}) },
        request.signal,
      )
      .then((value) => {
        if (request.signal.aborted) {
          value.dispose();
          return;
        }
        resolved = value;
        setResolvedState({ media, resource: value });
      })
      .catch(() => {
        /* Keep the saved reference intact when resolution fails. */
      });
    return () => {
      request.abort();
      resolved?.dispose();
    };
  }, [media, hostId, kind, id, revision]);
  const resource =
    resolvedState?.media === media ? resolvedState.resource : undefined;
  if (!resource) return null;
  if (resource.mime.startsWith("video/"))
    return (
      <VideoBackground
        key={resource.url}
        resource={resource}
        fit={selection.fit}
        enabled={enabled}
      />
    );
  return (
    <img
      className="custom-background-image"
      data-custom-background
      src={resource.url}
      alt=""
      draggable={false}
      style={{ objectFit: selection.fit }}
    />
  );
}

/** Decorative resources never participate in focus, drag or the reading surface. */
export function WindowBackground() {
  const { settings, media } = useSettings();
  const selection = settings.background;
  const bundled =
    selection.kind === "bundled"
      ? getBundledWallpaper(selection.id)
      : undefined;
  return (
    <div
      className="window-background"
      data-window-background
      aria-hidden="true"
    >
      {selection.kind === "preset" ? (
        <PatternArtwork kind={selection.value} />
      ) : bundled ? (
        <img
          className="custom-background-image"
          data-bundled-wallpaper
          src={bundled.url}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ objectFit: "cover" }}
        />
      ) : selection.kind === "media" && media ? (
        <MediaBackground
          key={`${selection.reference.hostId}:${selection.reference.kind}:${selection.reference.id}:${selection.reference.revision ?? ""}`}
          selection={selection}
          media={media}
          enabled={settings.backgroundIntensity > 0}
        />
      ) : null}
      <div className="window-reading-surface" data-window-reading-surface />
    </div>
  );
}
