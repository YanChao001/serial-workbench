/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import type {
  CommandDraft,
  CommandGroup,
  CommandLibraryChange,
  CommandLibraryReadParams,
  Query,
} from "@serial-workbench/contracts";
import { operation } from "../../src/features/workbench/test-fixtures";
import { defaults } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const title = "Command library";

async function mockLibrary(page: Page, holdFirstOpen = false) {
  await seedWorkbenchFixture(page, {
    language: "en",
    sharedSettings: {
      terminal: {
        receiveMode: "text",
        sendMode: "text",
        lineEnding: { kind: "lf" },
      },
    },
    captureTails: {
      results: {},
      workspaces: { other: { ...defaults.workspace, name: "Bench B" } },
    },
  });
  await page.goto("./#/");
  const entry = page.getByRole("button", { name: title, exact: true });
  await expect(entry).toBeVisible();
  await page.evaluate(
    ({ receiptJson, holdFirstOpen }) => {
      const base = JSON.parse(
        receiptJson,
      ) as import("@serial-workbench/contracts").Operation;
      const native = (
        window as typeof window & {
          __TAURI_INTERNALS__?: {
            invoke(
              command: string,
              args?: Record<string, unknown>,
            ): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!native) throw new Error("Missing native fixture");
      const previous = native.invoke.bind(native);
      const groups = new Map<string, CommandGroup[]>([
        [
          "default",
          [
            { id: "g1", name: "Modem" },
            { id: "g2", name: "Controller" },
          ],
        ],
        ["other", [{ id: "g3", name: "Bench B commands" }]],
      ]);
      const commands: CommandDraft[] = Array.from(
        { length: 33 },
        (_, index) => ({
          summary: {
            id: "c" + index,
            groupId: "g1",
            name: "Command " + index,
            note: "",
          },
          body:
            index === 0
              ? "S=${slot}/$${raw}/${slot}/${optional}"
              : index === 1
                ? "41 ${byte}"
                : index === 2
                  ? "41 42"
                  : "AT",
          mode: index === 1 || index === 2 ? "hex" : "text",
          encoding: index === 0 ? "utf-16le" : "utf-8",
          lineEnding:
            index === 0
              ? { kind: "crlf" }
              : index === 1
                ? { kind: "none" }
                : index === 2
                  ? { kind: "custom", bytesBase64: "AP8=" }
                  : undefined,
        }),
      );
      let revision = 0;
      let allowedToSettle = false;
      let pending:
        | { id: string; change: CommandLibraryChange; workspace: string }
        | undefined;
      let hold = holdFirstOpen;
      window.addEventListener("allow-library-save", () => {
        allowedToSettle = true;
      });
      function read(workspace: string, params: CommandLibraryReadParams) {
        if (params.revision != null && params.revision !== String(revision))
          throw { code: "REVISION_CONFLICT" };
        const selection = params.selection;
        if (selection.view === "entry") {
          const command = commands.find(
            ({ summary }) => summary.id === selection.id,
          );
          if (!command) throw new Error("Missing fixture command");
          return {
            revision: String(revision),
            records: { view: "entry", command },
          };
        }
        const rows =
          selection.view === "groups"
            ? (groups.get(workspace) ?? [])
            : commands
                .filter(({ summary }) => summary.groupId === selection.groupId)
                .map(({ summary }) => summary);
        const start = selection.after
          ? rows.findIndex(({ id }) => id === selection.after) + 1
          : 0;
        const items = rows.slice(start, start + 32);
        return {
          revision: String(revision),
          records: {
            view: selection.view,
            [selection.view]: items,
            nextCursor: rows.length > start + 32 ? items.at(-1)?.id : undefined,
          },
        };
      }
      function acknowledge() {
        if (!pending) throw new Error("Unexpected operation poll");
        const { id, change, workspace } = pending;
        const receipt = {
          ...base,
          operationId: id,
          requestId: id,
          rootOperationId: id,
          actionId: "workspace.commands.change",
          target: {
            kind: "workspace",
            id: workspace,
            hostId: base.executionHostId,
          },
          revealTarget: { pageId: "workbench", workspaceId: workspace },
        };
        if (!allowedToSettle) return { ...receipt, state: "queued" };
        if (change.kind === "saveGroup")
          groups.get(workspace)?.push(change.group);
        else if (change.kind === "moveCommand") {
          const source = commands.findIndex(
            ({ summary }) => summary.id === change.id,
          );
          const item = commands[source];
          if (!item) throw new Error("Missing command to move");
          commands.splice(source, 1);
          const destination = commands.findIndex(
            ({ summary }) => summary.id === change.before,
          );
          item.summary.groupId = change.groupId;
          commands.splice(
            destination < 0 ? commands.length : destination,
            0,
            item,
          );
        } else throw new Error("Unexpected fixture change");
        pending = undefined;
        return {
          ...receipt,
          state: "succeeded",
          revision: "2",
          result: {
            kind: "command_library_revision",
            value: { revision: String(++revision) },
          },
        };
      }
      native.invoke = (async (
        command: string,
        args: Record<string, unknown> = {},
      ) => {
        if (command === "host_open_command_library") {
          const workspace = String(args.workspaceId);
          if (hold) {
            hold = false;
            await new Promise<void>((resolve) =>
              window.addEventListener("release-library-open", () => resolve(), {
                once: true,
              }),
            );
          }
          return read(workspace, { selection: { view: "groups" } });
        }
        if (command === "host_apply_document_intent") {
          const intent = args.intent as {
            kind: string;
            workspaceId: string;
            expectedRevision: string;
            params: CommandLibraryChange;
          };
          if (intent.kind === "commandLibraryChange") {
            if (String(revision) !== intent.expectedRevision)
              throw { code: "REVISION_CONFLICT" };
            pending = {
              id: crypto.randomUUID(),
              change: intent.params,
              workspace: intent.workspaceId,
            };
            allowedToSettle = false;
            return acknowledge();
          }
        }
        if (command === "host_request") {
          const query = (args.request as { params?: Query }).params;
          if (query?.actionId === "workspace.commands.read") {
            window.workbenchFixture.queryInputs.push(query);
            const result = read(
              query.target.id,
              query.params as unknown as CommandLibraryReadParams,
            );
            return {
              ok: true,
              result: { kind: "command_library", value: result },
            };
          }
          if (
            query?.actionId === "operation.get" &&
            pending &&
            query.params.operationId === pending.id
          ) {
            window.workbenchFixture.queryInputs.push(query);
            return {
              ok: true,
              result: {
                kind: "operation",
                value: { operation: acknowledge() },
              },
            };
          }
        }
        return previous(command, args);
      }) as typeof native.invoke;
    },
    {
      receiptJson: JSON.stringify({
        ...operation(crypto.randomUUID()),
        executionHostId: "workbench-gui-host",
        actorId: "workbench-gui-actor",
        owner: { kind: "host", id: "workbench-gui-host" },
      }),
      holdFirstOpen,
    },
  );
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  return { entry, dialog };
}

async function letSaveFinish(page: Page, operations: number) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Set(
            window.workbenchFixture.queryInputs
              .filter(({ actionId }) => actionId === "operation.get")
              .map(({ params }) => params.operationId),
          ).size,
      ),
    )
    .toBe(operations);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("allow-library-save")),
  );
}

test("command library reads one page at a time, moves across pages and waits for the save receipt", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page);
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Command 31", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Command 32", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("navigation", { name: "Commands", exact: true })
    .getByRole("button", { name: "Next page", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Move Command 32", exact: true })
    .click();
  await dialog
    .getByRole("navigation", { name: "Commands", exact: true })
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Place before Command 0", exact: true })
    .click();
  await expect(
    dialog.getByText("Command library saved", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("status").filter({ hasText: "Loading" }),
  ).toBeVisible();
  await letSaveFinish(page, 1);
  await expect(
    dialog.getByText("Command library saved", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Command 32", exact: true }),
  ).toBeVisible();
  const reads = await page.evaluate(() =>
    window.workbenchFixture.queryInputs.filter(
      ({ actionId }) => actionId === "workspace.commands.read",
    ),
  );
  expect(
    reads
      .filter(({ params }) => params.revision === "0")
      .map(({ params }) => params.selection),
  ).toEqual([
    { view: "commands", groupId: "g1" },
    { view: "commands", groupId: "g1", after: "c31" },
    { view: "commands", groupId: "g1" },
  ]);
  await dialog.getByRole("button", { name: "New group", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Recovery");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Recovery");
  await letSaveFinish(page, 2);
  await expect(
    dialog.getByRole("button", { name: "Recovery", exact: true }),
  ).toBeVisible();
});

test("a late opening result cannot populate the command library in another workspace", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page, true);
  await entry.click();
  await expect(dialog).toBeVisible();
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const workspace = page.getByRole("dialog", {
    name: "Workspace",
    exact: true,
  });
  await workspace
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  await page.getByRole("option", { name: "Bench B", exact: true }).click();
  await expect(
    workspace.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Bench B");
  await workspace.press("Escape");
  await expect(workspace).toBeHidden();
  await entry.click();
  await expect(
    dialog.getByRole("button", { name: "Bench B commands", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-library-open")),
  );
  await expect(
    dialog.getByRole("button", { name: "Modem", exact: true }),
  ).toHaveCount(0);
});

test("predefined commands expand variables before send and preserve the selected ending through connection", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page);
  const sender = page.getByRole("region", { name: "Send", exact: true });
  const draft = sender.getByRole("textbox", {
    name: "Send draft",
    exact: true,
  });
  const tx = sender.getByRole("button", { name: "Send", exact: true });
  const count = sender.getByRole("note", { name: "Bytes to send" });
  await draft.fill("previous draft");
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 0", exact: true }).click();
  const use = dialog.getByRole("button", {
    name: "Use as send draft",
    exact: true,
  });
  await expect(use).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Variable slot", exact: true })
    .fill("中");
  await expect(use).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Set variable optional to an empty value" })
    .click();
  await use.click();
  await expect(dialog).toBeHidden();
  const expanded = "S=中/${raw}/中/";
  await expect(draft).toHaveValue(expanded);
  await expect(
    sender.getByText("Command line ending CRLF", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );

  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  await expect(draft).toHaveValue(expanded);
  const restore = sender.getByRole("button", {
    name: "Restore send line ending (LF)",
    exact: true,
  });
  await expect(restore).toBeVisible();

  await sender
    .getByRole("button", { name: "Send checksum", exact: true })
    .click();
  const setup = page.getByRole("dialog", {
    name: "Send checksum",
    exact: true,
  });
  await setup.getByRole("combobox", { name: "Algorithm", exact: true }).click();
  await page.getByRole("option", { name: "Sum-8", exact: true }).click();
  await setup
    .getByRole("checkbox", { name: "Include line ending in calculation" })
    .check();
  const encoded = Buffer.from(expanded + "\r\n", "utf16le");
  const sum = encoded.reduce((value, byte) => (value + byte) % 256, 0);
  await expect(setup.getByLabel("Bytes to append", { exact: true })).toHaveText(
    sum.toString(16).padStart(2, "0").toUpperCase(),
  );
  await setup
    .getByRole("checkbox", { name: "Include line ending in calculation" })
    .press("Escape");
  await expect(setup).toBeHidden();
  const expected = Buffer.concat([encoded, Buffer.from([sum])]);
  await expect(count).toHaveText(expected.length + " B");
  await tx.click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([expected.toString("base64")]);

  await restore.click();
  await expect(
    sender.getByText("Command line ending CRLF", { exact: true }),
  ).toHaveCount(0);
  await expect(
    sender.getByRole("combobox", { name: "Line ending", exact: true }),
  ).toHaveText("LF");
  await expect(count).toHaveText(expected.length - 2 + " B");

  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 1", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Variable byte", exact: true })
    .fill("G0");
  await use.click();
  await expect(draft).toHaveValue("41 G0");
  await expect(
    sender.getByText("Command line ending No suffix", { exact: true }),
  ).toBeVisible();
  await expect(tx).toBeDisabled();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual([
    expected.toString("base64"),
  ]);

  const endings = sender.getByRole("combobox", {
    name: "Line ending",
    exact: true,
  });
  const configureEnding = sender.getByRole("button", {
    name: "Custom line ending",
    exact: true,
  });
  const endingDialog = page.getByRole("dialog", {
    name: "Custom line ending",
    exact: true,
  });
  const suffix = endingDialog.getByRole("textbox", {
    name: "Custom line ending (HEX)",
    exact: true,
  });
  await endings.click();
  await page
    .getByRole("option", { name: "Custom line ending", exact: true })
    .click();
  await configureEnding.click();
  await suffix.fill("21");
  await suffix.press("Escape");
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await use.click();
  await expect(draft).toHaveValue("41 42");
  await configureEnding.click();
  await expect(suffix).toHaveValue("00 FF");
  await suffix.press("Escape");
  await expect(count).toHaveText("5 B");
  await tx.click();
  const custom = Buffer.from([0x41, 0x42, 0x00, 0xff, 0x82]);
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([expected.toString("base64"), custom.toString("base64")]);
});
