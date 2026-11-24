import { defaults } from "@serial-workbench/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import type { HostConnection } from "@/lib/host-client";
import { STORAGE_KEY } from "@/lib/settings-model";
import { I18nProvider } from "@/providers/i18n";
import { SettingsProvider } from "@/providers/settings";
import { useState } from "react";
import { BrowserPluginView, type BrowserViewOpen } from "./browser-plugin-view";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const title =
  "发布者提供的字段图表与测量记录 SerialMeasurementCollectionFromManyDevices";

it("keeps the plugin name, localized failure and close action accessible", async () => {
  let rejectOpen: (reason: Error) => void = () => {};
  const pending = new Promise<never>((_, reject) => {
    rejectOpen = reject;
  });
  const openViewConnection = vi.fn(() => pending);
  const connection = {
    browser: {
      closed: new AbortController().signal,
      openViewConnection,
    },
  };

  function Fixture() {
    const [view, setView] = useState<BrowserViewOpen>();
    return (
      <SettingsProvider>
        <I18nProvider>
          <button
            onClick={(event) =>
              setView({
                archiveSha256: "0".repeat(64),
                dark: false,
                operationId: "operation",
                opener: event.currentTarget,
                packageId: "swb.fixture",
                target: {
                  hostId: "host",
                  id: "session",
                  kind: "session",
                  sessionEpoch: "1",
                  sessionId: "session",
                },
                title,
                viewId: "fixture",
              })
            }
          >
            View fixture
          </button>
          {view ? (
            <BrowserPluginView
              connection={connection as unknown as HostConnection}
              view={view}
              onClose={() => setView(undefined)}
            />
          ) : null}
        </I18nProvider>
      </SettingsProvider>
    );
  }

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      formatVersion: "0.1",
      value: { ...defaults.settings, language: "en" },
    }),
  );
  const user = userEvent.setup();
  render(<Fixture />);
  const open = screen.getByRole("button", { name: "View fixture" });
  await user.click(open);
  expect(screen.getByRole("dialog", { name: title })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(en["common.loading"]);
  expect(openViewConnection).toHaveBeenCalledTimes(1);

  await user.click(
    screen.getByRole("combobox", { name: en["common.language"] }),
  );
  await user.click(screen.getByRole("option", { name: "简体中文" }));
  expect(screen.getByRole("status")).toHaveTextContent(zhCN["common.loading"]);
  rejectOpen(new Error("fixture private path"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    zhCN["plugins.viewError"],
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("fixture private path")).toBeNull();
  expect(openViewConnection).toHaveBeenCalledTimes(1);

  const close = screen.getByRole("button", { name: zhCN["common.close"] });
  close.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(open).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
});
