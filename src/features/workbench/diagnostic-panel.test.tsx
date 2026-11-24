import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { createTranslator } from "@/i18n/translate";
import { DiagnosticPanel } from "./diagnostic-panel";
import { session, txItem } from "./test-fixtures";
import type { StreamItem } from "@serial-workbench/contracts";
import { workbenchToolLabels } from "./tool-labels";
import { HostRequestError } from "@serial-workbench/host-client";

afterEach(cleanup);
const labels = workbenchToolLabels(createTranslator(en)).diagnostics;
const failure = {
  code: "ACCESS_DENIED",
  message: "Native serial operation failed",
  module: "serial",
  occurrence: 1,
  context: "COM14",
} as const;

it.each(["Restore connection access", "恢复连接访问"])(
  "offers %s for a confirmed raw permission failure",
  (restoreAccess) => {
    const retry = vi.fn();
    const translated = workbenchToolLabels(
      createTranslator(restoreAccess === "恢复连接访问" ? zhCN : en),
    ).diagnostics;
    render(
      <DiagnosticPanel
        labels={translated}
        items={[]}
        session={session()}
        streamError={
          new HostRequestError({
            code: "PERMISSION_DENIED",
            message: "denied",
            retryable: false,
          })
        }
        onReconnect={retry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: restoreAccess }));
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each(["SOURCE_ENDED", "EPOCH_MISMATCH"])(
  "does not treat %s as an authorization failure",
  (code) => {
    const retry = vi.fn();
    render(
      <DiagnosticPanel
        labels={labels}
        items={[]}
        session={session()}
        streamError={
          new HostRequestError({
            code,
            message: "source unavailable",
            retryable: false,
          })
        }
        onReconnect={retry}
      />,
    );
    expect(
      screen.queryByRole("button", { name: labels.restoreAccess }),
    ).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  },
);

it.each(["closed", "readonly"] as const)(
  "does not offer raw access restoration for %s",
  (kind) => {
    const current = {
      ...session(),
      ...(kind === "closed"
        ? { state: "closed" as const }
        : { readOnly: true }),
    };
    render(
      <DiagnosticPanel
        labels={labels}
        items={[]}
        session={current}
        streamError={
          new HostRequestError({
            code: "PERMISSION_DENIED",
            message: "denied",
            retryable: false,
          })
        }
        onReconnect={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: labels.restoreAccess }),
    ).not.toBeInTheDocument();
  },
);

it("shows a quiet healthy state without unrelated guides or retry buttons", () => {
  render(<DiagnosticPanel labels={labels} items={[]} session={session()} />);
  expect(screen.getByText(labels.noIssues)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: labels.cannotOpen }),
  ).not.toBeInTheDocument();
});

it.each([
  {
    platform: "windows" as const,
    expected: "windowsDeviceManager" as const,
    absent: "linuxPermissions" as const,
  },
  {
    platform: "macos" as const,
    expected: "macosAccessory" as const,
    absent: "windowsDeviceManager" as const,
  },
  {
    platform: "linux" as const,
    expected: "linuxPermissions" as const,
    absent: "macosAccessory" as const,
  },
])(
  "selects only $platform guidance and shows the actionable code without exposing raw failure text",
  async ({ platform, expected, absent }) => {
    const retry = vi.fn();
    render(
      <DiagnosticPanel
        labels={labels}
        items={[]}
        platform={platform}
        openError={failure}
        onReconnect={retry}
      />,
    );
    expect(screen.getByText(labels.accessDenied)).toBeInTheDocument();
    expect(screen.getByText(labels[expected])).toBeInTheDocument();
    expect(screen.queryByText(labels[absent])).not.toBeInTheDocument();
    expect(screen.getByText("ACCESS_DENIED")).toBeInTheDocument();
    expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: labels.open }));
    expect(retry).toHaveBeenCalledOnce();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: labels.details }));
    expect(screen.getByRole("textbox", { name: labels.details })).toHaveValue(
      "ACCESS_DENIED",
    );
  },
);

it.each([en, zhCN])(
  "distinguishes application authorization from system access errors in both languages",
  (messages) => {
    const translated = workbenchToolLabels(
      createTranslator(messages),
    ).diagnostics;
    render(
      <DiagnosticPanel
        labels={translated}
        items={[]}
        platform="windows"
        openError={{ ...failure, code: "PERMISSION_DENIED" }}
      />,
    );
    expect(screen.getByText(translated.permissionDenied)).toBeInTheDocument();
    expect(
      screen.queryByText(translated.windowsDeviceManager),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(translated.accessDenied)).not.toBeInTheDocument();
  },
);

it("shows stream recovery tools and reconnect only for actual failures or a disconnected session", () => {
  const hex = vi.fn(),
    metrics = vi.fn(),
    reconnect = vi.fn();
  const view = render(
    <DiagnosticPanel
      labels={labels}
      items={[]}
      session={session()}
      streamError={Object.assign(new Error("private technical message"), {
        code: "EPOCH_MISMATCH",
      })}
      onInspectBytes={hex}
      onInspectMetrics={metrics}
      onReconnect={reconnect}
    />,
  );
  expect(screen.getByText(labels.streamFailed)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: labels.open }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: labels.hex }));
  fireEvent.click(screen.getByRole("button", { name: labels.metrics }));
  expect(hex).toHaveBeenCalledOnce();
  expect(metrics).toHaveBeenCalledOnce();
  view.rerender(
    <DiagnosticPanel
      labels={labels}
      items={[]}
      session={{ ...session(), state: "disconnected" }}
      onReconnect={reconnect}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.open }));
  expect(reconnect).toHaveBeenCalledOnce();
});

async function chooseProblem(subject: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Problem to check" }));
  await user.click(screen.getByRole("option", { name: subject }));
  return user;
}

it("compares the receive encoding to matching RX evidence and applies only on request", async () => {
  const onApplyEncoding = vi.fn();
  const sample = txItem("tx");
  if (sample.kind !== "source") throw new Error("Missing fixture event");
  const bytes: StreamItem = {
    kind: "source",
    event: {
      ...sample.event,
      kind: "rx",
      payload: { bytesBase64: "//5BAA==", byteStart: "0", byteEnd: "4" },
    },
  };
  const previous: StreamItem = {
    kind: "source",
    event: { ...bytes.event, sessionEpoch: "0" },
  };
  const view = render(
    <DiagnosticPanel
      labels={labels}
      items={[previous]}
      session={session()}
      receiveEncoding="utf-8"
      onApplyEncoding={onApplyEncoding}
    />,
  );
  const user = await chooseProblem("Garbled text");
  expect(screen.getByText("Insufficient evidence")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Use encoding and view text" }),
  ).not.toBeInTheDocument();

  view.rerender(
    <DiagnosticPanel
      labels={labels}
      items={[previous, bytes]}
      session={session()}
      receiveEncoding="utf-8"
      onApplyEncoding={onApplyEncoding}
    />,
  );
  expect(screen.getByText("UTF-16 LE")).toBeInTheDocument();
  expect(screen.getByText("Byte-order mark")).toBeInTheDocument();
  expect(onApplyEncoding).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Use encoding and view text" }),
  );
  expect(onApplyEncoding).toHaveBeenCalledExactlyOnceWith("utf-16le");
});

it("separates reader gaps from source gaps and excludes stale sessions", async () => {
  const sample = txItem("tx");
  if (sample.kind !== "source") throw new Error("Missing fixture event");
  const readerGap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "3", end: "5" },
    },
  };
  const sourceGap: StreamItem = {
    kind: "source",
    event: {
      ...sample.event,
      kind: "gap",
      payload: { reason: "backend_loss", knownExtent: false },
    },
  };
  render(
    <DiagnosticPanel
      labels={labels}
      items={[
        readerGap,
        sourceGap,
        { ...readerGap, gap: { ...readerGap.gap, sessionEpoch: "0" } },
      ]}
      session={session()}
    />,
  );
  await chooseProblem("Missing data");
  expect(screen.getByText("Reader gap records")).toBeInTheDocument();
  expect(screen.getByText("Source gap records")).toBeInTheDocument();
  expect(screen.getAllByText("1", { exact: true })).toHaveLength(2);
});

it("shows the exact reconnect state and waits for an explicit retry", async () => {
  const retry = vi.fn();
  render(
    <DiagnosticPanel
      labels={labels}
      items={[]}
      session={{
        ...session(),
        state: "disconnected",
        reconnect: { state: "requires_rebind", attempts: "2" },
      }}
      onReconnect={retry}
    />,
  );
  const user = await chooseProblem("Disconnected");
  expect(
    screen.getByText("Device identity needs confirmation"),
  ).toBeInTheDocument();
  expect(screen.getByText("2", { exact: true })).toBeInTheDocument();
  expect(retry).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: labels.open }));
  expect(retry).toHaveBeenCalledOnce();
});

it("retries the selected port separately from the active disconnected session", async () => {
  const retryOpen = vi.fn();
  const reopenSession = vi.fn();
  render(
    <DiagnosticPanel
      labels={labels}
      items={[]}
      session={{ ...session(), state: "disconnected" }}
      openError={failure}
      openTarget={{ retry: retryOpen }}
      onReconnect={reopenSession}
    />,
  );
  const user = await chooseProblem("Cannot open port");
  expect(screen.getByText("ACCESS_DENIED")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: labels.open }));
  expect(retryOpen).toHaveBeenCalledOnce();
  expect(reopenSession).not.toHaveBeenCalled();

  await chooseProblem("Disconnected");
  expect(screen.queryByText("ACCESS_DENIED")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: labels.open }));
  expect(reopenSession).toHaveBeenCalledOnce();
});
