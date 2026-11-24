import { expect, it, vi } from "vitest";
import {
  createSendHistoryPinStore,
  type SendHistoryPinScope,
} from "./client-send-history";
import {
  DEFAULT_CLIENT_STATE,
  parseClientWindowState,
  type ClientSettingsPort,
  type ClientStateSnapshot,
} from "./client-settings";

const first: SendHistoryPinScope = {
  hostId: "host-a",
  workspaceId: "workspace-a",
};
const second: SendHistoryPinScope = { ...first, workspaceId: "workspace-b" };
const signal = new AbortController().signal;

function setup() {
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
        state: parseClientWindowState(state),
      };
      return structuredClone(snapshot);
    }),
  };
  return {
    port,
    get snapshot() {
      return snapshot;
    },
    concurrentChange() {
      snapshot = {
        ...snapshot,
        revision: "2",
        state: {
          ...snapshot.state,
          drafts: { view: "Keep draft" },
          sendHistoryPins: [{ ...second, operationId: "operation-b" }],
        },
      };
    },
    future() {
      snapshot = { ...snapshot, formatVersion: "9.0" };
    },
  };
}

it("loads legacy state, saves only scoped IDs and restores pins through another store", async () => {
  const h = setup();
  const store = createSendHistoryPinStore(h.port);
  expect(await store.read(first, signal)).toEqual(new Set());
  expect(await store.set(first, "operation-a", true, signal)).toEqual(
    new Set(["operation-a"]),
  );
  expect(h.snapshot.state.sendHistoryPins).toEqual([
    { ...first, operationId: "operation-a" },
  ]);
  const reopened = createSendHistoryPinStore(h.port);
  expect(await reopened.read(first, signal)).toEqual(new Set(["operation-a"]));
  expect(await reopened.read(second, signal)).toEqual(new Set());
  expect(await reopened.read({ ...first, hostId: "host-b" }, signal)).toEqual(
    new Set(),
  );
  expect(await reopened.set(first, "operation-a", false, signal)).toEqual(
    new Set(),
  );
  expect(h.snapshot.state.sendHistoryPins).toEqual([]);
});

it("retries a stale revision and retains concurrent drafts and pins", async () => {
  const h = setup();
  h.port.save.mockImplementationOnce(async () => {
    h.concurrentChange();
    throw { code: "CONFLICT" };
  });
  const store = createSendHistoryPinStore(h.port);
  expect(await store.set(first, "operation-a", true, signal)).toEqual(
    new Set(["operation-a"]),
  );
  expect(h.port.save.mock.calls.map(([, revision]) => revision)).toEqual([
    "1",
    "2",
  ]);
  expect(h.snapshot.state.drafts).toEqual({ view: "Keep draft" });
  expect(await store.read(second, signal)).toEqual(new Set(["operation-b"]));
});

it("protects malformed or future client state", async () => {
  const h = setup();
  const pin = { ...first, operationId: "operation-a" };
  expect(() =>
    parseClientWindowState({
      ...DEFAULT_CLIENT_STATE,
      sendHistoryPins: [pin, pin],
    }),
  ).toThrow();
  expect(() =>
    parseClientWindowState({
      ...DEFAULT_CLIENT_STATE,
      sendHistoryPins: [{ ...pin, operationId: "" }],
    }),
  ).toThrow();
  expect(() =>
    parseClientWindowState({
      ...DEFAULT_CLIENT_STATE,
      sendHistoryPins: Array.from({ length: 65 }, (_, i) => ({
        ...pin,
        operationId: String(i),
      })),
    }),
  ).toThrow();
  h.future();
  await expect(
    createSendHistoryPinStore(h.port).set(first, "operation-a", true, signal),
  ).rejects.toEqual({ code: "FUTURE_FORMAT" });
  expect(h.port.save).not.toHaveBeenCalled();
});
