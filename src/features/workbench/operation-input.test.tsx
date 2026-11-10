import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import type { OperationInput } from "@serial-workbench/contracts";
import {
  OperationInputView,
  type OperationInputReader,
} from "./operation-input";
import { labels } from "./test-fixtures";
vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

it.each([
  new Error("private/input/path: raw input body"),
  { code: "PERMISSION_DENIED", message: "private/input/path: raw input body" },
])(
  "reports input query faults safely once per attempt without inserting raw errors",
  async (reason) => {
    const read = vi.fn().mockRejectedValue(reason);
    const props = { operationId: "input-query-failure", read, labels };
    const view = render(<OperationInputView {...props} />);
    const button = screen.getByRole("button", {
      name: "View operation input input-query-failure",
    });
    await act(async () => fireEvent.click(button));
    expect(document.body).not.toHaveTextContent("private/input/path");
    expect(document.body).not.toHaveTextContent("raw input body");
    expect(document.body).not.toHaveTextContent("[object Object]");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.custom).toHaveBeenCalledOnce();
    const code = reason instanceof Error ? undefined : reason.code;
    expect(getUserLog()).toMatchObject([
      {
        module: "application",
        level: "error",
        message: labels.operationText.failure(code),
        count: 1,
      },
    ]);
    expect(JSON.stringify(getUserLog())).not.toMatch(
      /private\/input\/path|raw input body/,
    );
    view.rerender(<OperationInputView {...props} />);
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(button));
    expect(read).toHaveBeenCalledTimes(2);
    expect(toast.custom).toHaveBeenCalledTimes(2);
    expect(getUserLog()[0]?.count).toBe(2);
  },
);

it("loads authorized input only when expanded and clears the old body on a refused refresh", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "tx",
      value: { bytesBase64: "QVT//w==", writeWaitMs: "100" },
    })
    .mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "private/input/path",
    });
  render(<OperationInputView operationId="ai" read={read} labels={labels} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input ai" }),
  );
  await screen.findByText("41 54 FF FF");
  expect(read).toHaveBeenCalledWith("ai", expect.any(AbortSignal));
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "View operation input ai" }),
    ),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()[0]?.message).toBe(
    labels.operationText.failure("PERMISSION_DENIED"),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("private/input/path");
  expect(screen.queryByText("41 54 FF FF")).not.toBeInTheDocument();
});

it("routes faults to the original action module and shares only an actual terminal error identity", async () => {
  const read = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    message: "private/input/path",
    executionHostId: "input-failure-host",
    operationId: "actual-terminal-input-failure",
  });
  render(
    <OperationInputView
      operationId="queried-operation"
      actionId="capture.verify"
      read={read}
      labels={labels}
    />,
  );
  const button = screen.getByRole("button", {
    name: "View operation input queried-operation",
  });
  await act(async () => fireEvent.click(button));
  await act(async () => fireEvent.click(button));
  expect(read).toHaveBeenCalledTimes(2);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toMatchObject([
    {
      module: "capture",
      code: "PERMISSION_DENIED",
      context: labels.operationInput,
      message: labels.operationText.failure("PERMISSION_DENIED"),
      count: 1,
    },
  ]);
  expect(JSON.stringify(getUserLog())).not.toMatch(
    /private\/input\/path|queried-operation/,
  );
});

it("aborts an old input request on target switch and ignores its late authorized body", async () => {
  let previousSignal: AbortSignal | undefined;
  let finish!: (input: OperationInput) => void;
  const read = vi.fn<OperationInputReader>((_id, signal) => {
    previousSignal = signal;
    return new Promise<OperationInput>((resolve) => {
      finish = resolve;
    });
  });
  const view = render(
    <OperationInputView operationId="first" read={read} labels={labels} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View operation input first" }),
  );
  view.rerender(
    <OperationInputView operationId="second" read={read} labels={labels} />,
  );
  expect(previousSignal?.aborted).toBe(true);
  await act(async () =>
    finish({
      kind: "tx",
      value: { bytesBase64: "QVT//w==", writeWaitMs: "100" },
    }),
  );
  expect(screen.queryByText("41 54 FF FF")).not.toBeInTheDocument();
  expect(screen.queryByLabelText(labels.text)).not.toBeInTheDocument();
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toHaveLength(0);
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
