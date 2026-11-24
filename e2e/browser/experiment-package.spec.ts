import { expect, test } from "@playwright/test";
import type {
  DeviceBinding,
  ExperimentInspection,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { session } from "../../src/features/workbench/test-fixtures";
import { defaults } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const recording = {
  hostId: "workbench-gui-host",
  kind: "file",
  id: "registered-capture",
  revision: "2",
} as const;
const localBinding: DeviceBinding = {
  bindingId: "local-device",
  hostId: recording.hostId,
  deviceId: "device",
  portName: "COM71",
  fingerprint: {
    transport: "virtual",
    serialNumber: "private-serial",
    evidence: "unreliable",
  },
  configuration: session().configuration,
  reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
};
const workspace: WorkspaceDocument = {
  ...defaults.workspace,
  name: "Modbus bench",
  bindings: [localBinding],
  views: [
    {
      id: "live-view",
      name: "Modbus live",
      bindingId: localBinding.bindingId,
      color: "#64748b",
      icon: "terminal",
      pinned: false,
      receiveMode: "text",
      sendMode: "text",
    },
  ],
  captures: [recording],
};
const inspection: ExperimentInspection = {
  experiment: {
    formatVersion: "1",
    workspace: {
      ...defaults.workspace,
      bindings: [
        {
          bindingId: "experiment-device-1",
          hostId: "experiment-unbound",
          deviceId: "experiment-device-1",
          configuration: localBinding.configuration,
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          reconnect: localBinding.reconnect,
        },
      ],
    },
    parsers: [
      {
        id: "swb.reference.framing",
        version: "0.1.0",
        archiveSha256: "a".repeat(64),
      },
    ],
    recordings: [
      {
        reference: { ...recording, hostId: "recording-source-host" },
        fingerprint: "b".repeat(64),
      },
    ],
    firmware: [{ binding: 1, version: "v1.4.2" }],
    runs: [],
  },
  parserStatus: ["changed"],
  recordingStatus: ["other_host"],
};

for (const { width, height, columns, language, theme, dictionary } of [
  {
    width: 420,
    height: 460,
    columns: 1,
    language: "zh",
    theme: "dark",
    dictionary: zhCN,
  },
  {
    width: 1240,
    height: 760,
    columns: 2,
    language: "en",
    theme: "light",
    dictionary: en,
  },
] as const) {
  test(`experiment evidence and confirmed import fit at ${width}px`, async ({
    page,
  }, info) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height });
    await seedWorkbenchFixture(page, {
      workspace,
      experiment: inspection,
      fileMetadata: {
        fileRef: recording,
        purpose: "capture_source",
        length: "512",
        fingerprint: "b".repeat(64),
      },
      language,
      theme,
    });
    await page.goto("./#/");
    const workspaceTitle = dictionary["workbench.tools.workspace"];
    const menu = page.getByRole("button", {
      name: dictionary["workbench.tools.more"],
      exact: true,
    });
    await expect(menu).toBeVisible();
    const direct = page.getByRole("button", {
      name: workspaceTitle,
      exact: true,
    });
    if (await direct.isVisible()) await direct.click();
    else {
      await menu.press("ArrowDown");
      await page
        .getByRole("menuitem", { name: workspaceTitle, exact: true })
        .click();
    }
    const dialog = page.getByRole("dialog", {
      name: workspaceTitle,
      exact: true,
    });
    const entry = dialog.getByRole("button", {
      name: dictionary["workbench.experiment.title"],
    });
    await entry.click();
    const tool = dialog.getByRole("region", {
      name: dictionary["workbench.experiment.title"],
    });
    await expect(
      tool.getByRole("button", {
        name: dictionary["workbench.experiment.export"],
      }),
    ).toBeFocused();
    await expect(tool.locator(".workbench-experiment-columns")).toBeVisible();
    expect(
      await tool
        .locator(".workbench-experiment-columns")
        .evaluate(
          (node) =>
            getComputedStyle(node).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(columns);
    await tool.getByRole("checkbox", { name: "swb.reference.framing" }).check();
    await tool.getByRole("checkbox", { name: "registered-capture" }).check();
    await tool
      .getByRole("textbox", {
        name: new RegExp(dictionary["workbench.experiment.firmware"]),
      })
      .fill("v1.4.2");
    await tool
      .getByRole("button", { name: dictionary["workbench.experiment.preview"] })
      .click();
    await expect(
      tool.getByText(dictionary["workbench.experiment.redactions"]),
    ).toBeVisible();
    await expect(tool).not.toContainText("COM71");
    await expect(tool).not.toContainText("private-serial");
    await tool
      .getByRole("button", { name: dictionary["workbench.experiment.save"] })
      .click();
    await expect(
      tool.getByText(dictionary["workbench.experiment.saved"]),
    ).toBeVisible();
    const exported = await page.evaluate(() => ({
      input: window.workbenchFixture.queryInputs.find(
        (query) => query.actionId === "workspace.experiment.export",
      ),
      files: window.workbenchFixture.savedTextExports,
    }));
    expect(exported.input?.params).toMatchObject({
      parsers: ["swb.reference.framing"],
      recordings: [recording],
      firmware: [{ binding: 1, version: "v1.4.2" }],
    });
    expect(exported.files).toEqual([
      {
        name: dictionary["workbench.experiment.fileName"],
        content: JSON.stringify(inspection.experiment),
      },
    ]);

    await tool
      .getByRole("button", { name: dictionary["workbench.experiment.import"] })
      .click();
    const file = `Modbus-${"long-experiment-plan-".repeat(8)}.json`;
    await tool.locator('input[type="file"]').setInputFiles({
      name: file,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(inspection.experiment)),
    });
    await expect(
      tool.getByRole("textbox", {
        name: dictionary["workbench.experiment.packageFile"],
      }),
    ).toHaveValue(file);
    await expect(
      tool.getByText(dictionary["workbench.experiment.changed"], {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      tool.getByText(dictionary["workbench.experiment.otherHost"], {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      tool.getByText(dictionary["workbench.experiment.verifyFirmware"], {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.workbenchFixture.workspaceWrites),
    ).toEqual([]);
    expect(
      await tool
        .locator(".workbench-workspace-content")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(
      await page
        .getByText(
          language === "zh"
            ? "应用发生错误，请查看诊断信息"
            : "Application error. See diagnostics.",
          { exact: true },
        )
        .isVisible(),
    ).toBe(false);
    await dialog.screenshot({
      path: info.outputPath("experiment-preview.png"),
    });
    await tool
      .getByRole("button", {
        name: dictionary["workbench.experiment.confirmImport"],
      })
      .click();
    await expect(
      tool.getByText(dictionary["workbench.experiment.imported"]),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.workbenchFixture.workspaceWrites),
    ).toEqual([
      {
        ...inspection.experiment.workspace,
        name: workspace.name,
      },
    ]);
    await tool
      .getByRole("button", { name: dictionary["workbench.experiment.back"] })
      .click();
    await expect(entry).toBeFocused();
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}
