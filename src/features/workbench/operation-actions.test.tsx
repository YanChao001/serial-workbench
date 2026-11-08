import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { OperationActions } from "./operation-actions";
import { operation } from "./test-fixtures";
import { toolLabels } from "./transfer-capture-test-helpers";
import {
  allowControlActions,
  observeControlActions,
} from "./session-controls.test-fixtures";
afterEach(cleanup);
it("requests cancellation without claiming settlement and follows actual Host state", async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const props = {
    labels: toolLabels,
    onCancel: cancel,
    watchActions: allowControlActions,
  };
  const view = render(
    <OperationActions
      {...props}
      operation={{ ...operation(), state: "running" }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Request cancellation" }));
  await waitFor(() =>
    expect(cancel).toHaveBeenCalledWith("operation", expect.any(AbortSignal)),
  );
  expect(screen.getByLabelText("Operation")).toHaveTextContent("running");
  view.rerender(
    <OperationActions
      {...props}
      operation={{ ...operation(), state: "cancel_requested" }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "waiting for Host settlement",
  );
  expect(
    screen.getByRole("button", { name: "Request cancellation" }),
  ).toBeDisabled();
  view.rerender(
    <OperationActions
      {...props}
      operation={{ ...operation(), state: "cancelled" }}
    />,
  );
  expect(screen.getByLabelText("Operation")).toHaveTextContent("cancelled");
});
it("rebuilds observation under StrictMode and clears an allowed result when the watcher changes", () => {
  const first = observeControlActions(),
    second = observeControlActions();
  const props = {
    labels: toolLabels,
    operation: { ...operation(), state: "running" as const },
    onCancel: vi.fn(),
  };
  const view = render(
    <StrictMode>
      <OperationActions {...props} watchActions={first.watchActions} />
    </StrictMode>,
  );
  expect(first.subscriptions[0]?.stopped).toBe(true);
  act(() => first.publish(first.subscriptions.at(-1)!, () => true));
  const button = () =>
    screen.getByRole("button", { name: "Request cancellation" });
  expect(button()).toBeEnabled();
  view.rerender(
    <StrictMode>
      <OperationActions {...props} watchActions={second.watchActions} />
    </StrictMode>,
  );
  expect(button()).toBeDisabled();
  act(() => first.publish(first.subscriptions.at(-1)!, () => true));
  expect(button()).toBeDisabled();
  act(() => second.publish(second.subscriptions.at(-1)!, () => true));
  expect(button()).toBeEnabled();
  view.unmount();
  expect(second.subscriptions.at(-1)?.stopped).toBe(true);
});
it("keeps cancellation unknown or denied until the exact operation is allowed and drops old observations", () => {
  const observer = observeControlActions();
  const cancel = vi.fn();
  const props = {
    labels: toolLabels,
    onCancel: cancel,
    watchActions: observer.watchActions,
  };
  const view = render(
    <OperationActions
      {...props}
      operation={{ ...operation(), state: "running" }}
    />,
  );
  const button = () =>
    screen.getByRole("button", { name: "Request cancellation" });
  expect(button()).toBeDisabled();
  fireEvent.click(button());
  expect(cancel).not.toHaveBeenCalled();
  const first = observer.subscriptions[0]!;
  act(() => observer.publish(first, () => false));
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeEnabled();
  view.rerender(
    <OperationActions
      {...props}
      operation={{
        ...operation("next"),
        executionHostId: "other-host",
        state: "running",
      }}
    />,
  );
  expect(button()).toBeDisabled();
  act(() => observer.publish(first, () => true));
  expect(button()).toBeDisabled();
  const next = observer.subscriptions.at(-1)!;
  expect(next.inputs).toEqual([
    {
      actionId: "operation.cancel",
      target: { hostId: "other-host", kind: "operation", id: "next" },
      params: { reason: "user" },
    },
  ]);
  act(() => observer.publish(next, () => true));
  expect(button()).toBeEnabled();
  view.unmount();
  expect(next.stopped).toBe(true);
});
