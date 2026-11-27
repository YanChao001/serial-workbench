/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type {
  CommandLibraryReadResult,
  Operation,
  WorkspaceConfiguration,
} from "@serial-workbench/contracts";
import { operation } from "../../src/features/workbench/test-fixtures";
import { defaults } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

declare global {
  interface Window {
    configurationFixture: { apply: unknown[]; exports: unknown[] };
  }
}

const configuration: WorkspaceConfiguration = {
  format: "serial-workbench-configuration",
  version: 1,
  workspace: { ...defaults.workspace, name: "Imported bench" },
  groups: [{ id: "register", name: "Registers" }],
  commands: [
    {
      summary: {
        id: "read",
        groupId: "register",
        name: "Read holding registers",
        note: "",
      },
      mode: "hex",
      encoding: "utf-8",
      body: "01 03 00 00",
    },
  ],
  scripts: [
    {
      packageId: "org.example.modbus",
      version: "1.2.0",
      archiveSha256: "1".repeat(64),
      actionId: "org.example.modbus.read",
    },
  ],
  credentialRefs: [
    { slot: "gateway", hostId: "other-host", referenceId: "opaque-reference" },
  ],
};

test("exports a selected command and previews a configuration package before applying it", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 610 });
  await seedWorkbenchFixture(page, {
    language: "en",
    workspace: { ...defaults.workspace, name: "Existing bench" },
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const workspace = page.getByRole("dialog", {
    name: "Workspace",
    exact: true,
  });
  await expect(
    workspace.getByRole("textbox", { name: "Workspace name" }),
  ).toHaveValue("Existing bench");

  await page.evaluate(
    ({ configuration, receiptJson }) => {
      const receipt = JSON.parse(receiptJson) as Operation;
      const native: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
      const object = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null;
      if (!object(native) || typeof native.invoke !== "function")
        throw new Error("Native fixture is missing");
      const invoke = native.invoke;
      window.configurationFixture = { apply: [], exports: [] };
      const groups: CommandLibraryReadResult = {
        revision: "7",
        records: { view: "groups", groups: configuration.groups },
      };
      const commands: CommandLibraryReadResult = {
        revision: "7",
        records: {
          view: "commands",
          commands: configuration.commands.map((item) => item.summary),
        },
      };
      const packed = JSON.stringify(configuration);
      let commandRevision = "7";
      const target = {
        hostId: "workbench-gui-host",
        kind: "workspace",
        id: "default",
      };
      const saved: Operation = {
        ...receipt,
        executionHostId: target.hostId,
        actionId: "workspace.configuration.import",
        target,
        owner: { kind: "host", id: target.hostId },
        result: {
          kind: "workspace_configuration_import",
          value: {
            workspace: {
              scope: { scopeId: "workspace.default", target },
              document: { revision: "2", value: configuration.workspace },
            },
            commandRevision: "9",
          },
        },
      };
      Reflect.set(
        native,
        "invoke",
        async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "host_open_command_library") return groups;
          const intent = args.intent;
          if (
            command === "host_apply_document_intent" &&
            object(intent) &&
            intent.kind === "workspaceConfigurationImport"
          ) {
            window.configurationFixture.apply.push(intent);
            if (commandRevision === "7") {
              commandRevision = "8";
              throw { code: "REVISION_CONFLICT" };
            }
            return saved;
          }
          const request = args.request;
          if (
            command === "host_request" &&
            object(request) &&
            object(request.params) &&
            request.method === "action.query"
          ) {
            const query = request.params;
            switch (query.actionId) {
              case "workspace.commands.read":
                return {
                  ok: true,
                  result: { kind: "command_library", value: commands },
                };
              case "workspace.configuration.export":
                window.configurationFixture.exports.push(query.params);
                return {
                  ok: true,
                  result: { kind: "document_json", value: { json: packed } },
                };
              case "workspace.configuration.inspect":
                return {
                  ok: true,
                  result: {
                    kind: "workspace_configuration_inspection",
                    value: {
                      configuration,
                      workspaceRevision: "1",
                      commandRevision,
                      scriptStatuses: ["missing"],
                    },
                  },
                };
            }
          }
          return Reflect.apply(invoke, native, [command, args]);
        },
      );
    },
    {
      configuration,
      receiptJson: JSON.stringify(operation(crypto.randomUUID())),
    },
  );

  await workspace
    .getByRole("button", { name: "Export configuration package" })
    .click();
  await page.getByRole("button", { name: "Choose quick commands" }).click();
  await page.getByRole("combobox", { name: "Command group" }).click();
  await page.getByRole("option", { name: "Registers" }).click();
  await page.getByRole("checkbox", { name: "Read holding registers" }).check();
  await expect(page.getByText("Command bodies to include (1)")).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.savedTextExports),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Preview configuration package" })
    .click();
  await expect(
    page.getByText("Workspace revision 1 · Command library revision 7"),
  ).toBeVisible();
  await expect(
    page.getByText("Read holding registers", { exact: true }).last(),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("narrow-configuration-export.png"),
  });
  const savedFile = page.getByRole("button", {
    name: "Save configuration package",
  });
  await savedFile.click();
  await expect(savedFile).toHaveCount(0);
  expect(
    await page.evaluate(() => window.configurationFixture.exports),
  ).toEqual([
    { workspaceRevision: "1", commandRevision: "7", commandIds: ["read"] },
  ]);
  expect(
    await page.evaluate(() => window.workbenchFixture.savedTextExports),
  ).toEqual([
    {
      name: "workspace.swb-config.json",
      content: JSON.stringify(configuration),
    },
  ]);

  await page.setViewportSize({ width: 1240, height: 800 });
  await workspace.getByRole("button", { name: "Import configuration" }).click();
  await workspace.locator('input[type="file"]').setInputFiles({
    name: "workspace.swb-config.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(configuration)),
  });
  await workspace.getByRole("button", { name: "Preview import" }).click();
  await expect(workspace.getByText("Quick commands to add (1)")).toBeVisible();
  await expect(workspace.getByText("Install the signed package")).toBeVisible();
  await expect(
    workspace.getByText("Bind a credential on this Host"),
  ).toBeVisible();
  expect(await page.evaluate(() => window.configurationFixture.apply)).toEqual(
    [],
  );
  await page.screenshot({
    path: info.outputPath("wide-configuration-preview.png"),
  });

  await workspace.getByRole("button", { name: "Apply import" }).click();
  await expect(
    workspace.getByRole("button", { name: "Preview import" }),
  ).toBeVisible();
  await expect(
    workspace.getByText("workspace.swb-config.json", { exact: true }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Preview import" }).click();
  await expect(
    workspace.getByText("Workspace revision 1 · Command library revision 8"),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Apply import" }).click();
  await expect(
    workspace.getByRole("textbox", { name: "Workspace name" }),
  ).toHaveValue("Imported bench");
  expect(await page.evaluate(() => window.configurationFixture.apply)).toEqual([
    {
      kind: "workspaceConfigurationImport",
      workspaceId: "default",
      expectedRevision: "1",
      params: { json: JSON.stringify(configuration), commandRevision: "7" },
    },
    {
      kind: "workspaceConfigurationImport",
      workspaceId: "default",
      expectedRevision: "1",
      params: { json: JSON.stringify(configuration), commandRevision: "8" },
    },
  ]);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});
