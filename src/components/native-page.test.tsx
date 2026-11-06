import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/providers/i18n";
import { SettingsProvider } from "@/providers/settings";
import { NativePage } from "./native-page";
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));
afterEach(cleanup);
it("explains the desktop requirement without demo destinations or simulated operations", () => {
  localStorage.clear();
  render(
    <SettingsProvider>
      <I18nProvider>
        <NativePage title="Native settings">
          <button>Change system settings</button>
        </NativePage>
      </I18nProvider>
    </SettingsProvider>,
  );
  expect(
    screen.getByRole("heading", { name: "Native settings" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
