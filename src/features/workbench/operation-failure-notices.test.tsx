import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { OperationSummary } from "@serial-workbench/contracts";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { OperationFailureNotices } from "./operation-failure-notices";
import { labels, operation } from "./test-fixtures";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

function Shell({ operations }: { operations: readonly OperationSummary[] }) {
  const [settings, setSettings] = useState(false);
  return (
    <>
      <OperationFailureNotices
        ready
        scopeKey="host:epoch:1"
        operations={operations}
        text={labels.operationText}
      />
      <button onClick={() => setSettings(true)}>Settings</button>
      <main>{settings ? "Settings page" : "Transfer tool"}</main>
    </>
  );
}

it("notifies a transfer failure after its tool was closed and the user navigated to settings", () => {
  const running = {
    ...operation("background-transfer"),
    actionId: "transfer.file",
    state: "running" as const,
  };
  const view = render(
    <StrictMode>
      <Shell operations={[running]} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByText("Settings page")).toBeInTheDocument();
  view.rerender(
    <StrictMode>
      <Shell
        operations={[
          {
            ...running,
            state: "failed",
            revision: "2",
            errorCode: "PERMISSION_DENIED",
          },
        ]}
      />
    </StrictMode>,
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toEqual([
    expect.objectContaining({
      module: "transfer",
      code: "PERMISSION_DENIED",
      count: 1,
    }),
  ]);
  expect(JSON.stringify(getUserLog())).not.toContain("background-transfer");
});

it("does not notify attached history, but observes new terminal events once even without an intermediate running render", () => {
  const historical = {
    ...operation("attached-history"),
    actionId: "capture.verify",
    state: "failed" as const,
    errorCode: "PERMISSION_DENIED",
  };
  const content = (
    operations: readonly OperationSummary[],
    ready = true,
    scopeKey = "history-scope",
  ) => (
    <StrictMode>
      <OperationFailureNotices
        ready={ready}
        scopeKey={scopeKey}
        operations={operations}
        text={labels.operationText}
      />
    </StrictMode>
  );
  const view = render(content([historical], false));
  view.rerender(content([historical]));
  expect(toast.custom).not.toHaveBeenCalled();
  const failure = {
    ...historical,
    operationId: "new-verify",
    requestId: "not-for-display",
    revision: "2",
  };
  view.rerender(content([failure, historical]));
  view.rerender(content([{ ...failure, revision: "3" }, historical]));
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "capture", count: 1 }),
  ]);
  view.rerender(content([historical], true, "other-host-scope"));
  view.rerender(content([failure, historical]));
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()[0]?.count).toBe(1);
});

it.each([
  ["capture.recover", "capture"],
  ["replay.open", "capture"],
  ["session.control", "serial"],
  ["device.open", "connection"],
  ["workspace.save", "workspace"],
  ["settings.save", "settings"],
  ["other.action", "application"],
])(
  "assigns %s terminal failures to the %s module without exposing technical identity",
  (actionId, module) => {
    const running = {
      ...operation(`module-${actionId}`),
      actionId,
      state: "running" as const,
    };
    const content = (operations: readonly OperationSummary[]) => (
      <OperationFailureNotices
        ready
        scopeKey={`module-${actionId}`}
        operations={operations}
        text={labels.operationText}
      />
    );
    const view = render(content([running]));
    view.rerender(
      content([
        { ...running, state: "failed", errorCode: "PERMISSION_DENIED" },
      ]),
    );
    expect(getUserLog()).toEqual([
      expect.objectContaining({ module, count: 1 }),
    ]);
    expect(JSON.stringify(getUserLog())).not.toContain(running.operationId);
  },
);

it("keeps user cancellation quiet and distinguishes independent failures with the same code", () => {
  const running = {
    ...operation("cancelled-task"),
    actionId: "capture.verify",
    state: "running" as const,
  };
  const content = (operations: readonly OperationSummary[]) => (
    <OperationFailureNotices
      ready
      scopeKey="cancellation-scope"
      operations={operations}
      text={labels.operationText}
    />
  );
  const view = render(content([running]));
  view.rerender(
    content([{ ...running, state: "cancelled", errorCode: "CANCELLED" }]),
  );
  expect(toast.custom).not.toHaveBeenCalled();
  view.rerender(
    content(
      [1, 2].map((index) => ({
        ...running,
        operationId: `independent-${index}`,
        state: "failed",
        errorCode: "PERMISSION_DENIED",
      })),
    ),
  );
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "capture", count: 2 }),
  ]);
});

it("retains known pending operations through temporary metadata errors and an absent bridge attachment", () => {
  const running = {
    ...operation("pending-through-metadata-error"),
    actionId: "capture.verify",
    state: "queued" as const,
  };
  const content = (
    ready: boolean,
    operations: readonly OperationSummary[],
    scopeKey = "same-host-instance",
  ) => (
    <StrictMode>
      <OperationFailureNotices
        ready={ready}
        scopeKey={scopeKey}
        operations={operations}
        text={labels.operationText}
      />
    </StrictMode>
  );
  const view = render(content(true, [running]));
  view.rerender(content(false, []));
  view.rerender(content(false, [], ""));
  view.rerender(
    content(true, [
      { ...running, state: "failed", errorCode: "PERMISSION_DENIED" },
    ]),
  );
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(getUserLog()).toEqual([
    expect.objectContaining({ module: "capture", count: 1 }),
  ]);
});

it("isolates different backend Hosts while a return attachment does not replay their history", () => {
  const running = {
    ...operation("same-id-across-hosts"),
    actionId: "transfer.file",
    state: "running" as const,
  };
  const content = (hostId: string, state: "running" | "failed") => (
    <OperationFailureNotices
      ready
      scopeKey={`${hostId}:instance`}
      operations={[
        {
          ...running,
          executionHostId: hostId,
          state,
          errorCode: state === "failed" ? "PERMISSION_DENIED" : undefined,
        },
      ]}
      text={labels.operationText}
    />
  );
  const view = render(content("first-host", "running"));
  view.rerender(content("first-host", "failed"));
  view.rerender(content("second-host", "running"));
  view.rerender(content("second-host", "failed"));
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog()[0]?.count).toBe(2);
  view.rerender(content("first-host", "failed"));
  expect(toast.custom).toHaveBeenCalledTimes(2);
  expect(getUserLog()[0]?.count).toBe(2);
});
