import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import type { Operation } from "@serial-workbench/contracts";
import type { HostInvocation } from "@/providers/host-context";
import {
  UnsavedWorkContext,
  type UnsavedWork,
} from "@/providers/unsaved-work-context";
import { SessionControls } from "./session-controls";
import { CONFIG_FIELDS } from "./serial-configuration";
import { operation, session } from "./test-fixtures";
import {
  allowControlActions,
  observeControlActions,
  controlLabels,
  target,
} from "./session-controls.test-fixtures";

beforeEach(() => render(<Toaster />));
afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
});
async function selectOption(label: string, name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name }));
}
it("opens themed queue selectors and applies only the option the user chooses", async () => {
  const { invoke } = setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Purge direction" }));
  const directions = screen.getByRole("listbox");
  expect(within(directions).getAllByRole("option")).toHaveLength(3);
  await user.click(
    within(directions).getByRole("option", {
      name: controlLabels.tx,
    }),
  );
  expect(
    screen.getByRole("combobox", { name: "Purge direction" }),
  ).toHaveTextContent(controlLabels.tx);
  await user.click(screen.getByRole("combobox", { name: "Purge scope" }));
  await user.click(screen.getByRole("option", { name: controlLabels.driver }));
  expect(
    screen.getByRole("combobox", { name: "Purge scope" }),
  ).toHaveTextContent(controlLabels.driver);
  expect(invoke).not.toHaveBeenCalled();
});
it("closes a portalled queue selector when the session becomes read-only and does not reopen it on recovery", async () => {
  const { props, rerender, invoke } = setup();
  const user = userEvent.setup();
  const scope = screen.getByRole("combobox", { name: "Purge scope" });
  scope.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  rerender(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      session={{ ...props.session, readOnly: true }}
    />,
  );
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(scope).toBeDisabled();
  rerender(
    <SessionControls waitForOperation={async (value) => value} {...props} />,
  );
  expect(scope).toBeEnabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(scope).toHaveTextContent(controlLabels.both);
  expect(invoke).not.toHaveBeenCalled();
});
it("keeps local parameters discard-only and confirms only matching applied fields after a terminal receipt", async () => {
  const work = new Map<string, UnsavedWork>();
  let finish!: (value: Operation) => void;
  const requested = {
    ...session().configuration,
    baudRate: "57600",
    readWaitMs: "23",
  };
  const admitted = {
    ...operation(),
    actionId: "session.configure",
    target,
    state: "queued" as const,
  };
  const invoke = vi.fn().mockResolvedValue(admitted);
  const onConfigurationApplied = vi.fn();
  const waitForOperation = vi.fn(
    () =>
      new Promise<Operation>((resolve) => {
        finish = resolve;
      }),
  );
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
        watchActions={allowControlActions}
        waitForOperation={waitForOperation}
        onConfigurationApplied={onConfigurationApplied}
      />
    </UnsavedWorkContext.Provider>,
  );
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "57600" },
  });
  fireEvent.change(screen.getByLabelText("Read wait (ms)"), {
    target: { value: "23" },
  });
  expect([...work.values()][0]?.save).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
  await waitFor(() => expect(waitForOperation).toHaveBeenCalledOnce());
  expect([...work.values()][0]?.dirty).toBe(true);
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "38400" },
  });
  await act(async () =>
    finish({
      ...admitted,
      state: "succeeded",
      result: {
        kind: "configuration",
        value: {
          requested,
          fields: [
            { field: "baudRate", status: "applied", actual: "57600" },
            { field: "readWaitMs", status: "unknown" },
          ],
          readback: { baudRate: "57600" },
          revision: "2",
          boundaryEventSeq: "9",
          txGate: "ready",
        },
      },
    }),
  );
  expect(screen.getByLabelText("Baud rate")).toHaveValue("38400");
  expect(screen.getByLabelText("Read wait (ms)")).toHaveValue("23");
  expect([...work.values()][0]?.dirty).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset configuration" }));
  expect(screen.getByLabelText("Baud rate")).toHaveValue("57600");
  expect(screen.getByLabelText("Read wait (ms)")).toHaveValue("100");
  expect(invoke).toHaveBeenCalledOnce();
  expect(onConfigurationApplied).not.toHaveBeenCalled();
});

it("remembers parameters only after every requested field has a matching applied terminal receipt", async () => {
  const requested = { ...session().configuration, baudRate: "57600" };
  const admitted: Operation = {
    ...operation(),
    actionId: "session.configure",
    target,
    state: "queued",
  };
  const terminal = {
    ...admitted,
    state: "succeeded" as const,
    result: {
      kind: "configuration" as const,
      value: {
        requested,
        fields: CONFIG_FIELDS.map((field) => ({
          field,
          status: "applied" as const,
          actual: requested[field],
        })),
        readback: {},
        revision: "2",
        boundaryEventSeq: "9",
        txGate: "ready" as const,
      },
    },
  };
  let finish!: (value: Operation) => void;
  const waitForOperation = vi.fn(
    () =>
      new Promise<Operation>((resolve) => {
        finish = resolve;
      }),
  );
  const onConfigurationApplied = vi.fn();
  render(
    <SessionControls
      session={session()}
      target={target}
      operations={[]}
      labels={controlLabels}
      invoke={vi.fn().mockResolvedValue(admitted)}
      watchActions={allowControlActions}
      waitForOperation={waitForOperation}
      onConfigurationApplied={onConfigurationApplied}
    />,
  );
  fireEvent.change(screen.getByLabelText("Baud rate"), {
    target: { value: "57600" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
  await waitFor(() => expect(waitForOperation).toHaveBeenCalledOnce());
  expect(onConfigurationApplied).not.toHaveBeenCalled();
  await act(async () => finish(terminal));
  expect(onConfigurationApplied).toHaveBeenCalledExactlyOnceWith(requested);
});

it.each([
  "failed",
  "wrong-target",
  "wrong-operation",
  "wrong-action",
  "wrong-configuration",
  "queued",
])(
  "retains the requested draft after %s configuration result",
  async (failure) => {
    const requested = { ...session().configuration, baudRate: "57600" };
    const admitted: Operation = {
      ...operation(),
      actionId: "session.configure",
      target,
      state: "queued",
    };
    const result: Operation = {
      ...admitted,
      state: "succeeded",
      result: {
        kind: "configuration",
        value: {
          requested,
          fields: [{ field: "baudRate", status: "applied", actual: "57600" }],
          readback: {},
          revision: "2",
          boundaryEventSeq: "9",
          txGate: "ready",
        },
      },
    };
    if (failure === "failed") result.state = "failed";
    if (failure === "queued") result.state = "queued";
    if (failure === "wrong-target")
      result.target = { ...target, sessionEpoch: "2" };
    if (failure === "wrong-operation") result.operationId = "other";
    if (failure === "wrong-action") result.actionId = "session.tx";
    if (
      failure === "wrong-configuration" &&
      result.result?.kind === "configuration"
    )
      result.result.value.requested = session().configuration;
    render(
      <SessionControls
        session={session()}
        target={target}
        operations={[]}
        labels={controlLabels}
        invoke={vi.fn().mockResolvedValue(admitted)}
        watchActions={allowControlActions}
        waitForOperation={vi.fn().mockResolvedValue(result)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Baud rate"), {
      target: { value: "57600" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply configuration" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Baud rate")).toHaveValue("57600");
    expect(
      screen.getByRole("button", { name: "Reset configuration" }),
    ).toBeEnabled();
  },
);
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
  return {
    invoke,
    props,
    ...render(
      <SessionControls waitForOperation={async (value) => value} {...props} />,
    ),
  };
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
          waitForOperation={async (value) => value}
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

it("routes an action failure to the serial log and floating notification using only its safe code", async () => {
  const invoke = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    message: "private device path and secret",
  });
  const view = render(
    <SessionControls
      waitForOperation={async (value) => value}
      session={session()}
      target={target}
      operations={[]}
      labels={controlLabels}
      invoke={invoke}
      watchActions={allowControlActions}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "DTR on" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    controlLabels.failure("PERMISSION_DENIED"),
  );
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.queryByText(/private device path/)).not.toBeInTheDocument();
  expect(getUserLog()).toEqual([
    expect.objectContaining({
      module: "serial",
      code: "PERMISSION_DENIED",
      count: 1,
    }),
  ]);
});

it("keeps a historical failed receipt readable without making it a current fault or replaying a notice", async () => {
  const result: Operation = {
    ...operation(),
    actionId: "session.control",
    target,
    state: "failed",
    error: {
      code: "PERMISSION_DENIED",
      message: "private device path and secret",
      retryable: false,
    },
  };
  const props = {
    waitForOperation: async (value: Operation) => value,
    session: session(),
    target,
    operations: [result],
    labels: controlLabels,
    invoke: vi.fn(),
    watchActions: allowControlActions,
  };
  const view = render(<SessionControls {...props} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const receipts = screen.getByRole("region", { name: "Receipt" });
  expect(receipts).toHaveTextContent(controlLabels.controlLines);
  expect(receipts).toHaveTextContent(controlLabels.operationText.states.failed);
  expect(receipts).not.toHaveTextContent(result.operationId);
  expect(receipts).not.toHaveTextContent(result.actionId);
  expect(receipts).not.toHaveTextContent("private device path");
  view.rerender(<SessionControls {...props} operations={[{ ...result }]} />);
  expect(getUserLog()).toEqual([]);
  fireEvent.click(
    within(receipts).getByRole("button", { name: controlLabels.details }),
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: controlLabels.details,
    }).value,
  ).toContain(result.operationId);
});

it("clears the current request fault after a successful retry while preserving the failed receipt across tool reopening", async () => {
  const previous: Operation = {
    ...operation("previous-control"),
    actionId: "session.control",
    target,
    state: "failed",
    error: {
      code: "PERMISSION_DENIED",
      message: "not for display",
      retryable: false,
    },
  };
  const invoke = vi
    .fn()
    .mockRejectedValueOnce({ code: "PERMISSION_DENIED" })
    .mockResolvedValueOnce({
      ...operation("retry-control"),
      actionId: "session.control",
      target,
    });
  const props = {
    session: session(),
    target,
    operations: [previous],
    labels: controlLabels,
    watchActions: allowControlActions,
    invoke,
    waitForOperation: async (value: Operation) => value,
  };
  const view = render(<SessionControls {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "DTR on" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "DTR off" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("region", { name: "Receipt" })).toHaveTextContent(
    controlLabels.operationText.states.failed,
  );
  expect(getUserLog()[0]?.count).toBe(1);
  view.unmount();
  render(<SessionControls {...props} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(getUserLog()[0]?.count).toBe(1);
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
      waitForOperation={async (value) => value}
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
      waitForOperation={async (value) => value}
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
  expect(screen.queryByLabelText("Driver readback")).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Receipt" })).getByRole(
      "button",
      { name: controlLabels.details },
    ),
  );
  expect(screen.getByLabelText("Driver readback")).toHaveValue(
    JSON.stringify(result.result.value, null, 2),
  );
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
      waitForOperation={async (value) => value}
      {...props}
      session={{ ...props.session, readOnly: true }}
      operations={[receipt]}
    />,
  );
  expect(screen.getByRole("button", { name: "DTR on" })).toBeDisabled();
  expect(screen.getByLabelText("BREAK receipt")).toHaveTextContent("unknown");
  expect(screen.queryByText(receipt.operationId)).not.toBeInTheDocument();
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
        waitForOperation={async (value) => value}
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
  expect([...work.values()][0]?.save).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});

it("authorizes each exact action independently with current requested parameters", async () => {
  const observer = observeControlActions();
  const { props, rerender, invoke } = setup();
  rerender(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      watchActions={observer.watchActions}
    />,
  );
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
  async (label, value, button, actionId) => {
    const observer = observeControlActions();
    const { props, rerender, invoke } = setup();
    rerender(
      <SessionControls
        waitForOperation={async (value) => value}
        {...props}
        watchActions={observer.watchActions}
      />,
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
    if (label === "Purge scope")
      await selectOption(label, controlLabels.driver);
    else if (label === "Purge direction")
      await selectOption(label, controlLabels.tx);
    else fireEvent.change(screen.getByLabelText(label), { target: { value } });
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
      <SessionControls waitForOperation={async (value) => value} {...props} />
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
        waitForOperation={async (value) => value}
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
        waitForOperation={async (value) => value}
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
  rerender(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      watchActions={observer.watchActions}
    />,
  );
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
      waitForOperation={async (value) => value}
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
  await waitFor(() =>
    expect(screen.getByLabelText("Sampled at")).toHaveAttribute(
      "dateTime",
      "2026-11-08T00:00:00Z",
    ),
  );
  expect(screen.queryByText("2026-11-08T00:00:00Z")).not.toBeInTheDocument();
  expect(screen.queryByText("123 ns")).not.toBeInTheDocument();
});

it("polls inputs every 500ms without redundant refresh, one inflight read, and unmount cancellation", async () => {
  vi.useFakeTimers();
  try {
    const sample = {
      sessionId: "session",
      sessionEpoch: "1",
      sampledAt: "2026-11-08T00:00:00Z",
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
        waitForOperation={async (value) => value}
        session={session()}
        target={target}
        operations={[]}
        labels={{
          ...controlLabels,
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
    expect(
      screen.queryByRole("button", { name: "Refresh inputs" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
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
      sampledAt: "2026-11-08T00:00:00Z",
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
        sampledAt: "2026-11-08T00:00:01Z",
      });
    const props = {
      target,
      operations: [],
      labels: {
        ...controlLabels,
        inputSignals: "Input signals",
        sampledAt: "Sampled at",
        on: "On",
        off: "Off",
      },
      invoke: vi.fn(),
      watchActions: allowControlActions,
      readInputs,
    };
    const view = render(
      <SessionControls
        waitForOperation={async (value) => value}
        {...props}
        session={session()}
      />,
    );
    await act(async () => {});
    expect(screen.getByLabelText("Sampled at")).toHaveAttribute(
      "dateTime",
      sample.sampledAt,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByLabelText("Sampled at")).not.toHaveAttribute("dateTime");
    expect(screen.getByLabelText("CTS")).toHaveTextContent(
      controlLabels.unknown,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readInputs).toHaveBeenCalledTimes(2);
    view.rerender(
      <SessionControls
        waitForOperation={async (value) => value}
        {...props}
        session={{ ...session(), sessionEpoch: "2" }}
        target={{ ...target, sessionEpoch: "2" }}
      />,
    );
    await act(async () => {});
    expect(readInputs).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Sampled at")).toHaveAttribute(
      "dateTime",
      "2026-11-08T00:00:01Z",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("discards a late old-epoch input sample and clears all booleans while disconnected", async () => {
  const sample = {
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "2026-11-08T00:00:00Z",
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
      sampledAt: "2026-11-08T00:00:01Z",
    });
  const props = {
    target,
    operations: [],
    labels: controlLabels,
    invoke: vi.fn(),
    watchActions: allowControlActions,
    readInputs,
  };
  const view = render(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      session={session()}
    />,
  );
  await waitFor(() => expect(readInputs).toHaveBeenCalledOnce());
  view.rerender(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      session={{ ...session(), sessionEpoch: "2" }}
      target={{ ...target, sessionEpoch: "2" }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Sampled at")).toHaveAttribute(
      "dateTime",
      "2026-11-08T00:00:01Z",
    ),
  );
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish(sample));
  expect(screen.getByLabelText("Sampled at")).toHaveAttribute(
    "dateTime",
    "2026-11-08T00:00:01Z",
  );
  view.rerender(
    <SessionControls
      waitForOperation={async (value) => value}
      {...props}
      session={{ ...session(), sessionEpoch: "2", state: "disconnected" }}
      target={{ ...target, sessionEpoch: "2" }}
    />,
  );
  expect(screen.getByLabelText("Sampled at")).not.toHaveAttribute("dateTime");
  expect(screen.getByLabelText("CTS")).toHaveTextContent(controlLabels.unknown);
});
