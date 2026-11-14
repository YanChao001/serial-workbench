import { useEffect, useRef, useState } from "react";
import type { BackgroundFit } from "@serial-workbench/contracts";
import type { ResolvedMedia } from "@/lib/media";
import { toast } from "sonner";
import { useMotionActivity } from "@/hooks/use-motion-activity";
import { useLatestTranslator } from "@/hooks/use-latest-translator";

/** Resource ownership remains with the media resolver; playback follows activity. */
export function VideoBackground({
  resource,
  fit,
  enabled,
}: {
  resource: ResolvedMedia;
  fit: BackgroundFit;
  enabled: boolean;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const { active } = useMotionActivity(player, enabled);
  const translate = useLatestTranslator();
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    element.src = resource.url;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [resource.url]);
  useEffect(() => {
    const element = player.current;
    if (!element || !active || failed) return;
    let stopped = false;
    const fail = () => {
      if (stopped) return;
      element.pause();
      setPlaying(false);
      setFailed(true);
      toast.error(translate("settings.videoPlaybackError"));
    };
    element.addEventListener("error", fail);
    element.muted = true;
    void element
      .play()
      .then(() => {
        if (!stopped) setPlaying(true);
      })
      .catch(fail);
    return () => {
      stopped = true;
      element.removeEventListener("error", fail);
      element.pause();
    };
  }, [active, failed, resource.url, translate]);
  return (
    <video
      ref={player}
      className="custom-background-image"
      data-video-background
      data-custom-background-video
      data-playing={active && playing && !failed}
      muted
      loop
      playsInline
      preload="metadata"
      tabIndex={-1}
      aria-hidden="true"
      style={{ objectFit: fit }}
    />
  );
}
