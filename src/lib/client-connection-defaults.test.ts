import { expect, it, vi } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import type { ConnectionDefault } from "./generated/bindings";
import {
  DEFAULT_CLIENT_STATE,
  parseClientWindowState,
  type ClientSettingsPort,
  type ClientStateSnapshot,
} from "./client-settings";
import {
  connectionKey,
  createConnectionDefaultsBackend,
} from "./client-connection-defaults";

const entry = (
  deviceId = "device-a",
  baudRate = "115200",
): ConnectionDefault => ({
  hostId: "host-a",
  deviceId,
  configuration: { ...defaults.serialConfiguration, baudRate },
});
function storage(connectionDefaults: ConnectionDefault[] = []) {
  let snapshot: ClientStateSnapshot = {
    formatVersion: "0.1",
    revision: "1",
    state: { ...structuredClone(DEFAULT_CLIENT_STATE), connectionDefaults },
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
    change(state: Partial<ClientStateSnapshot["state"]>) {
      snapshot = {
        ...snapshot,
        revision: String(BigInt(snapshot.revision) + 1n),
        state: { ...snapshot.state, ...state },
      };
    },
    future() {
      snapshot = { ...snapshot, formatVersion: "9.0" };
    },
  };
}

it("restores an exact per-host/device configuration through a new backend without writing other state", async () => {
  const h = storage();
  const backend = createConnectionDefaultsBackend(h.port);
  const initial = await backend.read();
  const saved = entry("device-a", "18446744073709551615");
  await backend.save(
    {
      [connectionKey(saved.hostId, saved.deviceId)]: {
        configuration: saved.configuration,
        writeWaitMode: "automatic",
      },
    },
    initial.revision,
  );
  expect(
    (await createConnectionDefaultsBackend(h.port).read()).value[
      connectionKey("host-a", "device-a")
    ],
  ).toEqual({ configuration: saved.configuration, writeWaitMode: "automatic" });
  expect(h.snapshot.state.drafts).toEqual(DEFAULT_CLIENT_STATE.drafts);
  expect(h.snapshot.state.preferences).toEqual(
    DEFAULT_CLIENT_STATE.preferences,
  );
});

it("merges a different-device update and changed drafts/preferences after a CAS conflict", async () => {
  const h = storage();
  const backend = createConnectionDefaultsBackend(h.port);
  const base = await backend.read();
  h.port.save.mockImplementationOnce(async () => {
    h.change({
      connectionDefaults: [entry("device-b", "230400")],
      drafts: { view: "UNSENT" },
      preferences: { ...DEFAULT_CLIENT_STATE.preferences, sidebarWidth: 300 },
    });
    throw { code: "CONFLICT" };
  });
  await backend.save(
    {
      [connectionKey("host-a", "device-a")]: {
        configuration: entry().configuration,
        writeWaitMode: "automatic",
      },
    },
    base.revision,
  );
  expect(h.snapshot.state.connectionDefaults).toEqual(
    expect.arrayContaining([entry(), entry("device-b", "230400")]),
  );
  expect(h.snapshot.state.drafts).toEqual({ view: "UNSENT" });
  expect(h.snapshot.state.preferences.sidebarWidth).toBe(300);
});

it("preserves a conflicting change to the same device and does not silently overwrite it", async () => {
  const h = storage([entry()]);
  const backend = createConnectionDefaultsBackend(h.port);
  const base = await backend.read();
  h.port.save.mockImplementationOnce(async () => {
    h.change({ connectionDefaults: [entry("device-a", "460800")] });
    throw { code: "CONFLICT" };
  });
  await expect(
    backend.save(
      {
        [connectionKey("host-a", "device-a")]: {
          configuration: entry("device-a", "230400").configuration,
          writeWaitMode: "automatic",
        },
      },
      base.revision,
    ),
  ).rejects.toEqual({ code: "CONFLICT" });
  expect(h.port.save).toHaveBeenCalledOnce();
  expect(h.snapshot.state.connectionDefaults).toEqual([
    entry("device-a", "460800"),
  ]);
});

it("accepts an already committed identical value after a conflict without writing it again", async () => {
  const h = storage();
  const backend = createConnectionDefaultsBackend(h.port);
  const base = await backend.read();
  h.port.save.mockImplementationOnce(async () => {
    h.change({ connectionDefaults: [entry()] });
    throw { code: "CONFLICT" };
  });
  await expect(
    backend.save(
      {
        [connectionKey("host-a", "device-a")]: {
          configuration: entry().configuration,
          writeWaitMode: "automatic",
        },
      },
      base.revision,
    ),
  ).resolves.toMatchObject({ revision: "2" });
  expect(h.port.save).toHaveBeenCalledOnce();
});

it("refuses future formats and malformed or duplicated configurations", async () => {
  const h = storage();
  h.future();
  await expect(createConnectionDefaultsBackend(h.port).read()).rejects.toEqual({
    code: "FUTURE_FORMAT",
  });
  expect(h.port.save).not.toHaveBeenCalled();
  for (const connectionDefaults of [
    [entry(), entry()],
    [
      {
        ...entry(),
        configuration: { ...entry().configuration, baudRate: "0" },
      },
    ],
    null,
    [{ ...entry(), writeWaitMode: "never" }],
    [{ ...entry(), writeWaitMode: null }],
  ]) {
    expect(() =>
      parseClientWindowState({ ...DEFAULT_CLIENT_STATE, connectionDefaults }),
    ).toThrow();
  }
  expect(
    parseClientWindowState(DEFAULT_CLIENT_STATE).connectionDefaults,
  ).toBeUndefined();
});
