import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { copyText } from "@/lib/clipboard";
import { enRecovery } from "@/i18n/en-recovery";
import * as native from "@/lib/tauri";
import Recovery from "./recovery";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  recoveryStatus: vi.fn(),
  stageRecovery: vi.fn(),
  relaunchApp: vi.fn(),
  getDiagnosticsReport: vi.fn(),
}));
vi.mock("@/providers/i18n", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const { en } = await import("@/i18n/en");
  return {
    useI18n: () => ({ language: "en", t: createTranslator(en) }),
  };
});

let status: native.RecoveryStatus;
function Destination() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>
        {pathname}
        {search}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}
const report: Awaited<ReturnType<typeof native.getDiagnosticsReport>> = {
  appVersion: "1.0.0",
  tauriVersion: "2",
  architecture: "x86_64",
  platform: "windows",
  windowLabel: "main",
  settingsRevision: 4,
  desktop: {
    trayAvailable: true,
    secondaryOpen: false,
    autostartSupported: true,
    runInBackground: false,
  },
  autostartEnabled: false,
  updaterConfigured: false,
  recentLogs: "[local path]",
};

describe("isolated settings recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status = {
      active: true,
      reason: "Cannot open original settings",
      pending: false,
      archiveId: null,
    };
    vi.mocked(native.recoveryStatus).mockImplementation(async () => ({
      ...status,
    }));
    vi.mocked(native.stageRecovery).mockImplementation(async () => {
      status = { ...status, pending: true };
      return { ...status };
    });
  });
  afterEach(cleanup);

  it("schedules settings replacement only after confirmation and waits for an explicit restart", async () => {
    render(<Recovery />);
    const schedule = await screen.findByRole("button", {
      name: enRecovery["recovery.schedule"],
    });
    expect(schedule).toBeEnabled();
    fireEvent.click(schedule);
    const dialog = screen.getByRole("dialog");
    expect(native.stageRecovery).not.toHaveBeenCalled();
    expect(dialog).toHaveAccessibleDescription(
      enRecovery["recovery.confirmWithSettings"],
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: enRecovery["recovery.confirm"],
      }),
    );
    await waitFor(() =>
      expect(native.stageRecovery).toHaveBeenCalledExactlyOnceWith(),
    );
    const restart = await screen.findByRole("button", {
      name: enRecovery["recovery.restart"],
    });
    expect(native.relaunchApp).not.toHaveBeenCalled();
    fireEvent.click(restart);
    await waitFor(() => expect(native.relaunchApp).toHaveBeenCalledOnce());
  });

  it("keeps originals unchanged when the confirmation is cancelled", async () => {
    render(<Recovery />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: enRecovery["recovery.schedule"],
      }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(native.stageRecovery).not.toHaveBeenCalled();
  });

  it("keeps a failed replacement confirmation open and preserves the original failure evidence", async () => {
    status = { ...status, archiveId: "recovery-archive-originals" };
    vi.mocked(native.stageRecovery).mockRejectedValueOnce({
      code: "STORAGE_IO",
    });
    render(<Recovery />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: enRecovery["recovery.schedule"],
      }),
    );
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: enRecovery["recovery.confirm"],
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(within(dialog).getByRole("alert")).toHaveClass("sr-only");
    expect(confirm).toBeEnabled();
    expect(screen.getByText("Cannot open original settings")).toBeVisible();
    expect(screen.getByText(/recovery-archive-originals/)).toBeVisible();
  });

  it("deduplicates a pending replacement and ignores its result after navigation", async () => {
    let finish!: (value: native.RecoveryStatus) => void;
    vi.mocked(native.stageRecovery).mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const mounted = render(<Recovery />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: enRecovery["recovery.schedule"],
      }),
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: enRecovery["recovery.confirm"],
    });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(native.stageRecovery).toHaveBeenCalledOnce();
    expect(confirm).toBeDisabled();
    mounted.unmount();
    await act(async () => finish({ ...status, pending: true }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(native.recoveryStatus).toHaveBeenCalledOnce();
  });

  it("retains retry when the initial recovery status cannot be loaded", async () => {
    vi.mocked(native.recoveryStatus).mockRejectedValueOnce({
      code: "STORAGE_IO",
    });
    render(<Recovery />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(
      await screen.findByText("Cannot open original settings"),
    ).toBeVisible();
  });

  it("copies the bounded diagnostic report with success feedback", async () => {
    vi.mocked(native.getDiagnosticsReport).mockResolvedValueOnce(report);
    vi.mocked(copyText).mockResolvedValueOnce();
    render(<Recovery />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: enRecovery["recovery.diagnostics"],
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(enRecovery["recovery.copied"]),
    );
    expect(copyText).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
  });

  it("replaces a healthy legacy recovery link while preserving other query parameters", async () => {
    status = { ...status, active: false, reason: null };
    render(
      <MemoryRouter
        initialEntries={["/settings", "/recovery?keep=1&section=old"]}
      >
        <Routes>
          <Route path="/recovery" element={<Recovery />} />
          <Route path="/settings" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("/settings?keep=1&section=recovery"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("/settings")).toBeInTheDocument();
  });
});
