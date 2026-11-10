import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import type { CaptureTailResult } from "@serial-workbench/contracts";
import type {
  HostActionAvailability,
  HostActionCheckInput,
} from "@/providers/host-context";
import { CaptureTailPanel } from "./capture-tail-panel";
import { labels } from "./test-fixtures";
import { allowControlActions } from "./session-controls.test-fixtures";
vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});
const ref = { hostId: "host", kind: "capture", id: "A", revision: "1" };
function tail(id: string): CaptureTailResult {
  return {
    captureRef: { ...ref, id },
    sourceFingerprint: "a".repeat(64),
    state: "incomplete",
    verifiedPrefix: "2",
    containerComplete: false,
    sourceContinuous: false,
    firstRecord: "2",
    records: [
      {
        kind: "reference",
        recordOrdinal: "2",
        jsonBytes: "999999",
        jsonSha256: "b".repeat(64),
        recordRef: { ...ref, kind: "capture_record", id: "large" },
      },
    ],
  };
}
it.each([
  ["SOURCE_CHANGED", labels.captureChanged],
  ["REVISION_CONFLICT", labels.captureRevision],
  ["IO", labels.operationText.failure("IO")],
])(
  "notifies and logs a real %s read failure without inserting an inline error row",
  async (code, message) => {
    const read = vi
      .fn()
      .mockRejectedValue({ code, message: "C:/private/input-secret" });
    const props = {
      reference: ref,
      scopeKey: "safe-failure",
      ready: true,
      read,
      watchActions: allowControlActions,
      labels,
    };
    const view = render(<CaptureTailPanel {...props} />);
    await waitFor(() => expect(toast.custom).toHaveBeenCalledOnce());
    expect(getUserLog()).toMatchObject([
      { module: "capture", level: "error", code, message, count: 1 },
    ]);
    expect(JSON.stringify(getUserLog())).not.toContain("input-secret");
    expect(
      within(
        screen.getByRole("region", { name: labels.captureTail }),
      ).queryByRole("alert"),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("input-secret");
    view.rerender(<CaptureTailPanel {...props} reference={{ ...ref }} />);
    await act(async () => {});
    expect(read).toHaveBeenCalledOnce();
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()[0]?.count).toBe(1);
  },
);
it.each([
  ["CAPTURE_ACTIVE", labels.captureActive],
  ["PERMISSION_DENIED", labels.captureDenied],
])(
  "keeps initial %s as an ordinary state across reopening",
  async (code, message) => {
    const read = vi
      .fn()
      .mockRejectedValue({ code, message: "C:/private/input-secret" });
    const props = {
      reference: ref,
      scopeKey: "ordinary-state",
      ready: true,
      read,
      watchActions: allowControlActions,
      labels,
    };
    const first = render(<CaptureTailPanel {...props} />);
    expect(await screen.findByText(message)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.custom).not.toHaveBeenCalled();
    expect(getUserLog()).toEqual([]);
    first.unmount();
    render(<CaptureTailPanel {...props} />);
    expect(await screen.findByText(message)).toHaveAttribute("role", "status");
    expect(toast.custom).not.toHaveBeenCalled();
    expect(getUserLog()).toEqual([]);
  },
);
it("does not query or warn before initial capture permission is allowed", async () => {
  const read = vi.fn();
  const watchActions = (
    inputs: readonly HostActionCheckInput[],
    listener: (values: readonly HostActionAvailability[]) => void,
  ) => {
    listener(
      inputs.map((input) => ({
        input,
        error: null,
        result: { ...input, allowed: false },
      })),
    );
    return () => {};
  };
  render(
    <CaptureTailPanel
      reference={ref}
      scopeKey="not-authorized"
      ready
      read={read}
      watchActions={watchActions}
      labels={labels}
    />,
  );
  expect(await screen.findByText(labels.captureDenied)).toHaveAttribute(
    "role",
    "status",
  );
  expect(read).not.toHaveBeenCalled();
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
});
it("ignores an old read rejection after switching capture references", async () => {
  let rejectOld!: (reason: unknown) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<CaptureTailResult>((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockResolvedValueOnce(tail("B"));
  const props = {
    reference: ref,
    scopeKey: "old-A",
    ready: true,
    read,
    watchActions: allowControlActions,
    labels,
  };
  const view = render(<CaptureTailPanel {...props} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  view.rerender(
    <CaptureTailPanel
      {...props}
      reference={{ ...ref, id: "B" }}
      scopeKey="new-B"
    />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () =>
    rejectOld({ code: "SOURCE_CHANGED", message: "C:/private/input-secret" }),
  );
  expect(toast.custom).not.toHaveBeenCalled();
  expect(getUserLog()).toEqual([]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: labels.captureTail + " · " + labels.expand,
    }),
  ).toBeInTheDocument();
});
it("aborts replaced requests, keeps only the selected verified prefix and hides revoked content", async () => {
  const calls: {
    signal?: AbortSignal;
    resolve: (v: CaptureTailResult) => void;
  }[] = [];
  const read = vi.fn(
    (_ref: unknown, signal?: AbortSignal) =>
      new Promise<CaptureTailResult>((resolve) =>
        calls.push({ signal, resolve }),
      ),
  );
  let listener: (v: readonly HostActionAvailability[]) => void = () => {};
  let observed: readonly HostActionCheckInput[] = [];
  const watch = vi.fn(
    (inputs: readonly HostActionCheckInput[], next: typeof listener) => {
      observed = inputs;
      listener = next;
      next(
        inputs.map((input) => ({
          input,
          error: null,
          result: { ...input, allowed: true },
        })),
      );
      return () => {};
    },
  );
  const view = render(
    <StrictMode>
      <CaptureTailPanel
        reference={ref}
        scopeKey="A"
        ready
        read={read}
        watchActions={watch}
        labels={labels}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  const old = calls.at(-1)!;
  view.rerender(
    <StrictMode>
      <CaptureTailPanel
        reference={{ ...ref, id: "B" }}
        scopeKey="B"
        ready
        read={read}
        watchActions={watch}
        labels={labels}
      />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "B" }),
      expect.any(AbortSignal),
    ),
  );
  expect(old.signal?.aborted).toBe(true);
  await act(async () => {
    old.resolve(tail("A"));
    calls.at(-1)!.resolve(tail("B"));
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: labels.captureTail + " · " + labels.expand,
    }),
  );
  expect(await screen.findByText(/999999/)).toBeInTheDocument();
  expect(screen.getByText(labels.capturePartial)).toBeInTheDocument();
  act(() =>
    listener(observed.map((input) => ({ input, error: null, result: null }))),
  );
  expect(screen.queryByText(/999999/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: labels.captureTail }),
  ).not.toBeInTheDocument();
  act(() =>
    listener(
      observed.map((input) => ({
        input,
        error: null,
        result: { ...input, allowed: true },
      })),
    ),
  );
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(2));
  view.unmount();
  expect(calls.at(-1)?.signal?.aborted).toBe(true);
});
it("renders safe stable errors without raw host paths", async () => {
  const watch = (
    inputs: readonly HostActionCheckInput[],
    next: (v: readonly HostActionAvailability[]) => void,
  ) => {
    next(
      inputs.map((input) => ({
        input,
        error: null,
        result: { ...input, allowed: true },
      })),
    );
    return () => {};
  };
  render(
    <CaptureTailPanel
      reference={ref}
      scopeKey="error"
      ready
      read={vi.fn().mockRejectedValue({
        code: "SOURCE_CHANGED",
        message: "C:/secret/private",
      })}
      watchActions={watch}
      labels={labels}
    />,
  );
  await waitFor(() => expect(toast.custom).toHaveBeenCalledOnce());
  expect(getUserLog()).toMatchObject([
    {
      module: "capture",
      code: "SOURCE_CHANGED",
      message: labels.captureChanged,
    },
  ]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
});

it("keeps historical source identities, verified gaps and unknown TX settlement", async () => {
  const value = tail("A");
  const identity = {
    hostId: "original-host",
    instanceEpoch: "4",
    sessionId: "old-session",
    sessionEpoch: "9",
  };
  value.records = [
    {
      kind: "inline",
      record: {
        recordOrdinal: "1",
        entry: {
          kind: "reader_gap",
          value: {
            ...identity,
            reason: "reader_overflow",
            missingEventRange: { start: "2", end: "3" },
          },
        },
      },
    },
    {
      kind: "inline",
      record: {
        recordOrdinal: "2",
        entry: {
          kind: "tx_settlement",
          value: {
            hostId: identity.hostId,
            instanceEpoch: identity.instanceEpoch,
            receipt: {
              operationId: "unknown-write",
              sessionId: identity.sessionId,
              sessionEpoch: identity.sessionEpoch,
              outcome: "unknown",
              bytesBase64: "QQ==",
              byteStart: "0",
              byteEnd: "1",
              acceptedRanges: [],
              unknownRanges: [{ start: "0", end: "1" }],
              peerAcknowledged: false,
            },
          },
        },
      },
    },
  ];
  const watch = (
    inputs: readonly HostActionCheckInput[],
    next: (v: readonly HostActionAvailability[]) => void,
  ) => {
    next(
      inputs.map((input) => ({
        input,
        error: null,
        result: { ...input, allowed: true },
      })),
    );
    return () => {};
  };
  render(
    <CaptureTailPanel
      reference={ref}
      scopeKey="historical"
      ready
      read={vi.fn().mockResolvedValue(value)}
      watchActions={watch}
      labels={labels}
    />,
  );
  expect(await screen.findByText(/reader_overflow/)).toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: labels.txUnknownBytes }),
  ).toHaveTextContent(labels.unknown);
  fireEvent.click(
    screen.getByRole("button", {
      name: labels.captureTail + " · " + labels.expand,
    }),
  );
  expect(await screen.findByText(/unknown-write.*unknown/)).toBeInTheDocument();
  expect(screen.getByText(/original-host/)).toHaveTextContent("old-session");
});

it("keeps capture evidence in an on-demand popover without another content read", async () => {
  const value = tail("A");
  const read = vi.fn().mockResolvedValue(value);
  const watch = (
    inputs: readonly HostActionCheckInput[],
    next: (v: readonly HostActionAvailability[]) => void,
  ) => {
    next(
      inputs.map((input) => ({
        input,
        error: null,
        result: { ...input, allowed: true },
      })),
    );
    return () => {};
  };
  render(
    <CaptureTailPanel
      reference={ref}
      scopeKey="details"
      ready
      read={read}
      watchActions={watch}
      labels={labels}
    />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(screen.queryByText(value.sourceFingerprint)).not.toBeInTheDocument();
  expect(screen.queryByText(/999999/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: labels.capturePartial }),
  ).toHaveTextContent(labels.containerComplete + ": " + labels.captureNo);
  const trigger = screen.getByRole("button", {
    name: labels.captureTail + " · " + labels.expand,
  });
  trigger.focus();
  fireEvent.click(trigger);
  const details = await screen.findByRole("dialog", {
    name: labels.captureTail,
  });
  expect(details).toHaveTextContent(value.sourceFingerprint);
  expect(details).toHaveTextContent("999999");
  expect(details).toHaveTextContent(labels.capturePartial);
  expect(details).toHaveTextContent(labels.captureFingerprint);
  expect(details).toHaveTextContent(labels.verified);
  expect(details).toHaveTextContent(labels.containerComplete);
  expect(details).toHaveTextContent(labels.sourceContinuous);
  expect(details).toHaveTextContent(labels.captureFirstRecord);
  expect(
    screen.getByRole("region", { name: labels.captureTail }),
  ).not.toContainElement(details);
  expect(read).toHaveBeenCalledOnce();
  fireEvent.keyDown(details, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(read).toHaveBeenCalledOnce();
});
