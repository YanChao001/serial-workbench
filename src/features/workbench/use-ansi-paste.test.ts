import type { Operation } from "@serial-workbench/contracts";
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AnsiPasteTarget } from "./ansi-paste";
import { operation } from "./test-fixtures";
import { useAnsiPaste } from "./use-ansi-paste";

it("cancels the original paste after admission and waits for its actual written prefix", async () => {
  let admit!: (value: Operation) => void;
  let settle!: (value: Operation) => void;
  const target = {
    start: vi.fn<AnsiPasteTarget["start"]>(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
    ),
    wait: vi.fn<AnsiPasteTarget["wait"]>(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    ),
    cancel: vi.fn<AnsiPasteTarget["cancel"]>().mockResolvedValue(undefined),
  };
  const { result } = renderHook(() => useAnsiPaste("session", target, "utf-8"));
  act(() => result.current.prepare("abc", false));

  let sent!: Promise<void>;
  await act(async () => {
    sent = result.current.send(false);
  });
  expect(target.start).toHaveBeenCalledExactlyOnceWith(
    Uint8Array.of(97, 98, 99),
  );
  expect(result.current.current?.phase).toBe("sending");

  let cancelRequest!: Promise<void>;
  act(() => {
    cancelRequest = result.current.cancel();
    result.current.prepare("another paste", false);
  });
  expect(target.cancel).not.toHaveBeenCalled();
  expect(result.current.preview).toBeNull();
  expect(result.current.current?.phase).toBe("cancelling");

  const admitted: Operation = {
    ...operation("original-paste"),
    actionId: "transfer.paste",
    executionMode: "independent",
    state: "queued",
  };
  await act(async () => {
    admit(admitted);
    await cancelRequest;
  });
  expect(target.cancel).toHaveBeenCalledExactlyOnceWith(admitted);
  expect(target.wait).toHaveBeenCalledExactlyOnceWith(
    admitted,
    expect.any(AbortSignal),
  );
  expect(result.current.current?.phase).toBe("cancelling");
  expect(result.current.busy).toBe(true);

  await act(async () => {
    settle({
      ...admitted,
      state: "cancelled",
      result: {
        kind: "file_transfer",
        value: {
          requested: "3",
          accepted: "1",
          unknown: "0",
          receiptsRef: {
            hostId: "host",
            kind: "transfer_receipts",
            id: admitted.operationId,
            revision: "1",
          },
          peerAcknowledged: false,
        },
      },
    });
    await sent;
  });
  expect(result.current.current).toMatchObject({
    phase: "cancelled",
    accepted: "1",
  });
  expect(result.current.busy).toBe(false);
  expect(target.start).toHaveBeenCalledOnce();
});
