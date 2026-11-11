import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPersistence } from "./settings-persistence";
import { toast } from "sonner";
import { clearUserLog, getUserLog } from "@/lib/user-log";

const state = vi.hoisted(() => ({
  persistence: "saved",
  persistenceError: null as string | null,
  persistenceScope: undefined as
    "connection" | "shared" | "client" | "serial" | "effects" | undefined,
  retrySave: vi.fn(),
}));
vi.mock("@/providers/settings", () => ({ useSettings: () => state }));
vi.mock("@/providers/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearUserLog();
  state.persistence = "saved";
  state.persistenceError = null;
  state.persistenceScope = undefined;
});

describe("设置保存反馈", () => {
  it("成功后保持安静，保存中仅向辅助技术提供状态", () => {
    state.persistence = "saved";
    const { container, rerender } = render(<SettingsPersistence />);
    expect(container).toBeEmptyDOMElement();
    state.persistence = "saving";
    rerender(<SettingsPersistence />);
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(screen.queryByText("settings.persistenceSaved")).toBeNull();
  });
  it("全局保存失败仅弹出一次限时通知，日志保留错误，恢复后撤回提示且不占页面布局", () => {
    state.persistence = "error";
    state.persistenceError = "STORAGE_UNAVAILABLE";
    const { container, rerender } = render(<SettingsPersistence compact />);
    expect(container).toBeEmptyDOMElement();
    expect(toast.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        id: expect.any(String),
        duration: 5000,
        closeButton: true,
      }),
    );
    rerender(<SettingsPersistence compact />);
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()).toMatchObject([
      { module: "settings", code: "STORAGE_UNAVAILABLE", count: 1 },
    ]);
    const notice = vi.mocked(toast.custom).mock.calls[0]?.[0];
    if (!notice) throw new Error("Missing persistence notice");
    const rendered = render(<>{notice("notice")}</>);
    expect(
      screen.getByRole("alert").closest(".workbench-notification"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    rendered.unmount();
    expect(state.retrySave).toHaveBeenCalledOnce();
    state.persistence = "saved";
    rerender(<SettingsPersistence compact />);
    expect(toast.dismiss).toHaveBeenCalledWith(expect.any(String));
  });
  it("连接错误由工作台统一通知，设置组件不重复弹出或记录", () => {
    state.persistence = "error";
    state.persistenceError = "HOST_UNAVAILABLE";
    state.persistenceScope = "connection";
    const { container } = render(<SettingsPersistence compact />);
    expect(container).toBeEmptyDOMElement();
    expect(toast.custom).not.toHaveBeenCalled();
    expect(getUserLog()).toHaveLength(0);
  });
  it("页面实例只提供辅助状态，不重复维护全局toast；卸载不撤销有效通知", () => {
    state.persistence = "error";
    state.persistenceError = "STORAGE_UNAVAILABLE";
    const view = render(<SettingsPersistence />);
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(toast.custom).not.toHaveBeenCalled();
    view.unmount();
    expect(toast.dismiss).not.toHaveBeenCalled();
  });
  it("未来版本拒写仍有紧凑说明，不提供覆盖或普通重试入口", () => {
    state.persistence = "error";
    state.persistenceError = "FUTURE_FORMAT";
    render(<SettingsPersistence />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "settings.persistenceFuture",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("全局未来格式故障只浮层通知，保留日志且不增加工作台行高", () => {
    state.persistence = "error";
    state.persistenceError = "FUTURE_FORMAT";
    const view = render(<SettingsPersistence compact />);
    expect(view.container).toBeEmptyDOMElement();
    expect(toast.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ duration: 5000, closeButton: true }),
    );
    expect(vi.mocked(toast.custom).mock.calls[0]?.[1]).not.toHaveProperty(
      "action",
    );
    view.rerender(<SettingsPersistence compact />);
    expect(toast.custom).toHaveBeenCalledOnce();
    expect(getUserLog()).toMatchObject([
      { module: "settings", code: "FUTURE_FORMAT" },
    ]);
  });
});
