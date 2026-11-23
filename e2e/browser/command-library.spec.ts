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
    captureTails: {
      results: {},
      workspaces: { other: { ...defaults.workspace, name: "Bench B" } },
    },
  });
  await page.goto("./#/");
  const entry = page.getByRole("button", { name: title, exact: true });
  await expect(entry).toBeVisible();
  await page.evaluate(
    ({ base, holdFirstOpen }) => {
      const native = window.__TAURI_INTERNALS__;
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
          body: "AT",
          mode: "text",
          encoding: "utf-8",
        }),
      );
      let revision = 0;
      let allowedToSettle = false;
      let pending:
        { change: CommandLibraryChange; workspace: string } | undefined;
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
        const { change, workspace } = pending;
        const receipt = {
          ...base,
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
          const [item] = commands.splice(source, 1);
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
            pending = { change: intent.params, workspace: intent.workspaceId };
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
              query.params as CommandLibraryReadParams,
            );
            return {
              ok: true,
              result: { kind: "command_library", value: result },
            };
          }
          if (
            query?.actionId === "operation.get" &&
            query.params.operationId === base.operationId
          )
            return {
              ok: true,
              result: {
                kind: "operation",
                value: { operation: acknowledge() },
              },
            };
        }
        return previous(command, args);
      }) as typeof native.invoke;
    },
    {
      base: {
        ...operation(crypto.randomUUID()),
        executionHostId: "workbench-gui-host",
        actorId: "workbench-gui-actor",
        owner: { kind: "host", id: "workbench-gui-host" },
      },
      holdFirstOpen,
    },
  );
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  return { entry, dialog };
}

async function letSaveFinish(page: Page) {
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
  await letSaveFinish(page);
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
  await letSaveFinish(page);
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
