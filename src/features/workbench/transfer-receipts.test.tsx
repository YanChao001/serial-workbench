import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import type { FileTransferReceiptsResult } from "@serial-workbench/contracts";
import { TransferReceipts, type ReceiptReader } from "./transfer-receipts";
import { labels } from "./test-fixtures";
vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearUserLog();
});
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

it("reports a page query failure once with a safe localized summary and no raw path", async () => {
  const read = vi.fn<ReceiptReader>().mockRejectedValueOnce(
    Object.assign(new Error("private/receipt/path?token=private-value"), {
      code: "PERMISSION_DENIED",
    }),
  );
  const view = render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.receipt })),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toMatchObject([
    {
      module: "transfer",
      code: "PERMISSION_DENIED",
      message: labels.operationText.failure("PERMISSION_DENIED"),
      count: 1,
    },
  ]);
  expect(document.body).not.toHaveTextContent("private/receipt/path");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.rerender(
    <TransferReceipts
      receiptsRef={{ ...receiptsRef }}
      read={read}
      labels={labels}
    />,
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: labels.retry })).toBeEnabled();
});

it("localizes receipt outcomes and retains exact ranges in explicit details without exposing backend messages", async () => {
  const result = { ...page("4096", false), count: "1", nextOrdinal: "1" };
  result.receipts[0]!.receipt = {
    ...result.receipts[0]!.receipt,
    outcome: "partial",
    bytesBase64: "QUI=",
    byteEnd: "4098",
    unknownRanges: [{ start: "4097", end: "4098" }],
    backendError: {
      code: "IO",
      message: "private/backend/path",
      retryable: false,
    },
  };
  const read = vi.fn<ReceiptReader>().mockResolvedValue(result);
  render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.receipt })),
  );
  expect(
    screen.getByText(`${labels.partial} [4096, 4098)`),
  ).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("private/backend/path");
  expect(
    screen.getByText(labels.operationText.failure("IO")),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: labels.operationText.details }),
  );
  const details = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: labels.operationText.details,
  });
  const value: unknown = JSON.parse(details.value);
  expect(value).toMatchObject({
    sourceOffset: "4096",
    receipt: {
      byteStart: "4096",
      byteEnd: "4098",
      unknownRanges: [{ start: "4097", end: "4098" }],
      backendError: { code: "IO", retryable: false },
    },
  });
  expect(details.value).not.toContain("private/backend/path");
});

it("clears authorized content on a refused page read and retries that exact cursor explicitly", async () => {
  const read = vi
    .fn<ReceiptReader>()
    .mockResolvedValueOnce(page("0", true))
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "private/receipt/source",
    })
    .mockResolvedValueOnce(page("4096", false));
  render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.receipt }));
  await screen.findByText("Offset 0");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: labels.nextPage })),
  );
  expect(screen.queryByText("Offset 0")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: labels.retry })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: labels.previousPage }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: labels.nextPage })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: labels.retry }));
  await screen.findByText("Offset 4096");
  expect(read.mock.calls[2]?.[0].startOrdinal).toBe("1");
  expect(
    screen.getByRole("button", { name: labels.previousPage }),
  ).toBeEnabled();
});

it("drops a pending page when the source changes and never publishes its late body", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: FileTransferReceiptsResult) => void;
  const read = vi
    .fn<ReceiptReader>()
    .mockImplementationOnce((_params, requestSignal) => {
      signal = requestSignal;
      return new Promise<FileTransferReceiptsResult>((resolve) => {
        finish = resolve;
      });
    });
  const view = render(
    <TransferReceipts receiptsRef={receiptsRef} read={read} labels={labels} />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.receipt }));
  expect(signal?.aborted).toBe(false);
  const nextReference = { ...receiptsRef, id: "next-receipts", revision: "2" };
  view.rerender(
    <TransferReceipts
      receiptsRef={nextReference}
      read={read}
      labels={labels}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(page("4096", false)));
  expect(screen.queryByText("Offset 4096")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: labels.receipt })).toBeEnabled();
  expect(toast.custom).not.toHaveBeenCalled();
});
