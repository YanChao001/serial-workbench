/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  CommandDraft,
  CommandGroup,
  CommandLibraryChange,
  CommandLibraryReadParams,
} from "@serial-workbench/contracts";
import { operation } from "../../src/features/workbench/test-fixtures";
import { defaults } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const title = "Command library";
const bodyFileName = "fixture-payload-with-null-and-high-bytes.bin";
const smallBodyBytes = Buffer.from([0, 255, 36, 123]);

declare global {
  interface Window {
    commandLibraryFixture: { acceptedWrites: number; bodyReads: number };
  }
}

async function mockLibrary(
  page: Page,
  options: {
    holdFirstOpen?: boolean;
    fileLength?: string;
    holdBodyRead?: boolean;
    language?: "en" | "zh";
  } = {},
) {
  const libraryTitle = options.language === "zh" ? "命令库" : title;
  const bodyBytes =
    options.fileLength === "21845"
      ? Buffer.alloc(21_845, 0xa5)
      : smallBodyBytes;
  const bodyFile =
    options.fileLength === undefined
      ? undefined
      : {
          reference: {
            hostId: "workbench-gui-host",
            kind: "file",
            id: "command-body-fixture",
            revision: "1",
          } as const,
          name: bodyFileName,
          length: options.fileLength,
          mime: "application/octet-stream",
        };
  await seedWorkbenchFixture(page, {
    language: options.language ?? "en",
    theme: options.language === "zh" ? "dark" : "light",
    transferSource: bodyFile,
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
  const entry = page.getByRole("button", { name: libraryTitle, exact: true });
  await expect(entry).toBeVisible();
  await page.evaluate(
    ({ receiptJson, options, bodyFile, bytesBase64, fingerprint }) => {
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
      let failNextSave = false;
      window.commandLibraryFixture = { acceptedWrites: 0, bodyReads: 0 };
      let pending:
        | { id: string; change?: CommandLibraryChange; workspace: string }
        | undefined;
      let hold = options.holdFirstOpen;
      let cancelFirstSourcePick = true;
      const fileRef = (id: string) => ({
        hostId: base.executionHostId,
        kind: "file",
        id,
        revision: "1",
      });
      window.addEventListener("allow-library-save", () => {
        allowedToSettle = true;
      });
      window.addEventListener("fail-library-save", () => {
        failNextSave = true;
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
          actionId: change
            ? "workspace.commands.change"
            : "workspace.commands.import",
          target: {
            kind: "workspace",
            id: workspace,
            hostId: base.executionHostId,
          },
          revealTarget: { pageId: "workbench", workspaceId: workspace },
        };
        if (!allowedToSettle) return { ...receipt, state: "queued" };
        if (!change)
          groups
            .get(workspace)
            ?.push({ id: "imported", name: "Imported archive" });
        else if (change.kind === "saveGroup")
          groups.get(workspace)?.push(change.group);
        else if (change.kind === "saveCommand") {
          if (failNextSave) {
            pending = undefined;
            failNextSave = false;
            return {
              ...receipt,
              state: "failed",
              revision: "2",
              error: {
                code: "REVISION_CONFLICT",
                message: "Fixture save conflict",
                retryable: false,
              },
            };
          }
          const index = commands.findIndex(
            ({ summary }) => summary.id === change.command.summary.id,
          );
          if (index < 0) commands.push(change.command);
          else commands[index] = change.command;
        } else if (change.kind === "moveCommand") {
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
        if (
          bodyFile &&
          (command === "host_request" || command === "host_raw_request")
        ) {
          const query = (
            args.request as {
              params?: import("@serial-workbench/contracts").Call;
            }
          ).params;
          if (query?.target.id === bodyFile.reference.id) {
            if (
              command === "host_request" &&
              query.actionId === "file.metadata"
            )
              return {
                ok: true,
                result: {
                  kind: "file_metadata",
                  value: {
                    fileRef: bodyFile.reference,
                    purpose: "read_file",
                    length: bodyFile.length,
                    fingerprint,
                  },
                },
              };
            if (
              command === "host_raw_request" &&
              query.actionId === "file.read"
            ) {
              if (
                query.params.offset !== "0" ||
                query.params.maxBytes !== bodyFile.length
              )
                throw new Error(
                  "Command file was not read at its verified size",
                );
              window.commandLibraryFixture.bodyReads++;
              if (options.holdBodyRead)
                await new Promise<void>((resolve) =>
                  window.addEventListener(
                    "release-command-body",
                    () => resolve(),
                    { once: true },
                  ),
                );
              return {
                ok: true,
                result: {
                  kind: "file_read",
                  value: {
                    fileRef: bodyFile.reference,
                    offset: "0",
                    nextOffset: bodyFile.length,
                    totalBytes: bodyFile.length,
                    fingerprint,
                    bytesBase64,
                    atEnd: true,
                  },
                },
              };
            }
          }
        }
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
        if (
          command === "choose_file_resource" &&
          (args.role === "commandArchiveSource" ||
            args.role === "commandArchiveTarget")
        ) {
          const role = args.role;
          window.workbenchFixture.filePickerCalls.push({
            role,
            generation: String(args.generation),
            captureNameHint: null,
          });
          if (role === "commandArchiveSource" && cancelFirstSourcePick) {
            cancelFirstSourcePick = false;
            return null;
          }
          return {
            reference: fileRef(
              role === "commandArchiveSource"
                ? "archive-source"
                : "archive-target",
            ),
            name: "commands.swb-commands.jsonl",
            mime: "application/jsonl",
            length: "24",
          };
        }
        if (command === "host_apply_document_intent") {
          const intent = args.intent as {
            kind: string;
            workspaceId: string;
            expectedRevision: string;
            params: CommandLibraryChange & { fileRef?: { id: string } };
          };
          if (
            intent.kind === "commandLibraryChange" ||
            intent.kind === "commandLibraryImport"
          ) {
            if (
              intent.kind === "commandLibraryImport" &&
              intent.params.fileRef?.id !== "archive-source"
            )
              throw new Error("Import lost the chosen archive reference");
            if (String(revision) !== intent.expectedRevision)
              throw { code: "REVISION_CONFLICT" };
            window.commandLibraryFixture.acceptedWrites += 1;
            pending = {
              id: crypto.randomUUID(),
              change:
                intent.kind === "commandLibraryChange"
                  ? intent.params
                  : undefined,
              workspace: intent.workspaceId,
            };
            allowedToSettle = false;
            return acknowledge();
          }
        }
        if (command === "host_request") {
          const request = args.request as {
            method: string;
            params?: import("@serial-workbench/contracts").Call;
          };
          const query = request.params;
          if (
            request.method === "action.invoke" &&
            query?.actionId === "workspace.commands.export"
          ) {
            const file = query.params.fileRef as { id: string };
            if (
              file?.id !== "archive-target" ||
              query.expectedRevision !== String(revision) ||
              query.target.id !== "default"
            )
              throw new Error(
                "Export lost the workspace revision or selected file",
              );
            window.workbenchFixture.invocations.push(query);
            return {
              ok: true,
              result: {
                operation: {
                  ...base,
                  actionId: "workspace.commands.export",
                  target: query.target,
                  result: {
                    kind: "reference",
                    value: { resultRef: fileRef("published-archive") },
                  },
                },
              },
            };
          }
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
      options,
      bodyFile,
      bytesBase64: bodyBytes.toString("base64"),
      fingerprint: createHash("sha256").update(bodyBytes).digest("hex"),
    },
  );
  const dialog = page.getByRole("dialog", { name: libraryTitle, exact: true });
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

test("command drafts undo and redo across fields without writing or sending", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  const { entry, dialog } = await mockLibrary(page);
  const undo = dialog.getByRole("button", { name: "Undo edit", exact: true });
  const redo = dialog.getByRole("button", { name: "Redo edit", exact: true });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  const encoding = dialog.getByRole("combobox", { name: "Send encoding" });
  const ending = dialog.getByRole("combobox", { name: "Command line ending" });
  const body = dialog.getByRole("textbox", { name: /Command body/ });
  const suffix = dialog.getByRole("textbox", {
    name: "Custom line ending (HEX)",
  });

  async function openCommand() {
    await entry.click();
    await dialog.getByRole("button", { name: "Modem", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Command 2", exact: true })
      .click();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
  }

  async function chooseOption(control: Locator, name: string) {
    await control.click();
    await page.getByRole("option", { name, exact: true }).click();
  }

  await openCommand();
  await expect(body).toHaveValue("41 42");
  await expect(suffix).toHaveValue("00 FF");
  await chooseOption(ending, "LF");
  await chooseOption(ending, "Custom line ending (HEX)");
  await suffix.press("ControlOrMeta+z");
  await expect(suffix).toHaveCount(0);
  await expect(ending).toBeFocused();
  await ending.press("ControlOrMeta+z");
  await expect(suffix).toHaveValue("00 FF");
  await expect(undo).toBeDisabled();
  await body.fill("41 42 43");
  await chooseOption(encoding, "UTF-16 LE");
  await suffix.fill("0");
  await expect(suffix).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();

  await suffix.press("ControlOrMeta+z");
  await expect(suffix).toBeFocused();
  await expect(suffix).toHaveValue("00 FF");
  await expect(save).toBeEnabled();
  await expect(dialog.getByText("Edit undone.", { exact: true })).toHaveCount(
    1,
  );

  await suffix.press("ControlOrMeta+z");
  await expect(encoding).toHaveText("UTF-8");
  await expect(body).toHaveValue("41 42 43");
  await suffix.press("ControlOrMeta+Shift+z");
  await expect(encoding).toHaveText("UTF-16 LE");

  const history = dialog.getByRole("group", { name: "Edit history" });
  const wideHistory = await history.boundingBox();
  const wideSave = await save.boundingBox();
  if (!wideHistory || !wideSave)
    throw new Error("Missing wide editor controls");
  expect(wideHistory.y).toBe(wideSave.y);
  expect(wideSave.x).toBeGreaterThan(wideHistory.x + wideHistory.width);
  await page.setViewportSize({ width: 420, height: 540 });
  await history.scrollIntoViewIfNeeded();
  const historyBox = await history.boundingBox();
  const saveBox = await save.boundingBox();
  if (!historyBox || !saveBox)
    throw new Error("Missing narrow editor controls");
  expect(saveBox.y).toBeGreaterThan(historyBox.y);
  await redo.click();
  await expect(redo).toBeFocused();
  await expect(suffix).toHaveValue("0");
  await expect(save).toBeDisabled();
  await undo.click();
  await expect(suffix).toHaveValue("00 FF");
  await page.screenshot({
    path: info.outputPath("command-edit-history-narrow.png"),
  });
  const note = dialog.getByRole("textbox", { name: "Note", exact: true });
  await note.fill("Pressure bench");
  await expect(redo).toBeDisabled();
  await undo.click();
  await undo.click();
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(body).toHaveValue("41 42");
  await expect(encoding).toHaveText("UTF-8");
  await expect(note).toHaveValue("");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => window.commandLibraryFixture.acceptedWrites),
  ).toBe(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
  await openCommand();
  await body.fill("44 45");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fail-library-save")),
  );
  await save.click();
  await expect(body).toHaveValue("44 45");
  await expect(undo).toBeDisabled();
  await letSaveFinish(page, 1);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(body).toHaveValue("41 42");
  await redo.click();
  await expect(body).toHaveValue("44 45");
  await save.click();
  await letSaveFinish(page, 2);
  await expect(
    dialog.getByText("Command library saved", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await expect(body).toHaveValue("44 45");
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
});

test("command group history groups typing and clears when another group is opened", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page);
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit group", exact: true }).click();
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  const undo = dialog.getByRole("button", { name: "Undo edit", exact: true });
  const redo = dialog.getByRole("button", { name: "Redo edit", exact: true });
  await name.press("End");
  await name.pressSequentially(" lab");
  await expect(name).toHaveValue("Modem lab");
  await name.press("ControlOrMeta+z");
  await expect(name).toHaveValue("Modem");
  await expect(undo).toBeDisabled();
  await redo.click();
  await expect(name).toHaveValue("Modem lab");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Controller", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit group", exact: true }).click();
  await expect(name).toHaveValue("Controller");
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  expect(
    await page.evaluate(() => window.commandLibraryFixture.acceptedWrites),
  ).toBe(0);
});

test("command editor uses the shared keyboard dropdowns before saving in a narrow dialog", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 480, height: 720 });
  const { entry, dialog } = await mockLibrary(page);
  await entry.click();
  const groups = dialog.getByRole("region", { name: "Groups", exact: true });
  const modem = dialog.getByRole("button", { name: "Modem", exact: true });
  await modem.click();
  const commands = dialog.getByRole("region", { name: "Modem", exact: true });
  await expect(groups).toBeVisible();
  await expect(
    commands.getByRole("button", { name: "Command 0", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      commands.evaluate((section) => {
        const groups = section.previousElementSibling;
        if (!groups) throw new Error("Missing the groups section");
        return (
          section.getBoundingClientRect().top -
          groups.getBoundingClientRect().bottom
        );
      }),
    )
    .toBeGreaterThanOrEqual(0);
  await dialog
    .getByRole("button", { name: "New command", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Layout probe");
  await dialog.getByRole("textbox", { name: /Command body/ }).fill("41 42");
  const mode = dialog.getByRole("combobox", { name: "Send format" });
  const encoding = dialog.getByRole("combobox", { name: "Send encoding" });
  const ending = dialog.getByRole("combobox", { name: "Command line ending" });
  await mode.press("Enter");
  const textOption = page.getByRole("option", { name: "Text", exact: true });
  const hexOption = page.getByRole("option", { name: "HEX", exact: true });
  await expect(textOption).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(hexOption).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(mode).toHaveText("HEX");
  await expect(mode).toBeFocused();
  await encoding.click();
  await page.getByRole("option", { name: "UTF-16 LE", exact: true }).click();
  await ending.click();
  await page
    .getByRole("option", { name: "Custom line ending (HEX)", exact: true })
    .click();
  const suffix = dialog.getByRole("textbox", {
    name: "Custom line ending (HEX)",
  });
  await suffix.fill("00 FF");
  const narrow = await Promise.all(
    [mode, encoding, ending].map((control) => control.boundingBox()),
  );
  expect(narrow.map((box) => box?.height)).toEqual([32, 32, 32]);
  expect(narrow[2]!.y).toBeGreaterThan(narrow[0]!.y);
  expect(narrow[2]!.x).toBe(narrow[0]!.x);
  expect(narrow[2]!.x + narrow[2]!.width).toBeCloseTo(
    narrow[1]!.x + narrow[1]!.width,
    0,
  );
  const selectedEnding = ending.getByText("Custom line ending (HEX)", {
    exact: true,
  });
  await expect(selectedEnding).toBeVisible();
  expect(
    await selectedEnding.evaluate(
      (label) => label.scrollWidth - label.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const footer = dialog.locator(
    ".workbench-command-editor > .workbench-tool-footer",
  );
  const narrowSuffix = await suffix.boundingBox();
  const narrowFooter = await footer.boundingBox();
  expect(narrowSuffix!.y + narrowSuffix!.height).toBeLessThanOrEqual(
    narrowFooter!.y,
  );
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  const narrowDialog = await dialog.boundingBox();
  const narrowSave = await save.boundingBox();
  expect(narrowSave!.y).toBeGreaterThanOrEqual(narrowDialog!.y);
  expect(narrowSave!.y + narrowSave!.height).toBeLessThanOrEqual(
    narrowDialog!.y + narrowDialog!.height,
  );
  await dialog.screenshot({
    path: info.outputPath("command-editor-480px.png"),
  });

  await page.setViewportSize({ width: 1240, height: 800 });
  const wide = await Promise.all(
    [mode, encoding, ending].map((control) => control.boundingBox()),
  );
  expect(wide.map((box) => box?.y)).toEqual([
    wide[0]?.y,
    wide[0]?.y,
    wide[0]?.y,
  ]);
  await dialog.screenshot({
    path: info.outputPath("command-editor-1240px.png"),
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await letSaveFinish(page, 1);
  await expect(
    dialog.getByText("Command library saved", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("navigation", { name: "Commands", exact: true })
    .getByRole("button", { name: "Next page", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Layout probe", exact: true })
    .click();
  await expect(mode).toHaveText("HEX");
  await expect(encoding).toHaveText("UTF-16 LE");
  await expect(
    dialog.getByRole("textbox", { name: "Custom line ending (HEX)" }),
  ).toHaveValue("00 FF");
});

test("a file can replace only the command body after confirmation and save", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 480, height: 720 });
  const { entry, dialog } = await mockLibrary(page, { fileLength: "4" });
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  const body = dialog.getByRole("textbox", {
    name: "Command body",
    exact: true,
  });
  const choose = dialog.getByRole("button", {
    name: "Load file…",
    exact: true,
  });
  const preview = dialog.getByRole("group", {
    name: bodyFileName,
    exact: true,
  });
  const undo = dialog.getByRole("button", { name: "Undo edit", exact: true });
  const redo = dialog.getByRole("button", { name: "Redo edit", exact: true });
  const note = dialog.getByRole("textbox", { name: "Note", exact: true });
  const encoding = dialog.getByRole("combobox", {
    name: "Send encoding",
    exact: true,
  });
  const suffix = dialog.getByRole("textbox", {
    name: "Custom line ending (HEX)",
    exact: true,
  });
  await expect(body).toHaveValue("41 42");
  const format = dialog.getByRole("combobox", {
    name: "Send format",
    exact: true,
  });
  await format.click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
  await note.fill("Power-up bytes");
  await body.scrollIntoViewIfNeeded();
  const [x, y] = await body.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return [
      (rect.left + rect.width / 2) * devicePixelRatio,
      (rect.top + rect.height / 2) * devicePixelRatio,
    ];
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.dropTransferFile(-10, -10)),
    )
    .toBe(1);
  await page.evaluate(
    ({ x, y }) => window.workbenchFixture.dropTransferFile(x, y, "99999"),
    { x, y },
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.transferDropClaims),
  ).toEqual([]);
  await page.evaluate(
    ({ x, y }) => window.workbenchFixture.dropTransferFile(x, y),
    { x, y },
  );
  await expect(preview).toContainText(
    "Replace the draft body with 4 bytes as HEX.",
  );
  await expect(preview).toContainText("00 FF 24 7B");
  const replace = preview.getByRole("button", {
    name: "Replace command body",
    exact: true,
  });
  expect((await choose.boundingBox())?.height).toBe(
    (await format.boundingBox())?.height,
  );
  expect((await replace.boundingBox())?.height).toBe(
    (await choose.boundingBox())?.height,
  );
  await expect(format).toHaveText("Text");
  await expect(body).toHaveValue("41 42");
  await dialog.screenshot({
    path: info.outputPath("command-file-replace-480px.png"),
  });
  await preview
    .getByRole("button", { name: "Cancel import", exact: true })
    .click();
  await expect(choose).toBeFocused();
  await expect(body).toHaveValue("41 42");
  await page.setViewportSize({ width: 1240, height: 800 });
  await choose.press("Enter");
  await expect(preview).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("command-file-replace-1240px.png"),
  });
  await preview
    .getByRole("button", { name: "Replace command body", exact: true })
    .press("Enter");
  await expect(body).toBeFocused();
  await expect(body).toHaveValue("00 FF 24 7B");
  await expect(format).toHaveText("HEX");
  await expect(note).toHaveValue("Power-up bytes");
  await expect(encoding).toHaveText("UTF-8");
  await expect(suffix).toHaveValue("00 FF");
  await undo.click();
  await expect(body).toHaveValue("41 42");
  await expect(format).toHaveText("Text");
  await redo.click();
  await expect(body).toHaveValue("00 FF 24 7B");
  await expect(format).toHaveText("HEX");
  expect(
    await page.evaluate(() => window.workbenchFixture.transferDropClaims),
  ).toEqual(["91"]);
  expect(
    await page.evaluate(() => window.commandLibraryFixture.acceptedWrites),
  ).toBe(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await letSaveFinish(page, 1);
  await expect(
    dialog.getByText("Command library saved", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await expect(body).toHaveValue("00 FF 24 7B");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("a narrow Chinese command editor loads the largest supported file", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 600 });
  const { entry, dialog } = await mockLibrary(page, {
    fileLength: "21845",
    language: "zh",
  });
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await dialog
    .getByRole("button", { name: "载入文件…", exact: true })
    .press("Enter");
  const preview = dialog.getByRole("group", {
    name: bodyFileName,
    exact: true,
  });
  await expect(preview).toContainText("21,845 字节");
  await expect(preview.locator("code")).toHaveText("A5 ".repeat(11) + "A5 …");
  await expect(
    page.getByText("设置未保存，仅本次会话生效，请重试。", { exact: true }),
  ).toHaveCount(0);
  await dialog.screenshot({
    path: info.outputPath("command-file-replace-420px-zh.png"),
  });
  await preview
    .getByRole("button", { name: "替换命令正文", exact: true })
    .press("Enter");
  const body = dialog.getByRole("textbox", { name: "命令正文", exact: true });
  await expect(body).toHaveValue("A5 ".repeat(21_844) + "A5");
  await expect(body).toBeFocused();
  expect(
    await page.evaluate(() => window.commandLibraryFixture.acceptedWrites),
  ).toBe(0);
});

for (const [length, message] of [
  ["0", "Choose a file containing at least one byte."],
  ["21846", "The command body can load files up to 21,845 bytes."],
] as const) {
  test(
    "a command draft rejects an invalid file of " +
      length +
      " bytes before reading it",
    async ({ page }) => {
      const { entry, dialog } = await mockLibrary(page, { fileLength: length });
      await entry.click();
      await dialog.getByRole("button", { name: "Modem", exact: true }).click();
      await dialog
        .getByRole("button", { name: "Command 2", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Load file…", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toHaveText(message);
      await expect(
        dialog.getByRole("textbox", { name: "Command body", exact: true }),
      ).toHaveValue("41 42");
      expect(
        await page.evaluate(() => window.commandLibraryFixture.bodyReads),
      ).toBe(0);
    },
  );
}

test("a late command file read cannot edit a reopened command", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page, {
    fileLength: "4",
    holdBodyRead: true,
  });
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Load file…", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.commandLibraryFixture.bodyReads))
    .toBe(1);
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await entry.click();
  await dialog.getByRole("button", { name: "Modem", exact: true }).click();
  await dialog.getByRole("button", { name: "Command 2", exact: true }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-command-body")),
  );
  await expect(
    dialog.getByRole("textbox", { name: "Command body", exact: true }),
  ).toHaveValue("41 42");
  await expect(
    dialog.getByRole("group", { name: bodyFileName, exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.commandLibraryFixture.acceptedWrites),
  ).toBe(0);
});

test("a late opening result cannot populate the command library in another workspace", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page, { holdFirstOpen: true });
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

test("command archive picker cancellation is inert and import refreshes only after the Host receipt", async ({
  page,
}) => {
  const { entry, dialog } = await mockLibrary(page);
  await entry.click();
  const importButton = dialog.getByRole("button", { name: "Import commands…" });
  const exportButton = dialog.getByRole("button", { name: "Export commands…" });
  await importButton.click();
  await expect(importButton).toBeEnabled();
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.queryInputs.filter(
        ({ actionId }) => actionId === "operation.get",
      ),
    ),
  ).toEqual([]);
  await importButton.click();
  await expect(
    dialog.getByRole("button", { name: "Imported archive" }),
  ).toHaveCount(0);
  await letSaveFinish(page, 1);
  await expect(
    dialog.getByText("Command library imported", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Imported archive" }),
  ).toBeVisible();
  await exportButton.click();
  await expect(
    dialog.getByText("Command library exported", { exact: true }),
  ).toBeVisible();
  const picks = await page.evaluate(() =>
    window.workbenchFixture.filePickerCalls.map(({ role }) => role),
  );
  expect(picks).toEqual([
    "commandArchiveSource",
    "commandArchiveSource",
    "commandArchiveTarget",
  ]);
});
