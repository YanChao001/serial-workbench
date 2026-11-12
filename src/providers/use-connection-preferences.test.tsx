import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import {
  DEFAULT_CLIENT_STATE,
  type ClientSettingsPort,
  type ClientStateSnapshot,
} from "@/lib/client-settings";
import { connectionKey } from "@/lib/client-connection-defaults";
import { useConnectionPreferences } from "./use-connection-preferences";

afterEach(cleanup);
const config = (baudRate: string) => ({
  ...defaults.serialConfiguration,
  baudRate,
});
function storage() {
  let snapshot: ClientStateSnapshot = {
    formatVersion: "0.1",
    revision: "1",
    state: structuredClone(DEFAULT_CLIENT_STATE),
  };
  const port = {
    read: vi.fn(async () => structuredClone(snapshot)),
    save: vi.fn<ClientSettingsPort["save"]>(async (state, revision) => {
      if (revision !== snapshot.revision) throw { code: "CONFLICT" };
      snapshot = {
        ...snapshot,
        revision: String(BigInt(revision) + 1n),
        state,
      };
      return structuredClone(snapshot);
    }),
  };
  return {
    port,
    get snapshot() {
      return snapshot;
    },
    future() {
      snapshot = { ...snapshot, formatVersion: "9.0" };
    },
  };
}

it("defaults remembered devices to automatic timing and restores an explicit fixed policy with the same configuration", async () => {
  const h = storage();
  const first = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(first.result.current.status).toBe("saved"));
  act(() => first.result.current.remember("host", "device", config("9600")));
  await act(async () => first.result.current.flush());
  expect(first.result.current.waitModes[connectionKey("host", "device")]).toBe(
    "automatic",
  );
  act(() =>
    first.result.current.remember("host", "device", config("9600"), "fixed"),
  );
  await act(async () => first.result.current.flush());
  expect(h.snapshot.state.connectionDefaults?.[0]?.writeWaitMode).toBe("fixed");
  first.unmount();
  const restored = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(restored.result.current.status).toBe("saved"));
  expect(
    restored.result.current.waitModes[connectionKey("host", "device")],
  ).toBe("fixed");
  expect(
    restored.result.current.values[connectionKey("host", "device")],
  ).toEqual(config("9600"));
});

it("coalesces edits during a real pending save and keeps that save owned after an aborted UI wait", async () => {
  const h = storage();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const write = h.port.save.getMockImplementation()!;
  h.port.save.mockImplementationOnce(async (state, revision) => {
    await gate;
    return write(state, revision);
  });
  const hook = renderHook(() => useConnectionPreferences(h.port), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    ),
  });
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  act(() => hook.result.current.remember("host", "device", config("115200")));
  await waitFor(() => expect(h.port.save).toHaveBeenCalledOnce());
  act(() => hook.result.current.remember("host", "device", config("230400")));
  const controller = new AbortController();
  const waiting = hook.result.current.flush(controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(hook.result.current.status).toBe("saving");
  expect(hook.result.current.dirty).toBe(true);
  expect(h.snapshot.state.connectionDefaults).toBeUndefined();
  await act(async () => finish());
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  expect(hook.result.current.values[connectionKey("host", "device")]).toEqual(
    config("230400"),
  );
  expect(hook.result.current.dirty).toBe(false);
  expect(h.port.save).toHaveBeenCalledTimes(2);
  hook.unmount();
  const restored = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(restored.result.current.status).toBe("saved"));
  expect(
    restored.result.current.values[connectionKey("host", "device")],
  ).toEqual(config("230400"));
});

it("discards a failed local edit without resubmitting it during coordinator cleanup", async () => {
  const h = storage();
  h.port.save.mockRejectedValueOnce({ code: "STORAGE_IO" });
  const hook = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  act(() => hook.result.current.remember("host", "device", config("115200")));
  await waitFor(() => expect(hook.result.current.status).toBe("error"));
  expect(hook.result.current.dirty).toBe(true);
  await act(async () => hook.result.current.discard());
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  expect(hook.result.current.values).toEqual({});
  expect(hook.result.current.dirty).toBe(false);
  expect(h.port.save).toHaveBeenCalledOnce();
});

it("cancels waiting during a failed-save retry while the coordinator keeps owning storage", async () => {
  const h = storage();
  h.port.save.mockRejectedValueOnce({ code: "STORAGE_IO" });
  const hook = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  act(() => hook.result.current.remember("host", "device", config("115200")));
  await waitFor(() => expect(hook.result.current.status).toBe("error"));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const read = h.port.read.getMockImplementation()!;
  h.port.read.mockImplementationOnce(async () => {
    await gate;
    return read();
  });
  const controller = new AbortController();
  let cancelled = false;
  let waiting!: Promise<unknown>;
  await act(async () => {
    waiting = hook.result.current
      .flush(controller.signal)
      .catch((error: unknown) => {
        cancelled = true;
        return error;
      });
  });
  try {
    await act(async () => controller.abort());
    expect(cancelled).toBe(true);
    await expect(waiting).resolves.toMatchObject({ name: "AbortError" });
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.dirty).toBe(true);
    expect(h.snapshot.state.connectionDefaults).toBeUndefined();
    expect(h.port.save).toHaveBeenCalledOnce();
  } finally {
    await act(async () => finish());
  }
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  expect(hook.result.current.dirty).toBe(false);
  expect(h.port.save).toHaveBeenCalledTimes(2);
  expect(h.snapshot.state.connectionDefaults?.[0]?.configuration).toEqual(
    config("115200"),
  );
});

it("does not start retrying storage when the UI wait was already cancelled", async () => {
  const h = storage();
  h.port.save.mockRejectedValueOnce({ code: "STORAGE_IO" });
  const hook = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  act(() => hook.result.current.remember("host", "device", config("115200")));
  await waitFor(() => expect(hook.result.current.status).toBe("error"));
  const reads = h.port.read.mock.calls.length;
  const controller = new AbortController();
  controller.abort();
  await act(async () => {
    await expect(
      hook.result.current.flush(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  expect(h.port.read).toHaveBeenCalledTimes(reads);
  expect(h.port.save).toHaveBeenCalledOnce();
  expect(hook.result.current.status).toBe("error");
  expect(hook.result.current.dirty).toBe(true);
});

it("keeps future-format reads quiet until an actual edit exists and never writes over that document", async () => {
  const h = storage();
  h.future();
  const hook = renderHook(() => useConnectionPreferences(h.port));
  await waitFor(() => expect(hook.result.current.error).toBe("FUTURE_FORMAT"));
  expect(hook.result.current.dirty).toBe(false);
  act(() => hook.result.current.remember("host", "device", config("115200")));
  expect(hook.result.current.dirty).toBe(true);
  await expect(hook.result.current.flush()).rejects.toMatchObject({
    code: "FUTURE_FORMAT",
  });
  expect(h.port.save).not.toHaveBeenCalled();
  expect(h.snapshot.formatVersion).toBe("9.0");
});
