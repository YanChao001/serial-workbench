import { describe, expect, it, vi } from "vitest";
import { createMediaPort, type MediaNativePort } from "./media";
import { HostRequestError } from "@serial-workbench/host-client";

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
  it("backs off a busy decoder before resolving the same read-only reference", async () => {
    vi.useFakeTimers();
    try {
      const adapter = native();
      const busy = new HostRequestError({
        code: "HOST_BUSY",
        message: "Media response budget exhausted",
        retryable: false,
      });
      vi.mocked(adapter.resolve).mockRejectedValueOnce(busy);
      const pending = createMediaPort(adapter).resolve(reference);
      const outcome = pending.then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.resolve).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ url: resolved.url });
      expect(adapter.resolve).toHaveBeenCalledTimes(2);
      expect(adapter.choose).not.toHaveBeenCalled();
      (await pending).dispose();
      expect(adapter.release).toHaveBeenCalledExactlyOnceWith("ticket");
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds busy retries and does not reset the authorization recovery budget", async () => {
    vi.useFakeTimers();
    try {
      const adapter = native();
      const busy = new HostRequestError({
        code: "HOST_BUSY",
        message: "busy",
        retryable: false,
      });
      vi.mocked(adapter.resolve).mockRejectedValue(busy);
      const outcome = createMediaPort(adapter)
        .resolve(reference)
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toBe(busy);
      expect(adapter.resolve).toHaveBeenCalledTimes(6);
      const denied = new HostRequestError({
        code: "PERMISSION_DENIED",
        message: "revoked",
        retryable: false,
      });
      vi.mocked(adapter.resolve)
        .mockReset()
        .mockRejectedValue(denied)
        .mockRejectedValueOnce(denied)
        .mockRejectedValueOnce(busy)
        .mockRejectedValueOnce(denied)
        .mockRejectedValueOnce(denied);
      const revoked = createMediaPort(adapter)
        .resolve(reference)
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await revoked).toBe(denied);
      expect(adapter.resolve).toHaveBeenCalledTimes(5);
      expect(adapter.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels a busy backoff without making another native request or leaving timers", async () => {
    vi.useFakeTimers();
    try {
      const adapter = native();
      vi.mocked(adapter.resolve).mockRejectedValueOnce(
        new HostRequestError({
          code: "HOST_BUSY",
          message: "busy",
          retryable: false,
        }),
      );
      const controller = new AbortController();
      const outcome = createMediaPort(adapter)
        .resolve(reference, controller.signal)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(adapter.resolve).toHaveBeenCalledTimes(1);
      expect(adapter.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("resolves again with current authorization after concurrent explicit saves", async () => {
    const adapter = native();
    const denied = new HostRequestError({
      code: "PERMISSION_DENIED",
      message: "authorization changed",
      retryable: false,
    });
    vi.mocked(adapter.resolve)
      .mockRejectedValueOnce(denied)
      .mockRejectedValueOnce(denied);
    const media = await createMediaPort(adapter).resolve(reference);
    expect(adapter.resolve).toHaveBeenCalledTimes(3);
    expect(adapter.choose).not.toHaveBeenCalled();
    media.dispose();
    expect(adapter.release).toHaveBeenCalledExactlyOnceWith("ticket");
  });
  it("bounds fresh authorization reads without granting access after a real revocation", async () => {
    const adapter = native();
    const denied = new HostRequestError({
      code: "PERMISSION_DENIED",
      message: "revoked",
      retryable: false,
    });
    vi.mocked(adapter.resolve).mockRejectedValue(denied);
    await expect(createMediaPort(adapter).resolve(reference)).rejects.toBe(
      denied,
    );
    expect(adapter.resolve).toHaveBeenCalledTimes(4);
    expect(adapter.choose).not.toHaveBeenCalled();
    expect(adapter.release).not.toHaveBeenCalled();
  });
  it("does not recover an old Host generation or continue after consumer cancellation", async () => {
    const adapter = native();
    const epoch = new HostRequestError({
      code: "EPOCH_MISMATCH",
      message: "old generation",
      retryable: false,
    });
    vi.mocked(adapter.resolve).mockRejectedValueOnce(epoch);
    await expect(createMediaPort(adapter).resolve(reference)).rejects.toBe(
      epoch,
    );
    expect(adapter.resolve).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    vi.mocked(adapter.resolve).mockImplementationOnce(async () => {
      controller.abort();
      throw new HostRequestError({
        code: "PERMISSION_DENIED",
        message: "changed",
        retryable: false,
      });
    });
    await expect(
      createMediaPort(adapter).resolve(reference, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.resolve).toHaveBeenCalledTimes(2);
    expect(adapter.release).not.toHaveBeenCalled();
  });
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
