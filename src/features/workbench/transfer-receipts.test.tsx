import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FileTransferReceiptsResult } from "@serial-workbench/contracts";
import { TransferReceipts, type ReceiptReader } from "./transfer-receipts";
import { labels } from "./test-fixtures";
afterEach(cleanup);
const receiptsRef = {
  hostId: "host",
  kind: "file",
  id: "receipts",
  revision: "1",
};
const page = (
  offset: string,
  hasMore: boolean,
): FileTransferReceiptsResult => ({
  receiptsRef,
  count: "2",
  nextOrdinal: hasMore ? "1" : "2",
  hasMore,
  sealed: true,
  receipts: [
    {
      sourceOffset: offset,
      receipt: {
        operationId: "transfer",
        sessionId: "session",
        sessionEpoch: "1",
        outcome: "accepted",
        bytesBase64: "QQ==",
        byteStart: offset,
        byteEnd: (BigInt(offset) + 1n).toString(),
        acceptedRanges: [
          { start: offset, end: (BigInt(offset) + 1n).toString() },
        ],
        unknownRanges: [],
        peerAcknowledged: false,
      },
    },
  ],
});
it("loads receipts only on demand and pages by the Host cursor", async () => {
  const read = vi
    .fn<ReceiptReader>()
    .mockResolvedValueOnce(page("0", true))
    .mockResolvedValueOnce(page("4096", false))
    .mockResolvedValueOnce(page("0", true));
  render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
  await screen.findByText(/Offset 0/);
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText(/Offset 4096/);
  expect(read.mock.calls[1]?.[0]).toMatchObject({
    receiptsRef,
    startOrdinal: "1",
    maxReceipts: "32",
    maxBytes: "65536",
  });
  expect(screen.queryByText(/Offset 0/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByText(/Offset 0/);
  expect(read.mock.calls[2]?.[0].startOrdinal).toBe("0");
});
it("aborts a pending page when its result view unmounts", async () => {
  let signal: AbortSignal | undefined;
  const read: ReceiptReader = (_params, value) => {
    signal = value;
    return new Promise(() => {});
  };
  const view = render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
  await waitFor(() => expect(signal).toBeDefined());
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
