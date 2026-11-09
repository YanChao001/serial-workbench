import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@/i18n/translate";
import { zhCN } from "@/i18n/zh-CN";
import { CompactNavigation } from "./compact-navigation";

const state = vi.hoisted(() => ({ native: false }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => state.native }));
vi.mock("@/providers/i18n", () => ({
  useI18n: () => ({ t: createTranslator(zhCN) }),
}));
function Location() {
  const { pathname } = useLocation();
  return <output aria-label="当前路由">{pathname}</output>;
}
function renderBar(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CompactNavigation />
      <Location />
    </MemoryRouter>,
  );
}
describe("浏览器导航", () => {
  beforeEach(() => {
    state.native = false;
  });
  afterEach(cleanup);
  it("页面选择复用真实路由，不创建模拟场景", () => {
    renderBar();
    const navigation = screen.getByRole("combobox", { name: "切换页面" });
    fireEvent.keyDown(navigation, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "设置" }));
    expect(screen.getByLabelText("当前路由")).toHaveTextContent("/settings");
    expect(navigation).toHaveTextContent("设置");
  });
  it("原生窗口不显示浏览器入口", () => {
    state.native = true;
    renderBar();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
