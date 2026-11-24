import { expect, it, vi } from "vitest";
import type { Operation } from "@serial-workbench/contracts";
import {
  broadcastActive,
  startBroadcast,
  type BroadcastDestination,
} from "./broadcast-send";
import { operation } from "./test-fixtures";

function destination(id: string): BroadcastDestination {
  return {
    target: {
      hostId: "host",
      kind: "session",
      id,
      sessionId: id,
      sessionEpoch: "2",
    },
    label: id.toUpperCase(),
    revision: "7",
    writeWaitMs: "1000",
  };
}

function receipt(
  destination: BroadcastDestination,
  state: Operation["state"],
): Operation {
  return {
    ...operation("op-" + destination.target.id, destination.target.id),
    actionId: "session.tx",
    target: destination.target,
    executionMode: "independent",
    state,
    ...(state === "succeeded" && {
      result: {
        kind: "tx",
        value: {
          operationId: "op-" + destination.target.id,
          sessionId: destination.target.id,
          sessionEpoch: "2",
          outcome: "accepted",
          bytesBase64: "AQ==",
          byteStart: "0",
          byteEnd: "1",
          acceptedRanges: [{ start: "0", end: "1" }],
          unknownRanges: [],
          peerAcknowledged: false,
        },
      },
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("starts independent admissions in parallel, keeps the same bytes and respects each permission result", async () => {
  const destinations = ["a", "b", "c"].map(destination);
  const first = deferred<Operation>();
  const admit = vi.fn(async (call) =>
    call.target.id === "a"
      ? first.promise
      : receipt(destinations[1]!, "succeeded"),
  );
  const run = startBroadcast(destinations, Uint8Array.from([0, 255]), {
    allowed: async ({ target }) => target.id !== "c",
    admit,
    observe: async (operation) => operation,
    cancel: async () => {},
  });

  await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2));
  expect(admit.mock.calls.map(([call]) => call.target.id)).toEqual(["a", "b"]);
  for (const [call] of admit.mock.calls) {
    expect(call).toMatchObject({
      expectedRevision: "7",
      executionMode: "independent",
      params: { bytesBase64: "AP8=", writeWaitMs: "1000" },
    });
  }
  expect(run.snapshot().map(({ phase }) => phase)).toEqual([
    "admitting",
    "done",
    "notSent",
  ]);
  first.resolve(receipt(destinations[0]!, "failed"));
  await vi.waitFor(() =>
    expect(run.snapshot().some(broadcastActive)).toBe(false),
  );
  expect(run.snapshot().map(({ operation }) => operation?.state)).toEqual([
    "failed",
    "succeeded",
    undefined,
  ]);
});

it("prevents a stopped preflight from sending and uses the returned operation for an in-flight stop", async () => {
  const destinations = ["a", "b"].map(destination);
  const checked = deferred<boolean>();
  const accepted = deferred<Operation>();
  const settled = deferred<Operation>();
  const admit = vi.fn(() => accepted.promise);
  const cancel = vi.fn(async () => {});
  const run = startBroadcast(destinations, Uint8Array.of(1), {
    allowed: async ({ target }) => (target.id === "a" ? checked.promise : true),
    admit,
    observe: () => settled.promise,
    cancel,
  });

  await vi.waitFor(() => expect(run.snapshot()[1]?.phase).toBe("admitting"));
  run.stop(0);
  run.stop(1);
  expect(run.snapshot().map(({ stop }) => stop)).toEqual([
    "requested",
    "queued",
  ]);
  expect(cancel).not.toHaveBeenCalled();
  checked.resolve(true);
  const operation = receipt(destinations[1]!, "running");
  accepted.resolve(operation);
  await vi.waitFor(() =>
    expect(cancel).toHaveBeenCalledExactlyOnceWith(operation),
  );
  expect(admit).toHaveBeenCalledTimes(1);
  expect(run.snapshot()[1]?.phase).toBe("waiting");
  settled.resolve({ ...operation, state: "cancelled" });
  await vi.waitFor(() =>
    expect(run.snapshot()[1]?.operation?.state).toBe("cancelled"),
  );
});

it("clears a queued stop if admission returns a terminal write receipt", async () => {
  const destinations = ["a", "b"].map(destination);
  const accepted = deferred<Operation>();
  const cancel = vi.fn(async () => {});
  const run = startBroadcast(destinations, Uint8Array.of(1), {
    allowed: async () => true,
    admit: ({ target }) =>
      target.id === "a"
        ? accepted.promise
        : Promise.resolve(receipt(destinations[1]!, "succeeded")),
    observe: async (operation) => operation,
    cancel,
  });

  await vi.waitFor(() => expect(run.snapshot()[0]?.phase).toBe("admitting"));
  run.stop(0);
  expect(run.snapshot()[0]?.stop).toBe("queued");
  accepted.resolve(receipt(destinations[0]!, "succeeded"));
  await vi.waitFor(() => expect(run.snapshot()[0]?.phase).toBe("done"));
  expect(run.snapshot()[0]?.operation?.state).toBe("succeeded");
  expect(run.snapshot()[0]?.stop).toBeUndefined();
  expect(cancel).not.toHaveBeenCalled();
});

it("rechecks an unknown outcome using the same operation ID, without another send", async () => {
  const destinations = ["a", "b"].map(destination);
  const admit = vi.fn(async ({ target }) =>
    receipt(destinations[target.id === "a" ? 0 : 1]!, "running"),
  );
  const observe = vi.fn(async (operation: Operation) =>
    receipt(
      destinations.find(({ target }) => target.id === operation.target.id)!,
      "succeeded",
    ),
  );
  observe.mockRejectedValueOnce(new Error("transport lost"));
  const run = startBroadcast(destinations, Uint8Array.of(1), {
    allowed: async () => true,
    admit,
    observe,
    cancel: async () => {},
  });

  await vi.waitFor(() => expect(run.snapshot()[0]?.phase).toBe("unknown"));
  expect(run.snapshot()[0]?.operation?.operationId).toBe("op-a");
  run.recheck(0);
  await vi.waitFor(() =>
    expect(run.snapshot()[0]?.operation?.state).toBe("succeeded"),
  );
  expect(admit).toHaveBeenCalledTimes(2);
  expect(observe.mock.calls.at(-1)?.[0].operationId).toBe("op-a");
});
