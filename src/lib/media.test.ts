import { describe, expect, it, vi } from "vitest";
import { createMediaPort, type MediaNativePort } from "./media";

const reference = { hostId: "host", kind: "file", id: "file-1", revision: "1" };
const resolved = {
  url: "http://swb-media.localhost/ticket",
  ticket: "ticket",
  name: "cloud.mp4",
  mime: "video/mp4",
};
function native(): MediaNativePort {
  return {
    choose: vi.fn().mockResolvedValue(null),
    resolve: vi.fn().mockResolvedValue(resolved),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("authorized media lifecycle", () => {
  it("preserves cancellation and registers no invented reference", async () => {
    const adapter = native();
    expect(await createMediaPort(adapter).choose()).toBeNull();
  });
  it("does not open a native chooser after cancellation", async () => {
    const adapter = native();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createMediaPort(adapter).choose(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.choose).not.toHaveBeenCalled();
  });
  it("releases a late ticket when its consumer unmounts", async () => {
    const adapter = native();
    let complete!: (value: typeof resolved) => void;
    adapter.resolve = vi.fn(
      () =>
        new Promise<typeof resolved>((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = createMediaPort(adapter).resolve(
      reference,
      controller.signal,
    );
    controller.abort();
    complete(resolved);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.release).toHaveBeenCalledExactlyOnceWith("ticket");
  });
  it("releases a mounted ticket on abort and makes dispose idempotent", async () => {
    const adapter = native();
    const controller = new AbortController();
    const media = await createMediaPort(adapter).resolve(
      reference,
      controller.signal,
    );
    expect(media.url).toBe(resolved.url);
    controller.abort();
    media.dispose();
    media.dispose();
    expect(adapter.release).toHaveBeenCalledExactlyOnceWith("ticket");
  });
});
