import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoBackground } from "./video-background";
const activity = vi.hoisted(() => ({ active: true }));
vi.mock("@/hooks/use-motion-activity", () => ({
  useMotionActivity: (_ref: unknown, enabled: boolean) => ({
    active: activity.active && enabled,
  }),
}));
vi.mock("@/hooks/use-latest-translator", () => ({
  useLatestTranslator: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const resource = {
  url: "blob:authorized-video",
  mime: "video/webm",
  name: "clouds.webm",
  dispose: vi.fn(),
};
beforeEach(() => {
  activity.active = true;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("uses the authorized resource and pauses with reduced motion or hidden activity", async () => {
  const view = render(
    <VideoBackground resource={resource} fit="contain" enabled />,
  );
  const video = view.container.querySelector("video")!;
  await waitFor(() => expect(video).toHaveAttribute("data-playing", "true"));
  expect(video).toHaveAttribute("src", resource.url);
  expect(video).toHaveStyle({ objectFit: "contain" });
  expect(video.muted).toBe(true);
  expect(video.loop).toBe(true);
  activity.active = false;
  view.rerender(<VideoBackground resource={resource} fit="cover" enabled />);
  expect(video.pause).toHaveBeenCalled();
  expect(video).toHaveAttribute("data-playing", "false");
  expect(video).toHaveAttribute("src", resource.url);
  expect(video).toHaveStyle({ objectFit: "cover" });
  expect(resource.dispose).not.toHaveBeenCalled();
});
it("ignores late play completion after unmount and clears the media source", async () => {
  let finish!: () => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <VideoBackground resource={resource} fit="cover" enabled />,
  );
  const video = view.container.querySelector("video")!;
  view.unmount();
  await act(async () => finish());
  expect(video).not.toHaveAttribute("src");
  expect(video.pause).toHaveBeenCalled();
});
it("stops a failing decoder without changing shared settings", async () => {
  const view = render(
    <VideoBackground resource={resource} fit="cover" enabled />,
  );
  const video = view.container.querySelector("video")!;
  await waitFor(() => expect(video).toHaveAttribute("data-playing", "true"));
  fireEvent.error(video);
  expect(video).toHaveAttribute("data-playing", "false");
});
