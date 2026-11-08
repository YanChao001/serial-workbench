import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCaptureOperations } from "./use-capture-operations";
import { operation } from "./test-fixtures";
const ref = { hostId: "host", kind: "capture", id: "one" };
const captured = {
  ...operation("mine"),
  actionId: "capture.start",
  result: { kind: "reference" as const, value: { resultRef: ref } },
};
it("rejects late work and obsolete callbacks across workspace or attachment generations", async () => {
  const publish = vi.fn();
  const view = renderHook(
    ({ scope }) => useCaptureOperations(scope, [], publish),
    { initialProps: { scope: "A" }, wrapper: StrictMode },
  );
  const old = view.result.current;
  let resolve!: (v: typeof captured) => void;
  let pending!: Promise<unknown>;
  act(() => {
    pending = old(() => new Promise((r) => (resolve = r)));
  });
  view.rerender({ scope: "B" });
  await act(async () => {
    resolve(captured);
    await pending;
  });
  expect(publish).not.toHaveBeenCalled();
  await act(async () => {
    await old(async () => captured);
  });
  expect(publish).not.toHaveBeenCalled();
  await act(async () => {
    await view.result.current(async () => captured);
  });
  expect(publish).toHaveBeenCalledWith(ref);
});
it("waits for an owned running operation reference and ignores other clients' operations", async () => {
  const publish = vi.fn();
  const view = renderHook(
    ({ operations }) => useCaptureOperations("A", operations, publish),
    {
      initialProps: {
        operations: [{ ...captured, operationId: "someone-else" }],
      },
    },
  );
  await act(async () => {
    await view.result.current(async () => ({ ...captured, result: undefined }));
  });
  expect(publish).not.toHaveBeenCalled();
  view.rerender({ operations: [captured] });
  expect(publish).toHaveBeenCalledOnce();
});

it("does not publish an operation that finishes after unmount", async () => {
  const publish = vi.fn();
  const view = renderHook(() => useCaptureOperations("A", [], publish));
  let resolve!: (v: typeof captured) => void;
  let pending!: Promise<unknown>;
  act(() => {
    pending = view.result.current(() => new Promise((r) => (resolve = r)));
  });
  view.unmount();
  await act(async () => {
    resolve(captured);
    await pending;
  });
  expect(publish).not.toHaveBeenCalled();
});

it("uses the real capture reference when a locally started operation has already reached terminal status", async () => {
  const publish = vi.fn();
  const view = renderHook(() => useCaptureOperations("A", [], publish));
  await act(async () => {
    await view.result.current(async () => ({
      ...captured,
      result: {
        kind: "capture_status",
        value: {
          captureRef: { ...ref, revision: "2" },
          summary: {
            captureId: ref.id,
            state: "complete",
            watermarks: {
              written: "2",
              flushed: "2",
              synced: "2",
              verified: "2",
            },
            containerComplete: true,
            sourceContinuous: true,
          },
        },
      },
    }));
  });
  expect(publish).toHaveBeenCalledWith({ ...ref, revision: "2" });
});

it("uses the owned projected reference if projection arrives before the start receipt", async () => {
  const publish = vi.fn();
  const view = renderHook(
    ({
      operations,
    }: {
      operations: import("@serial-workbench/contracts").Operation[];
    }) => useCaptureOperations("A", operations, publish),
    {
      initialProps: {
        operations: [] as import("@serial-workbench/contracts").Operation[],
      },
    },
  );
  let resolve!: (v: import("@serial-workbench/contracts").Operation) => void;
  let pending!: Promise<unknown>;
  act(() => {
    pending = view.result.current(() => new Promise((r) => (resolve = r)));
  });
  view.rerender({ operations: [captured] });
  expect(publish).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ ...captured, result: undefined });
    await pending;
  });
  expect(publish).toHaveBeenCalledWith(ref);
});
