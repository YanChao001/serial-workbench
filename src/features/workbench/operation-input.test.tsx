import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OperationInputView } from "./operation-input";
import { labels } from "./test-fixtures";
afterEach(cleanup);
it("loads authorized input only when expanded and clears the old body on a refused refresh", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "tx",
      value: { bytesBase64: "QVT//w==", writeWaitMs: "100" },
    })
    .mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
  render(<OperationInputView operationId="ai" read={read} labels={labels} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input ai" }),
  );
  await screen.findByText("41 54 FF FF");
  expect(read).toHaveBeenCalledWith("ai", expect.any(AbortSignal));
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input ai" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "PERMISSION_DENIED",
  );
  expect(screen.queryByText("41 54 FF FF")).not.toBeInTheDocument();
});
it("renders a redaction reason instead of inventing input and aborts on unmount", async () => {
  let signal: AbortSignal | undefined;
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "redacted",
      value: { reason: "sensitive_path" },
    })
    .mockImplementationOnce((_id: string, next: AbortSignal) => {
      signal = next;
      return new Promise(() => {});
    });
  const view = render(
    <OperationInputView operationId="ai" read={read} labels={labels} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input ai" }),
  );
  expect(await screen.findByText(/sensitive_path/)).toHaveTextContent(
    "Input redacted",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input ai" }),
  );
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
