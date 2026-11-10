import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { createTranslator } from "@/i18n/translate";
import { DiagnosticPanel } from "./diagnostic-panel";
import { session } from "./test-fixtures";
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
  "selects only $platform guidance from the actual error and keeps the code in details",
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
    expect(screen.queryByText("ACCESS_DENIED")).not.toBeInTheDocument();
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
