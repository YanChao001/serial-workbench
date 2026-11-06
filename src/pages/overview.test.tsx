import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsProvider } from "@/providers/settings";
import { I18nProvider } from "@/providers/i18n";
import Overview from "./overview";

afterEach(cleanup);
describe("Serial Workbench 首页", () => {
  it("呈现空白工作区，不生成演示数据或恢复旧展示入口", () => {
    localStorage.clear();
    render(
      <SettingsProvider>
        <I18nProvider>
          <Overview />
        </I18nProvider>
      </SettingsProvider>,
    );
    expect(screen.getByTestId("serial-workbench-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("showroom")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
