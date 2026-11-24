import type { Operation, Target } from "@serial-workbench/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { createTranslator } from "@/i18n/translate";
import { I18nContext } from "@/providers/i18n-context";
import type { HostContextValue } from "@/providers/host-context";
import type { OperationInputReader } from "./operation-input";
import { SendHistoryPanel } from "./send-history-panel";
import { filterHistoryRows, historyRows } from "./send-history-model";
import { operation, session, labels } from "./test-fixtures";

const target: Target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};

function tx(id: string, overrides: Partial<Operation> = {}): Operation {
  return { ...operation(id), actionId: "session.tx", target, ...overrides };
}

function result(id: string, bytesBase64: string, complete: boolean): Operation {
  return tx(id, {
    result: {
      kind: "tx",
      value: {
        operationId: id,
        sessionId: "session",
        sessionEpoch: "1",
        outcome: complete ? "accepted" : "partial",
        bytesBase64,
        byteStart: "50",
        byteEnd: "52",
        acceptedRanges: [{ start: "0", end: complete ? "2" : "1" }],
        unknownRanges: [],
        peerAcknowledged: false,
      },
    },
  });
}

function setup() {
  const read = vi.fn<OperationInputReader>(async (id) => ({
    kind: "tx",
    value: {
      bytesBase64: id === "old-first" ? "AP8=" : "QQA=",
      writeWaitMs: "100",
    },
  }));
  let sends = 0;
  const send = vi.fn(async (_bytes: Uint8Array) =>
    tx("new-" + ++sends, { state: "queued" }),
  );
  const wait = vi.fn<HostContextValue["waitForOperation"]>(async (operation) =>
    result(
      operation.operationId,
      operation.operationId === "new-1" ? "AP8=" : "QQA=",
      true,
    ),
  );
  const permissionObservers = new Set<(allowed: boolean) => void>();
  const watch: HostContextValue["watchActions"] = (inputs, notify) => {
    const observe = (allowed: boolean) =>
      notify(
        inputs.map((input) => ({
          input,
          error: null,
          result: {
            actionId: input.actionId,
            target: input.target,
            allowed,
          },
        })),
      );
    permissionObservers.add(observe);
    observe(true);
    return () => {
      permissionObservers.delete(observe);
    };
  };
  render(
    <I18nContext.Provider value={{ language: "en", t: createTranslator(en) }}>
      <SendHistoryPanel
        rows={[
          { operation: tx("old-first"), port: "COM9" },
          { operation: tx("old-second"), port: "COM5" },
        ]}
        pinned={new Set()}
        onPin={vi.fn()}
        destination={{ target, port: "COM12", send, wait }}
        hostId="host"
        read={read}
        watchActions={watch}
        labels={labels}
      />
    </I18nContext.Provider>,
  );
  return { read, send, wait, permissionObservers, user: userEvent.setup() };
}

async function preview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /old-first/ }));
  await user.click(screen.getByRole("checkbox", { name: /old-second/ }));
  const button = screen.getByRole("button", { name: "Preview selected bytes" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  return screen.findByRole("button", { name: "Resend in preview order" });
}

afterEach(cleanup);

it("orders pinned records first and only searches terminal sends from this Host", () => {
  const first = tx("old-first", { acceptedAt: "2026-11-24T00:00:00Z" });
  const second = tx("old-second", { acceptedAt: "2026-11-24T01:00:00Z" });
  const rows = historyRows(
    [
      second,
      { ...first, operationId: "other-host", executionHostId: "other" },
      { ...first, operationId: "waiting", state: "queued" },
      operation("other-action"),
      first,
    ],
    [session()],
    [],
    "host",
    new Set(["old-first"]),
  );
  expect(rows.map(({ operation }) => operation.operationId)).toEqual([
    "old-first",
    "old-second",
  ]);
  expect(filterHistoryRows(rows, " DEVICE ")).toEqual(rows);
  expect(filterHistoryRows(rows, "01:00:00")).toEqual([rows[1]]);
});

it("previews original bytes without sending and confirms each new write before the next", async () => {
  const { user, read, send, wait } = setup();
  const submit = await preview(user);
  expect(screen.getByText(/COM12 · session/)).toBeVisible();
  expect(screen.getByText("00 FF")).toBeVisible();
  expect(send).not.toHaveBeenCalled();
  await user.click(submit);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "All 2 writes confirmed.",
    ),
  );
  expect(read.mock.calls.map(([id]) => id)).toEqual([
    "old-first",
    "old-second",
    "old-first",
    "old-second",
  ]);
  expect(send.mock.calls.map(([bytes]) => [...bytes])).toEqual([
    [0, 255],
    [65, 0],
  ]);
  expect(wait.mock.invocationCallOrder[0]).toBeLessThan(
    send.mock.invocationCallOrder[1] ?? -1,
  );
});

it("hides preview on source permission revocation and never resends it", async () => {
  const { user, send, permissionObservers } = setup();
  await preview(user);
  act(() => permissionObservers.forEach((observe) => observe(false)));
  expect(screen.queryByText("00 FF")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Resend in preview order" }),
  ).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});

it("stops on a partial receipt and reports the admitted operation", async () => {
  const { user, send, wait } = setup();
  const submit = await preview(user);
  wait.mockImplementationOnce(async (operation) =>
    result(operation.operationId, "AP8=", false),
  );
  await user.click(submit);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Batch stopped after 0 confirmed writes.",
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Last admitted operation new-1",
  );
  expect(send).toHaveBeenCalledOnce();
});

it("revalidates previewed contents and sends nothing when the input has changed", async () => {
  const { user, read, send } = setup();
  const submit = await preview(user);
  read.mockResolvedValueOnce({
    kind: "tx",
    value: { bytesBase64: "AAA=", writeWaitMs: "100" },
  });
  await user.click(submit);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Batch stopped after 0 confirmed writes.",
    ),
  );
  expect(send).not.toHaveBeenCalled();
});

it("stops waiting on request and keeps the admitted operation for reconciliation", async () => {
  const { user, send, wait } = setup();
  const submit = await preview(user);
  wait.mockImplementationOnce(
    (_operation, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  await user.click(submit);
  await waitFor(() => expect(wait).toHaveBeenCalledOnce());
  await user.click(
    screen.getByRole("button", { name: "Stop remaining sends" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Batch stopped after 0 confirmed writes.",
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Last admitted operation new-1",
  );
  expect(send).toHaveBeenCalledOnce();
});
