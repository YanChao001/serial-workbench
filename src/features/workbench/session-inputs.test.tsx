import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { SessionInputSamples } from "./session-inputs";
import { controlLabels, target } from "./session-controls.test-fixtures";

afterEach(() => {
  cleanup();
  toast.dismiss();
  clearUserLog();
  vi.useRealTimers();
});

it("reports repeated input sampling failures once through the notification and serial log without adding a layout row", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  clearUserLog();
  render(<Toaster />);
  const read = vi.fn().mockRejectedValue({
    code: "PERMISSION_DENIED",
    message: "private device path and secret",
  });
  const view = render(
    <SessionInputSamples
      target={target}
      read={read}
      connected
      labels={controlLabels}
    />,
  );
  await act(async () => {});
  expect(await screen.findByRole("alert")).toHaveTextContent(
    controlLabels.failure("PERMISSION_DENIED"),
  );
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.queryByText(/private device path/)).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(read).toHaveBeenCalledTimes(5);
  expect(getUserLog()).toEqual([
    expect.objectContaining({
      module: "serial",
      code: "PERMISSION_DENIED",
      count: 1,
    }),
  ]);
  expect(getUserLog()[0]?.message).not.toContain("secret");
});

it("keeps sampling time readable and reveals the exact timestamp and monotonic clock only on request", async () => {
  const sample = {
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "2026-11-08T00:00:00Z",
    sampledMonoNs: "987654321",
    cts: true,
    dsr: false,
    ri: false,
    cd: true,
  };
  const read = vi.fn().mockResolvedValue(sample);
  render(
    <SessionInputSamples
      target={target}
      read={read}
      connected
      labels={controlLabels}
    />,
  );
  await act(async () => {});
  expect(screen.getByLabelText(controlLabels.sampledAt)).toHaveTextContent(
    new Date(sample.sampledAt).toLocaleTimeString(undefined, {
      hourCycle: "h23",
    }),
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText(sample.sampledMonoNs)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh inputs" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: controlLabels.details }));
  expect(
    screen.getByRole("textbox", { name: controlLabels.inputSignals }),
  ).toHaveValue(JSON.stringify(sample, null, 2));
});
