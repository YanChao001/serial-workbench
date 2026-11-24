import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  TransferProgress,
  type TransferReadProgressReader,
} from "./transfer-progress";
import { labels, operation } from "./test-fixtures";
import type { Operation } from "@serial-workbench/contracts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function transfer(accepted: string, patch: Partial<Operation> = {}): Operation {
  return {
    ...operation("file-transfer"),
    actionId: "transfer.file",
    state: "running",
    result: {
      kind: "file_transfer",
      value: {
        requested: "1000",
        accepted,
        unknown: "0",
        peerAcknowledged: false,
        receiptsRef: {
          hostId: "host",
          kind: "transfer_receipts",
          id: "receipts",
          revision: "1",
        },
      },
    },
    ...patch,
  };
}

it("calculates transfer rate and ETA from two accepted-byte observations and expires them when progress stalls", () => {
  vi.useFakeTimers();
  const time = vi.spyOn(performance, "now").mockReturnValue(1000);
  const labelsForProgress = labels.operationText.transfer;
  const view = render(
    <TransferProgress operation={transfer("100")} labels={labelsForProgress} />,
  );
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "100 B / 1.00 KB",
  );
  expect(screen.getByLabelText(labelsForProgress.rate)).toHaveTextContent("—");
  time.mockReturnValue(1500);
  view.rerender(
    <TransferProgress operation={transfer("350")} labels={labelsForProgress} />,
  );
  expect(screen.getByLabelText(labelsForProgress.rate)).toHaveTextContent(
    "500 B/s",
  );
  expect(screen.getByLabelText(labelsForProgress.eta)).toHaveTextContent(
    "00:00:02",
  );
  expect(
    screen.getByText(labelsForProgress.peerUnconfirmed),
  ).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByLabelText(labelsForProgress.rate)).toHaveTextContent("—");
  expect(screen.getByLabelText(labelsForProgress.eta)).toHaveTextContent("—");
});

it("retains confirmed and unknown bytes when cancellation settles and ignores the clock across operation identities", () => {
  const time = vi.spyOn(performance, "now").mockReturnValue(1000);
  const copy = labels.operationText.transfer;
  const view = render(
    <TransferProgress operation={transfer("100")} labels={copy} />,
  );
  time.mockReturnValue(1500);
  view.rerender(
    <TransferProgress
      operation={transfer("350", { operationId: "different-transfer" })}
      labels={copy}
    />,
  );
  expect(screen.getByLabelText(copy.rate)).toHaveTextContent("—");
  const result = {
    kind: "file_transfer",
    value: {
      requested: "1000",
      accepted: "350",
      unknown: "10",
      peerAcknowledged: false,
      receiptsRef: {
        hostId: "host",
        kind: "transfer_receipts",
        id: "receipts",
        revision: "1",
      },
    },
  } as const;
  view.rerender(
    <TransferProgress
      operation={transfer("350", {
        operationId: "different-transfer",
        state: "cancelled",
        result,
      })}
      labels={copy}
    />,
  );
  expect(screen.getByLabelText(copy.acceptedBytes)).toHaveTextContent("350 B");
  expect(screen.getByLabelText(copy.unknownBytes)).toHaveTextContent("10 B");
  expect(screen.queryByLabelText(copy.eta)).not.toBeInTheDocument();
});

it("shows unknown historical read evidence and resumes sampling after a transient failure", async () => {
  vi.useFakeTimers();
  const current = transfer("100");
  if (current.result?.kind !== "file_transfer")
    throw new Error("Missing receipt");
  const { receiptsRef } = current.result.value;
  const reader = vi
    .fn<TransferReadProgressReader>()
    .mockResolvedValueOnce({ receiptsRef })
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockResolvedValueOnce({ receiptsRef, read: "150" });
  const copy = labels.operationText.transfer;
  await act(async () => {
    render(
      <TransferProgress
        operation={current}
        labels={copy}
        readProgress={reader}
      />,
    );
  });
  expect(screen.getByLabelText(copy.readBytes)).toHaveTextContent("—");
  expect(reader).toHaveBeenCalledWith({ receiptsRef }, expect.any(AbortSignal));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByLabelText(copy.readBytes)).toHaveTextContent("—");
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByLabelText(copy.readBytes)).toHaveTextContent("150 B");
  expect(screen.getByLabelText(copy.acceptedBytes)).toHaveTextContent("100 B");
});
