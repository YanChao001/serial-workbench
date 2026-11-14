import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "./host-context";
import { createHostActionObserver } from "./host-action-observer";

const input = (epoch = "1"): HostActionCheckInput => ({
  actionId: "session.close",
  target: {
    hostId: "host",
    kind: "session",
    id: "session",
    sessionId: "session",
    sessionEpoch: epoch,
  },
  params: {},
});
const result = (value: HostActionCheckInput, allowed = true) => ({
  actionId: value.actionId,
  target: value.target,
  allowed,
});
let lifetime: AbortController;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  lifetime = new AbortController();
});
afterEach(() => {
  lifetime.abort();
  vi.useRealTimers();
});

it("renews unchanged grants without notifying the view", async () => {
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) =>
    result(value),
  );
  const observer = createHostActionObserver(check, lifetime.signal);
  const values: (readonly HostActionAvailability[])[] = [];
  const listener = vi.fn((next: readonly HostActionAvailability[]) => {
    values.push(next);
  });
  const inputs = [input(), { ...input(), actionId: "session.takeover" }];
  observer.watch(inputs, listener);
  await vi.advanceTimersByTimeAsync(1100);
  expect(check).toHaveBeenCalledTimes(6);
  expect(listener).toHaveBeenCalledTimes(3);
  expect(
    values.map((value) => value.map((item) => item.result?.allowed ?? null)),
  ).toEqual([
    [null, null],
    [true, null],
    [true, true],
  ]);
});

it("publishes changed rights, expires the renewed grant, and accepts its fresh late result", async () => {
  let allowed = true;
  let defer = false;
  let finish: (() => void) | undefined;
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) => {
    if (defer)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return result(value, allowed);
  });
  const observer = createHostActionObserver(check, lifetime.signal);
  const observed: (boolean | null)[] = [];
  observer.watch([input()], (values) =>
    observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  expect(observed).toEqual([null, true]);
  allowed = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(observed).toEqual([null, true, false]);
  defer = true;
  await vi.advanceTimersByTimeAsync(500);
  expect(observed).toEqual([null, true, false]);
  await vi.advanceTimersByTimeAsync(500);
  expect(observed).toEqual([null, true, false, null]);
  finish?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual([null, true, false, null, false]);
});

it("immediately publishes cached rights to a new watcher and unknown after invalidation", async () => {
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) =>
    result(value),
  );
  const observer = createHostActionObserver(check, lifetime.signal);
  const retired = vi.fn();
  const stop = observer.watch([input()], retired);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const observed: (boolean | null)[] = [];
  observer.watch([input()], (values) =>
    observed.push(values[0]?.result?.allowed ?? null),
  );
  expect(observed).toEqual([true]);
  observer.invalidate();
  expect(observed).toEqual([true, null]);
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual([true, null, true]);
  expect(retired).toHaveBeenCalledTimes(2);
});

it("keeps late registrations unknown after retirement without reviving checks or cached grants", async () => {
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) =>
    result(value),
  );
  const observer = createHostActionObserver(check, lifetime.signal);
  const initial = vi.fn();
  observer.watch([input()], initial);
  await vi.advanceTimersByTimeAsync(0);
  expect(initial.mock.lastCall?.[0][0]?.result?.allowed).toBe(true);
  lifetime.abort();
  const observed = vi.fn();
  const stop = observer.watch([input()], observed);
  expect(observed).toHaveBeenCalledExactlyOnceWith([
    { input: input(), result: null, error: null },
  ]);
  stop();
  stop();
  await vi.advanceTimersByTimeAsync(2000);
  expect(check).toHaveBeenCalledOnce();
  expect(observed).toHaveBeenCalledOnce();
});

it("keeps an already-aborted observer inert without accumulating watcher slots", async () => {
  lifetime.abort();
  const check = vi.fn<HostContextValue["checkAction"]>();
  const observer = createHostActionObserver(check, lifetime.signal);
  const observed = vi.fn();
  const cleanups: (() => void)[] = [];
  for (let index = 0; index < 256; index++) {
    const current = input(String(index));
    cleanups.push(observer.watch([current], observed));
    expect(observed).toHaveBeenLastCalledWith([
      { input: current, result: null, error: null },
    ]);
  }
  for (const stop of cleanups) stop();
  observer.invalidate();
  await vi.advanceTimersByTimeAsync(2000);
  expect(check).not.toHaveBeenCalled();
  expect(observed).toHaveBeenCalledTimes(256);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps full errors observable even when their messages and later results repeat", async () => {
  const denied = Object.assign(new Error("Cannot read rights"), {
    code: "PERMISSION_DENIED",
    retryable: false,
    details: { reason: "revoked" },
  });
  const busy = Object.assign(new Error("Cannot read rights"), {
    code: "HOST_BUSY",
    retryable: true,
    details: { reason: "limit" },
  });
  const check = vi
    .fn<HostContextValue["checkAction"]>()
    .mockRejectedValueOnce(denied)
    .mockRejectedValueOnce(busy)
    .mockRejectedValueOnce(busy)
    .mockImplementation(async (value) => result(value));
  const observer = createHostActionObserver(check, lifetime.signal);
  const observed: (readonly HostActionAvailability[])[] = [];
  observer.watch([input()], (values) => {
    observed.push(values);
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(observed.map((values) => values[0]?.error)).toEqual([
    null,
    denied,
    busy,
    busy,
    null,
  ]);
  expect(observed.at(-1)?.[0]?.result?.allowed).toBe(true);
});

it("keeps retired pending checks in the concurrency budget and ignores their late results", async () => {
  const releases: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return result(value);
  });
  const observer = createHostActionObserver(check, lifetime.signal);
  const retired = vi.fn();
  const stop = observer.watch(
    [input("1"), input("2"), input("3"), input("4")],
    retired,
  );
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const current = vi.fn();
  observer.watch([input("5")], current);
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(4);
  releases.shift()?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(5);
  expect(peak).toBe(4);
  expect(retired).toHaveBeenCalledTimes(1);
  expect(current).toHaveBeenCalledTimes(1);
  lifetime.abort();
  for (const release of releases) release();
  await vi.advanceTimersByTimeAsync(0);
  expect(current).toHaveBeenCalledTimes(1);
});

it("serves new inputs when slow renewals already occupy every concurrency slot", async () => {
  let active = 0;
  let peak = 0;
  const check = vi.fn<HostContextValue["checkAction"]>(async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    active--;
    return result(value);
  });
  const observer = createHostActionObserver(check, lifetime.signal);
  observer.watch([input("1"), input("2"), input("3"), input("4")], () => {});
  await vi.advanceTimersByTimeAsync(100);
  const observed: (boolean | null)[] = [];
  observer.watch([input("5")], (values) =>
    observed.push(values[0]?.result?.allowed ?? null),
  );
  await vi.advanceTimersByTimeAsync(1800);
  expect(
    check.mock.calls.some(([value]) => value.target.sessionEpoch === "5"),
  ).toBe(true);
  expect(observed).toContain(true);
  expect(peak).toBe(4);
});
