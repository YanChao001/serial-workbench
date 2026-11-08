import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { Operation } from "@serial-workbench/contracts";
import type { HostInvocation } from "@/providers/host-context";
import {
  UnsavedWorkContext,
  type UnsavedWork,
} from "@/providers/unsaved-work-context";
import { SessionControls } from "./session-controls";
import { operation, session } from "./test-fixtures";
import {
  allowControlActions,
  observeControlActions,
  controlLabels,
  target,
} from "./session-controls.test-fixtures";

afterEach(cleanup);
const setup = (value = session()) => {
  const invoke = vi.fn().mockResolvedValue(operation());
  const props = {
    session: value,
    target,
    operations: [],
    watchActions: allowControlActions,
    labels: controlLabels,
    invoke,
  };
  return { invoke, props, ...render(<SessionControls {...props} />) };
};

it("registers only the unsubmitted configuration and aborts a pending apply on unmount in StrictMode", async () => {
  const work = new Map<string, UnsavedWork>();
  let finish: ((value: Operation) => void) | undefined;
  let signal: AbortSignal | undefined;
  const invoke = vi.fn(
    (_input: HostInvocation, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<Operation>((resolve) => {
        finish = resolve;
      });
    },
  );
  const view = render(
    <StrictMode>
      <UnsavedWorkContext.Provider
        value={{
          requestLeave: async () => true,
          releaseScope: () => {},
          register: (value) => {
            work.set(value.id, value);
          },
          unregister: (id) => {
            work.delete(id);
          },
        }}
      >
        <SessionControls
          session={session()}
          target={target}
          operations={[]}
          watchActions={allowControlActions}
          labels={controlLabels}
          invoke={invoke}
        />
      </UnsavedWorkContext.Provider>
    </StrictMode>,
  );
  expect([...work.values()].some((value) => value.dirty)).toBe(false);
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "57600" },
  });
  expect([...work.values()].some((value) => value.dirty)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  finish?.(operation());
  await Promise.resolve();
  expect(work.size).toBe(0);
});

it("submits a custom baud and independent timeouts with the exact session revision", async () => {
  const { invoke } = setup();
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "250000" },
  });
  fireEvent.change(screen.getByLabelText("Read wait (ms)"), {
    target: { value: "11" },
  });
  fireEvent.change(screen.getByLabelText("Write wait (ms)"), {
    target: { value: "22" },
  });
  fireEvent.change(screen.getByLabelText("Reconnect backoff (ms)"), {
    target: { value: "33" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    actionId: "session.configure",
    target,
    expectedRevision: "1",
    executionMode: "interactive",
    params: {
      requested: {
        baudRate: "250000",
        readWaitMs: "11",
        writeWaitMs: "22",
        reconnectBackoffMs: "33",
      },
    },
  });
});

it("blocks invalid numeric models and respects configuration and unknown control gates", () => {
  const { invoke, props, rerender } = setup();
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "0" },
  });
  expect(
    screen.getByRole("button", { name: "Apply configuration" }),
  ).toBeDisabled();
  rerender(
    <SessionControls
      {...props}
      session={{
        ...session(),
        txGate: "control_unknown",
        controlState: "unknown",
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Finite BREAK" })).toBeDisabled();
  expect(invoke).not.toHaveBeenCalled();
});

it("shows requested configuration separately from unknown actual fields and real readback", () => {
  const result = {
    ...operation(),
    actionId: "session.configure",
    target,
    result: {
      kind: "configuration" as const,
      value: {
        requested: session().configuration,
        fields: [{ field: "baudRate", status: "unknown" as const }],
        readback: { baudRate: "57600" },
        revision: "2",
        boundaryEventSeq: "9",
        txGate: "ready" as const,
      },
    },
  };
  render(
    <SessionControls
      session={session()}
      target={target}
      operations={[result]}
      watchActions={allowControlActions}
      labels={controlLabels}
      invoke={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("table", { name: "Configuration receipt" }),
  ).toHaveTextContent("115200");
  expect(
    screen.getByRole("table", { name: "Configuration receipt" }),
  ).toHaveTextContent("unknown");
  expect(screen.getByLabelText("Driver readback")).toHaveTextContent("57600");
});

it("uses real typed control, finite BREAK, purge, drain and boundary actions", async () => {
  const { invoke } = setup();
  for (const name of [
    "DTR on",
    "RTS off",
    "Finite BREAK",
    "Purge queues",
    "Drain",
  ]) {
    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name })).not.toBeDisabled(),
    );
  }
  fireEvent.change(screen.getByLabelText("Through operation"), {
    target: { value: "transmit-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Wait boundary" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(6));
  expect(invoke.mock.calls.map((call) => call[0].actionId)).toEqual([
    "session.control",
    "session.control",
    "session.break",
    "session.purge",
    "tx.drain",
    "tx.waitBoundary",
  ]);
  expect(invoke.mock.calls[0]?.[0].params).toEqual({
    line: "dtr",
    value: true,
  });
  expect(invoke.mock.calls[1]?.[0].params).toEqual({
    line: "rts",
    value: false,
  });
  expect(invoke.mock.calls[2]?.[0].params).toEqual({ durationMs: "100" });
  expect(
    screen.getByText("CTS / DSR / RI / CD sampling is unavailable"),
  ).toBeVisible();
});

it("disables read-only and flow-owned line controls and displays shared BREAK uncertainty", () => {
  const current = session();
  const { props, rerender } = setup({
    ...current,
    configuration: { ...current.configuration, flowControl: "rtsCts" },
  });
  expect(screen.getByRole("button", { name: "RTS on" })).toBeDisabled();
  const receipt = {
    ...operation(),
    target,
    actionId: "session.break",
    result: {
      kind: "break" as const,
      value: {
        assert: { status: "confirmed" as const, at: "2026-11-08T01:00:00Z" },
        clear: { status: "unknown" as const, at: "2026-11-08T01:00:01Z" },
      },
    },
  };
  rerender(
    <SessionControls
      {...props}
      session={{ ...props.session, readOnly: true }}
      operations={[receipt]}
    />,
  );
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  expect(screen.getByLabelText("BREAK receipt")).toHaveTextContent("unknown");
  expect(
    screen.getByText(
      "Stopping a wait leaves the line outcome unconfirmed; inspect the receipt.",
    ),
  ).toBeVisible();
});

it("keeps unknown or denied actions non-executable while drafts stay editable", async () => {
  const observer = observeControlActions();
  const invoke = vi.fn();
  const work = new Map<string, UnsavedWork>();
  render(
    <UnsavedWorkContext.Provider
      value={{
        requestLeave: async () => true,
        releaseScope: () => {},
        register: (value) => {
          work.set(value.id, value);
        },
        unregister: (id) => {
          work.delete(id);
        },
      }}
    >
      <SessionControls
        session={session()}
        target={target}
        operations={[]}
        labels={controlLabels}
        invoke={invoke}
        watchActions={observer.watchActions}
      />
    </UnsavedWorkContext.Provider>,
  );
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "57600" },
  });
  fireEvent.change(screen.getByLabelText("Through operation"), {
    target: { value: "transmit-1" },
  });
  expect(screen.getByLabelText("Baud rate")).toBeEnabled();
  for (const name of [
    "Apply configuration",
    "DTR on",
    "Finite BREAK",
    "Purge queues",
    "Drain",
    "Wait boundary",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name }));
  }
  const latest = observer.subscriptions.at(-1)!;
  act(() => observer.publish(latest, () => false));
  for (const name of [
    "Apply configuration",
    "DTR on",
    "Finite BREAK",
    "Purge queues",
    "Drain",
    "Wait boundary",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name }));
  }
  await expect(
    [...work.values()][0]?.save?.(new AbortController().signal),
  ).rejects.toThrow("Unavailable");
  expect(invoke).not.toHaveBeenCalled();
});

it("authorizes each exact action independently with current requested parameters", async () => {
  const observer = observeControlActions();
  const { props, rerender, invoke } = setup();
  rerender(<SessionControls {...props} watchActions={observer.watchActions} />);
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "57600" },
  });
  fireEvent.change(screen.getByLabelText("Through operation"), {
    target: { value: "transmit-9" },
  });
  const latest = observer.subscriptions.at(-1)!;
  expect(latest.inputs).toHaveLength(9);
  expect(latest.inputs).toEqual(
    expect.arrayContaining([
      {
        actionId: "session.configure",
        params: {
          requested: { ...session().configuration, baudRate: "57600" },
        },
        target,
      },
      { actionId: "session.break", params: { durationMs: "100" }, target },
      {
        actionId: "session.purge",
        params: { direction: "both", scope: "both" },
        target,
      },
      { actionId: "tx.drain", params: { writeWaitMs: "100" }, target },
      {
        actionId: "tx.waitBoundary",
        params: { throughOperationId: "transmit-9", queueWaitMs: "1000" },
        target,
      },
    ]),
  );
  act(() =>
    observer.publish(
      latest,
      (input) =>
        input.actionId === "session.control" &&
        input.params.line === "dtr" &&
        input.params.value === true,
    ),
  );
  expect(screen.getByRole("button", { name: "DTR on" })).toBeEnabled();
  for (const name of [
    "Apply configuration",
    "DTR off",
    "RTS on",
    "Finite BREAK",
    "Purge queues",
    "Drain",
    "Wait boundary",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  fireEvent.click(screen.getByRole("button", { name: "DTR on" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    actionId: "session.control",
    params: { line: "dtr", value: true },
    target,
    expectedRevision: "1",
  });
});

it.each([
  ["Baud rate", "57600", "Apply configuration", "session.configure"],
  ["BREAK duration (ms)", "200", "Finite BREAK", "session.break"],
  ["Purge scope", "driver", "Purge queues", "session.purge"],
  ["Purge direction", "tx", "Purge queues", "session.purge"],
  ["Drain · Write wait (ms)", "23", "Drain", "tx.drain"],
  ["Queue wait (ms)", "24", "Wait boundary", "tx.waitBoundary"],
  ["Through operation", "transmit-2", "Wait boundary", "tx.waitBoundary"],
])(
  "clears old allowed observation when %s changes",
  (label, value, button, actionId) => {
    const observer = observeControlActions();
    const { props, rerender, invoke } = setup();
    rerender(
      <SessionControls {...props} watchActions={observer.watchActions} />,
    );
    fireEvent.change(screen.getByLabelText("Baud rate"), {
      target: { value: "230400" },
    });
    fireEvent.change(screen.getByLabelText("Through operation"), {
      target: { value: "transmit-1" },
    });
    const old = observer.subscriptions.at(-1)!;
    act(() => observer.publish(old, (input) => input.actionId === actionId));
    expect(screen.getByRole("button", { name: button })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(screen.getByRole("button", { name: button })).toBeDisabled();
    act(() => observer.publish(old, () => true));
    expect(screen.getByRole("button", { name: button })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(invoke).not.toHaveBeenCalled();
    act(() =>
      observer.publish(
        observer.subscriptions.at(-1)!,
        (input) => input.actionId === actionId,
      ),
    );
    expect(screen.getByRole("button", { name: button })).toBeEnabled();
  },
);

it("isolates old target and epoch callbacks and disposes StrictMode observations", async () => {
  const observer = observeControlActions();
  const props = {
    session: session(),
    target,
    operations: [],
    labels: controlLabels,
    invoke: vi.fn().mockResolvedValue(operation()),
    watchActions: observer.watchActions,
  };
  const view = render(
    <StrictMode>
      <SessionControls {...props} />
    </StrictMode>,
  );
  expect(observer.subscriptions.filter((item) => !item.stopped)).toHaveLength(
    1,
  );
  const first = observer.subscriptions.at(-1)!;
  act(() => observer.publish(first, () => true));
  expect(screen.getByRole("button", { name: "DTR on" })).toBeEnabled();
  view.rerender(
    <StrictMode>
      <SessionControls
        {...props}
        target={{ ...target, hostId: "other-host" }}
      />
    </StrictMode>,
  );
  expect(first.stopped).toBe(true);
  act(() => observer.publish(first, () => true));
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  const second = observer.subscriptions.at(-1)!;
  act(() => observer.publish(second, () => true));
  view.rerender(
    <StrictMode>
      <SessionControls
        {...props}
        session={{ ...session(), sessionEpoch: "2", revision: "7" }}
        target={{ ...target, sessionEpoch: "2" }}
      />
    </StrictMode>,
  );
  act(() => observer.publish(second, () => true));
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  const current = observer.subscriptions.at(-1)!;
  expect(current.inputs[0]?.target.sessionEpoch).toBe("2");
  act(() => observer.publish(current, () => true));
  fireEvent.click(screen.getByRole("button", { name: "DTR on" }));
  await waitFor(() => expect(props.invoke).toHaveBeenCalledOnce());
  expect(props.invoke.mock.calls[0]?.[0]).toMatchObject({
    actionId: "session.control",
    params: { line: "dtr", value: true },
    target: { ...target, sessionEpoch: "2" },
    expectedRevision: "7",
  });
  view.unmount();
  expect(observer.subscriptions.every((item) => item.stopped)).toBe(true);
  act(() => observer.publish(current, () => true));
  expect(props.invoke).toHaveBeenCalledOnce();
});

it("clears previous availability when the catalog-filtered watcher changes", () => {
  const { props, rerender, invoke } = setup();
  expect(screen.getByRole("button", { name: "DTR on" })).toBeEnabled();
  const observer = observeControlActions();
  rerender(<SessionControls {...props} watchActions={observer.watchActions} />);
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "DTR on" }));
  expect(invoke).not.toHaveBeenCalled();
});

it("samples actual modem inputs on opening the controls", async () => {
  const readInputs = vi.fn().mockResolvedValue({
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "2026-11-08T00:00:00Z",
    sampledMonoNs: "123",
    cts: true,
    dsr: false,
    ri: true,
    cd: false,
  });
  render(
    <SessionControls
      session={session()}
      target={target}
      operations={[]}
      labels={controlLabels}
      invoke={vi.fn()}
      watchActions={allowControlActions}
      {...{ readInputs }}
    />,
  );
  await waitFor(() =>
    expect(readInputs).toHaveBeenCalledWith(target, expect.any(AbortSignal)),
  );
  expect(await screen.findByText("2026-11-08T00:00:00Z")).toBeInTheDocument();
});

it("polls inputs every 500ms with manual refresh, one inflight read, and unmount cancellation", async () => {
  vi.useFakeTimers();
  try {
    const sample = {
      sessionId: "session",
      sessionEpoch: "1",
      sampledAt: "sample-time",
      sampledMonoNs: "123",
      cts: true,
      dsr: false,
      ri: true,
      cd: false,
    };
    let finish!: (value: typeof sample) => void;
    let pending: AbortSignal | undefined;
    const readInputs = vi
      .fn()
      .mockResolvedValueOnce(sample)
      .mockResolvedValueOnce(sample)
      .mockImplementationOnce((_target: unknown, signal?: AbortSignal) => {
        pending = signal;
        return new Promise((done) => {
          finish = done;
        });
      });
    const view = render(
      <SessionControls
        session={session()}
        target={target}
        operations={[]}
        labels={{
          ...controlLabels,
          refreshInputs: "Refresh inputs",
          inputSignals: "Input signals",
          sampledAt: "Sampled at",
          on: "On",
          off: "Off",
        }}
        invoke={vi.fn()}
        watchActions={allowControlActions}
        {...{ readInputs }}
      />,
    );
    await act(async () => {});
    expect(readInputs).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(readInputs).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh inputs" }));
    await act(async () => {});
    expect(readInputs).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(readInputs).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(pending?.aborted).toBe(true);
    await act(async () => finish(sample));
  } finally {
    vi.useRealTimers();
  }
});
it("clears old input booleans on an unsupported result and retries only after epoch change", async () => {
  vi.useFakeTimers();
  try {
    const sample = {
      sessionId: "session",
      sessionEpoch: "1",
      sampledAt: "sample-time",
      sampledMonoNs: "123",
      cts: true,
      dsr: false,
      ri: true,
      cd: false,
    };
    const readInputs = vi
      .fn()
      .mockResolvedValueOnce(sample)
      .mockRejectedValueOnce(
        Object.assign(new Error("not supported"), {
          code: "UNSUPPORTED_CAPABILITY",
        }),
      )
      .mockResolvedValue({
        ...sample,
        sessionEpoch: "2",
        sampledAt: "new-sample-time",
      });
    const props = {
      target,
      operations: [],
      labels: {
        ...controlLabels,
        refreshInputs: "Refresh inputs",
        inputSignals: "Input signals",
        sampledAt: "Sampled at",
        on: "On",
        off: "Off",
      },
      invoke: vi.fn(),
      watchActions: allowControlActions,
      readInputs,
    };
    const view = render(<SessionControls {...props} session={session()} />);
    await act(async () => {});
    expect(screen.getByText("sample-time")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByText("sample-time")).not.toBeInTheDocument();
    expect(screen.getByLabelText("CTS")).toHaveTextContent(
      controlLabels.unknown,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readInputs).toHaveBeenCalledTimes(2);
    view.rerender(
      <SessionControls
        {...props}
        session={{ ...session(), sessionEpoch: "2" }}
        target={{ ...target, sessionEpoch: "2" }}
      />,
    );
    await act(async () => {});
    expect(readInputs).toHaveBeenCalledTimes(3);
    expect(screen.getByText("new-sample-time")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("discards a late old-epoch input sample and clears all booleans while disconnected", async () => {
  const sample = {
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "old-sample",
    sampledMonoNs: "123",
    cts: true,
    dsr: false,
    ri: true,
    cd: false,
  };
  let finish!: (value: typeof sample) => void;
  let oldSignal: AbortSignal | undefined;
  const readInputs = vi
    .fn()
    .mockImplementationOnce((_target: unknown, signal?: AbortSignal) => {
      oldSignal = signal;
      return new Promise((done) => {
        finish = done;
      });
    })
    .mockResolvedValue({
      ...sample,
      sessionEpoch: "2",
      sampledAt: "new-sample",
    });
  const props = {
    target,
    operations: [],
    labels: controlLabels,
    invoke: vi.fn(),
    watchActions: allowControlActions,
    readInputs,
  };
  const view = render(<SessionControls {...props} session={session()} />);
  await waitFor(() => expect(readInputs).toHaveBeenCalledOnce());
  view.rerender(
    <SessionControls
      {...props}
      session={{ ...session(), sessionEpoch: "2" }}
      target={{ ...target, sessionEpoch: "2" }}
    />,
  );
  await screen.findByText("new-sample");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish(sample));
  expect(screen.queryByText("old-sample")).not.toBeInTheDocument();
  view.rerender(
    <SessionControls
      {...props}
      session={{ ...session(), sessionEpoch: "2", state: "disconnected" }}
      target={{ ...target, sessionEpoch: "2" }}
    />,
  );
  expect(screen.queryByText("new-sample")).not.toBeInTheDocument();
  expect(screen.getByLabelText("CTS")).toHaveTextContent(controlLabels.unknown);
});
