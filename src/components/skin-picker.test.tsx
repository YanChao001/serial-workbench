import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsProvider, useSettings } from "@/providers/settings";
import { I18nProvider } from "@/providers/i18n";
import { SkinPicker } from "./skin-picker";
import { BUNDLED_WALLPAPERS } from "@/lib/bundled-wallpapers";
vi.mock("./custom-background-picker", () => ({
  CustomBackgroundPicker: () => null,
}));
function Selection() {
  return (
    <output data-testid="selection">
      {JSON.stringify(useSettings().settings.background)}
    </output>
  );
}
const mount = () =>
  render(
    <SettingsProvider>
      <I18nProvider>
        <SkinPicker />
        <Selection />
      </I18nProvider>
    </SettingsProvider>,
  );
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
describe("Host background selections", () => {
  it("persists a preset as the generated tagged selection and marks the selected radio", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "云朵晴空" }));
    expect(screen.getByTestId("selection")).toHaveTextContent(
      '{"kind":"preset","value":"sakura"}',
    );
    expect(screen.getByRole("radio", { name: "云朵晴空" })).toBeChecked();
  });
  it("persists a stable bundled identity without a build URL or inline bitmap", () => {
    mount();
    const wallpaper = BUNDLED_WALLPAPERS[0]!;
    fireEvent.click(
      screen.getByRole("radio", { name: `使用壁纸：${wallpaper.name}` }),
    );
    expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual({
      kind: "bundled",
      id: wallpaper.id,
    });
    expect(
      screen.getByRole("radio", { name: `使用壁纸：${wallpaper.name}` }),
    ).toBeChecked();
  });
});
