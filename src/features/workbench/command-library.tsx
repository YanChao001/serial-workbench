import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ListTreeIcon } from "lucide-react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type {
  CommandDraft,
  CommandGroup,
  CommandLibraryChange,
  CommandLibraryReadResult,
  CommandSummary,
  LineEnding,
} from "@serial-workbench/contracts";
import {
  HexInputError,
  parseHex,
  formatHex,
} from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorText } from "@/lib/native-error";
import { ENCODING_NAMES, isTextEncoding } from "@/lib/text-encoding";
import { useI18n } from "@/providers/i18n";
import type { CommandLibraryAccess } from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { WorkbenchDialog } from "./workbench-dialog";
import { WorkbenchIconButton } from "./workbench-icon-button";

export type CommandLibrarySource = {
  access: CommandLibraryAccess;
  workspaceId: string;
  scope: string;
};

type Page<Item> = {
  items: Item[];
  cursors: Array<string | undefined>;
  next?: string;
};

type Editor =
  | { kind: "group"; value: CommandGroup; revision: string; isNew: boolean }
  | { kind: "command"; value: CommandDraft; revision: string; isNew: boolean };

type LibrarySession = {
  controller: AbortController;
  initial: Promise<CommandLibraryReadResult>;
};

export function CommandLibraryButton({
  access,
  workspaceId,
  scope,
}: CommandLibrarySource) {
  const { t } = useI18n();
  const [session, setSession] = useState<LibrarySession>();
  const pending = useRef<AbortController | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => () => pending.current?.abort(), []);
  function close() {
    pending.current?.abort();
    pending.current = undefined;
    setSession(undefined);
  }
  return (
    <>
      <WorkbenchIconButton
        ref={trigger}
        label={t("commandLibrary.title")}
        onClick={() => {
          if (pending.current) return;
          const controller = new AbortController();
          pending.current = controller;
          const initial = access.open(workspaceId, controller.signal);
          void initial.catch(() => {});
          setSession({ controller, initial });
        }}
      >
        <ListTreeIcon aria-hidden="true" />
      </WorkbenchIconButton>
      <WorkbenchDialog
        open={!!session}
        scopeKey={scope}
        title={t("commandLibrary.title")}
        closeLabel={t("common.close")}
        returnFocus={trigger}
        onRequestClose={close}
      >
        {session && (
          <CommandLibraryPanel
            key={scope}
            access={access}
            workspaceId={workspaceId}
            session={session}
          />
        )}
      </WorkbenchDialog>
    </>
  );
}

function groupPage(
  { records }: CommandLibraryReadResult,
  cursors: Page<CommandGroup>["cursors"],
): Page<CommandGroup> {
  if (records.view !== "groups") throw new ContractValidationError();
  return {
    items: records.groups,
    cursors,
    next: records.nextCursor ?? undefined,
  };
}

function commandPage(
  { records }: CommandLibraryReadResult,
  cursors: Page<CommandSummary>["cursors"],
): Page<CommandSummary> {
  if (records.view !== "commands") throw new ContractValidationError();
  return {
    items: records.commands,
    cursors,
    next: records.nextCursor ?? undefined,
  };
}

function pageButtons<Item>(
  page: Page<Item> | undefined,
  go: (cursors: Page<Item>["cursors"]) => void,
  label: string,
  previous: string,
  next: string,
) {
  if (!page || (!page.next && page.cursors.length <= 1)) return null;
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page.cursors.length <= 1}
        onClick={() => go(page.cursors.slice(0, -1))}
      >
        {previous}
      </Button>
      <span className="text-sm tabular-nums">{page.cursors.length}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!page.next}
        onClick={() => go([...page.cursors, page.next])}
      >
        {next}
      </Button>
    </nav>
  );
}

function CommandLibraryPanel({
  access,
  workspaceId,
  session,
}: {
  access: CommandLibraryAccess;
  workspaceId: string;
  session: LibrarySession;
}) {
  const { t } = useI18n();
  const id = useId();
  const [groups, setGroups] = useState<Page<CommandGroup>>();
  const [commands, setCommands] = useState<Page<CommandSummary>>();
  const [group, setGroup] = useState<CommandGroup>();
  const [revision, setRevision] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<{ error: unknown }>();
  const [saved, setSaved] = useState(false);
  const [picked, setPicked] = useState<CommandSummary>();
  const dragging = useRef<CommandSummary | undefined>(undefined);
  const working = useRef(true);
  const owner = session.controller.signal;
  const writable = access.change !== undefined;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await session.initial;
        if (!active || owner.aborted) return;
        setGroups(groupPage(result, [undefined]));
        setRevision(result.revision);
      } catch (error: unknown) {
        if (active && !owner.aborted) setProblem({ error });
      } finally {
        if (active && !owner.aborted) {
          working.current = false;
          setBusy(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [session, owner]);

  async function run(
    task: (signal: AbortSignal) => Promise<void>,
    additional?: AbortSignal,
  ) {
    const signal = additional ? AbortSignal.any([additional, owner]) : owner;
    if (working.current || signal.aborted) return false;
    working.current = true;
    setBusy(true);
    setSaved(false);
    setProblem(undefined);
    try {
      await task(signal);
      return !signal.aborted;
    } catch (error: unknown) {
      if (!signal.aborted) setProblem({ error });
      return false;
    } finally {
      working.current = false;
      if (!owner.aborted) setBusy(false);
    }
  }

  async function fetchCommands(
    selected: CommandGroup,
    atRevision: string,
    cursors: Page<CommandSummary>["cursors"],
    signal: AbortSignal,
  ) {
    const result = await access.read(
      workspaceId,
      {
        selection: {
          view: "commands",
          groupId: selected.id,
          after: cursors.at(-1),
        },
        revision: atRevision,
      },
      signal,
    );
    signal.throwIfAborted();
    return commandPage(result, cursors);
  }

  async function reload(signal: AbortSignal, keepGroup?: CommandGroup) {
    const result = await access.read(
      workspaceId,
      { selection: { view: "groups" } },
      signal,
    );
    signal.throwIfAborted();
    const page = groupPage(result, [undefined]);
    const selected = page.items.find(({ id }) => id === keepGroup?.id);
    setGroups(page);
    setRevision(result.revision);
    setGroup(selected);
    setCommands(undefined);
    if (selected)
      setCommands(
        await fetchCommands(selected, result.revision, [undefined], signal),
      );
  }

  function browseGroups(cursors: Page<CommandGroup>["cursors"]) {
    if (revision === undefined) return;
    void run(async (signal) => {
      const result = await access.read(
        workspaceId,
        {
          selection: { view: "groups", after: cursors.at(-1) },
          revision,
        },
        signal,
      );
      signal.throwIfAborted();
      setGroups(groupPage(result, cursors));
    });
  }

  function browseCommands(
    selected: CommandGroup,
    cursors: Page<CommandSummary>["cursors"],
  ) {
    if (revision === undefined) return;
    void run(async (signal) => {
      const page = await fetchCommands(selected, revision, cursors, signal);
      signal.throwIfAborted();
      setGroup(selected);
      setCommands(page);
    });
  }

  function openCommand(command: CommandSummary) {
    if (revision === undefined) return;
    void run(async (signal) => {
      const result = await access.read(
        workspaceId,
        {
          selection: { view: "entry", id: command.id },
          revision,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.records.view !== "entry") throw new ContractValidationError();
      beginEdit({
        kind: "command",
        value: result.records.command,
        revision,
        isNew: false,
      });
    });
  }

  function discard() {
    setDirty(false);
    setEditor(undefined);
  }

  async function commit(
    change: CommandLibraryChange,
    atRevision: string,
    additional?: AbortSignal,
  ) {
    const save = access.change;
    if (!save) return false;
    let accepted = false;
    await run(async (signal) => {
      await save(workspaceId, atRevision, change, signal);
      signal.throwIfAborted();
      accepted = true;
      discard();
      setPicked(undefined);
      setRevision(undefined);
      setGroups(undefined);
      setCommands(undefined);
      setSaved(true);
      // 保存与随后的页面读取独立结算，刷新失败不撤销已提交的写入。
      await reload(signal, change.kind === "saveGroup" ? change.group : group);
    }, additional);
    return accepted;
  }

  function saveEditor(additional?: AbortSignal) {
    if (!editor || invalidEnding) return Promise.resolve(false);
    return commit(
      editor.kind === "group"
        ? { kind: "saveGroup", group: editor.value }
        : { kind: "saveCommand", command: editor.value },
      editor.revision,
      additional,
    );
  }

  function move(
    command: CommandSummary | undefined,
    destination: CommandGroup,
    before?: string,
  ) {
    if (!command || !revision || command.id === before || editor) return;
    void commit(
      { kind: "moveCommand", id: command.id, groupId: destination.id, before },
      revision,
    );
  }

  const [endingInput, setEndingInput] = useState<string>();
  const invalidEnding =
    endingInput !== undefined && customEndingBytes(endingInput) === undefined;
  const [deletePending, setDeletePending] = useState(false);
  function beginEdit(next: Editor) {
    setProblem(undefined);
    setEndingInput(undefined);
    setDeletePending(false);
    setEditor(next);
  }

  function changeEditor(next: Editor) {
    setEditor(next);
    setDirty(true);
  }

  useUnsavedWork({
    id: "command-library-" + id,
    label: t("commandLibrary.title"),
    dirty,
    save:
      writable && !invalidEnding
        ? async (signal) => {
            if (!(await saveEditor(signal)))
              throw new Error(t("commandLibrary.unsaved"));
          }
        : undefined,
    discard,
  });

  const canBrowse = !editor && revision !== undefined;
  const readyToSave =
    editor &&
    (editor.kind === "group"
      ? editor.value.name.trim()
      : editor.value.summary.name.trim()) &&
    !invalidEnding;
  function startDrag(event: React.DragEvent, command: CommandSummary) {
    dragging.current = command;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-swb-command", "move");
  }

  return (
    <div className="grid gap-3" aria-busy={busy}>
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {busy && <span role="status">{t("common.loading")}</span>}
        {saved && <span role="status">{t("commandLibrary.saved")}</span>}
        {problem && (
          <span role="alert" className="text-destructive">
            {nativeErrorText(problem.error, t)}
          </span>
        )}
        {problem && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run((signal) => reload(signal, group))}
          >
            {t("common.reload")}
          </Button>
        )}
      </div>
      {!editor && (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section
            aria-labelledby={id + "-groups"}
            className="grid content-start gap-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={id + "-groups"} className="font-medium">
                {t("commandLibrary.groups")}
              </h3>
              {writable && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !canBrowse}
                  onClick={() =>
                    revision !== undefined &&
                    beginEdit({
                      kind: "group",
                      value: { id: crypto.randomUUID(), name: "" },
                      revision,
                      isNew: true,
                    })
                  }
                >
                  {t("commandLibrary.addGroup")}
                </Button>
              )}
            </div>
            {groups?.items.length === 0 && (
              <p className="text-sm">{t("commandLibrary.noGroups")}</p>
            )}
            <fieldset disabled={busy} className="grid gap-2">
              <ul className="grid max-h-56 gap-1 overflow-y-auto">
                {groups?.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex min-w-0 gap-1"
                    onDragOver={(event) => {
                      if (writable && !busy && dragging.current)
                        event.preventDefault();
                    }}
                    onDrop={(event) => {
                      if (!dragging.current || busy) return;
                      event.preventDefault();
                      move(dragging.current, item);
                    }}
                  >
                    <Button
                      type="button"
                      size="sm"
                      aria-pressed={group?.id === item.id}
                      className="min-w-0 flex-1 justify-start"
                      variant={group?.id === item.id ? "secondary" : "ghost"}
                      onClick={() => browseCommands(item, [undefined])}
                    >
                      <span className="truncate">{item.name}</span>
                    </Button>
                    {writable && group?.id === item.id && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          revision !== undefined &&
                          beginEdit({
                            kind: "group",
                            value: item,
                            revision,
                            isNew: false,
                          })
                        }
                      >
                        {t("commandLibrary.editGroup")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {pageButtons(
                groups,
                browseGroups,
                t("commandLibrary.groups"),
                t("commandLibrary.previous"),
                t("commandLibrary.next"),
              )}
            </fieldset>
          </section>
          <section
            aria-labelledby={id + "-commands"}
            className="grid content-start gap-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3
                id={id + "-commands"}
                className="min-w-0 break-words font-medium"
              >
                {group?.name ?? t("commandLibrary.commands")}
              </h3>
              {writable && group && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !canBrowse}
                  onClick={() =>
                    revision !== undefined &&
                    beginEdit({
                      kind: "command",
                      value: {
                        summary: {
                          id: crypto.randomUUID(),
                          groupId: group.id,
                          name: "",
                          note: "",
                        },
                        body: "",
                        mode: "text",
                        encoding: "utf-8",
                      },
                      revision,
                      isNew: true,
                    })
                  }
                >
                  {t("commandLibrary.addCommand")}
                </Button>
              )}
            </div>
            {picked && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span role="status">
                  {t("commandLibrary.moving", { name: picked.name })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setPicked(undefined)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !group}
                  onClick={() => group && move(picked, group)}
                >
                  {t("commandLibrary.placeLast")}
                </Button>
              </div>
            )}
            {commands?.items.length === 0 && (
              <p className="text-sm">{t("commandLibrary.noCommands")}</p>
            )}
            <fieldset disabled={busy} className="grid gap-2">
              <ul className="grid max-h-56 gap-1 overflow-y-auto">
                {commands?.items.map((command) => (
                  <li
                    key={command.id}
                    className="flex min-w-0 flex-wrap items-center gap-1"
                    draggable={writable && !busy}
                    onDragStart={(event) => startDrag(event, command)}
                    onDragEnd={() => {
                      dragging.current = undefined;
                    }}
                    onDragOver={(event) => {
                      if (
                        !busy &&
                        dragging.current &&
                        dragging.current.id !== command.id
                      )
                        event.preventDefault();
                    }}
                    onDrop={(event) => {
                      if (!dragging.current || !group || busy) return;
                      event.preventDefault();
                      move(dragging.current, group, command.id);
                    }}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start"
                      onClick={() => openCommand(command)}
                    >
                      <span className="truncate">{command.name}</span>
                    </Button>
                    {command.note && (
                      <span className="min-w-0 basis-full break-words px-2 text-xs text-muted-foreground">
                        {command.note}
                      </span>
                    )}
                    {writable &&
                      (picked && picked.id !== command.id ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t("commandLibrary.placeBeforeName", {
                            name: command.name,
                          })}
                          onClick={() =>
                            group && move(picked, group, command.id)
                          }
                        >
                          {t("commandLibrary.placeBefore")}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t("commandLibrary.moveName", {
                            name: command.name,
                          })}
                          aria-pressed={picked?.id === command.id}
                          onClick={() => setPicked(command)}
                        >
                          {t("commandLibrary.move")}
                        </Button>
                      ))}
                  </li>
                ))}
              </ul>
              {pageButtons(
                commands,
                (cursors) => group && browseCommands(group, cursors),
                t("commandLibrary.commands"),
                t("commandLibrary.previous"),
                t("commandLibrary.next"),
              )}
            </fieldset>
          </section>
        </div>
      )}
      {editor && (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (readyToSave) void saveEditor();
          }}
        >
          <fieldset className="grid gap-3" disabled={busy || !writable}>
            <label className="grid gap-1 text-sm">
              {t("commandLibrary.name")}
              <Input
                required
                maxLength={192}
                value={
                  editor.kind === "group"
                    ? editor.value.name
                    : editor.value.summary.name
                }
                onChange={(event) =>
                  changeEditor(
                    editor.kind === "group"
                      ? {
                          ...editor,
                          value: { ...editor.value, name: event.target.value },
                        }
                      : {
                          ...editor,
                          value: {
                            ...editor.value,
                            summary: {
                              ...editor.value.summary,
                              name: event.target.value,
                            },
                          },
                        },
                  )
                }
              />
            </label>
            {editor.kind === "command" && (
              <CommandFields
                command={editor.value}
                endingInput={endingInput}
                invalidEnding={invalidEnding}
                onEndingInput={setEndingInput}
                onChange={(value) => changeEditor({ ...editor, value })}
                onInvalidEdit={() => setDirty(true)}
              />
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {writable && (
              <Button size="sm" type="submit" disabled={busy || !readyToSave}>
                {t("common.save")}
              </Button>
            )}
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={discard}
            >
              {t(dirty ? "common.cancel" : "common.close")}
            </Button>
            {writable && !editor.isNew && (
              <Button
                size="sm"
                type="button"
                variant={deletePending ? "destructive" : "ghost"}
                disabled={busy}
                onClick={() => {
                  if (!deletePending) {
                    setDeletePending(true);
                    return;
                  }
                  void commit(
                    editor.kind === "group"
                      ? { kind: "deleteGroup", id: editor.value.id }
                      : { kind: "deleteCommand", id: editor.value.summary.id },
                    editor.revision,
                  );
                }}
              >
                {t(
                  deletePending
                    ? "commandLibrary.confirmDelete"
                    : "common.delete",
                )}
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function customEndingBytes(input: string) {
  try {
    const bytes = parseHex(input);
    return bytes.length <= 768 ? bytes : undefined;
  } catch (error: unknown) {
    if (!(error instanceof HexInputError)) throw error;
    return undefined;
  }
}

function CommandFields({
  command,
  endingInput,
  invalidEnding,
  onEndingInput,
  onChange,
  onInvalidEdit,
}: {
  command: CommandDraft;
  endingInput?: string;
  invalidEnding: boolean;
  onEndingInput: (value?: string) => void;
  onChange: (command: CommandDraft) => void;
  onInvalidEdit: () => void;
}) {
  const { t } = useI18n();
  const custom =
    command.lineEnding?.kind === "custom" ? command.lineEnding : undefined;
  const endingKinds = [
    "inherit",
    "none",
    "cr",
    "lf",
    "crlf",
    "custom",
  ] as const;
  return (
    <>
      <label className="grid gap-1 text-sm">
        {t("commandLibrary.note")}
        <Input
          maxLength={1024}
          value={command.summary.note}
          onChange={(event) =>
            onChange({
              ...command,
              summary: { ...command.summary, note: event.target.value },
            })
          }
        />
      </label>
      <label className="grid gap-1 text-sm">
        {t("commandLibrary.body")}
        <Textarea
          rows={5}
          maxLength={65536}
          value={command.body}
          spellCheck={false}
          className="font-mono"
          onChange={(event) =>
            onChange({ ...command, body: event.target.value })
          }
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          {t("commandLibrary.mode")}
          <select
            className="material-control h-8 rounded-md border px-2"
            value={command.mode}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "text" || mode === "hex")
                onChange({ ...command, mode });
            }}
          >
            <option value="text">{t("commandLibrary.text")}</option>
            <option value="hex">HEX</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("commandLibrary.encoding")}
          <select
            className="material-control h-8 rounded-md border px-2"
            value={command.encoding}
            onChange={(event) => {
              if (isTextEncoding(event.target.value))
                onChange({ ...command, encoding: event.target.value });
            }}
          >
            {Object.entries(ENCODING_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("commandLibrary.ending")}
          <select
            className="material-control h-8 rounded-md border px-2"
            value={command.lineEnding?.kind ?? "inherit"}
            onChange={(event) => {
              const kind = endingKinds.find(
                (value) => value === event.target.value,
              );
              if (!kind) return;
              const lineEnding: LineEnding | undefined =
                kind === "inherit"
                  ? undefined
                  : kind === "custom"
                    ? { kind, bytesBase64: "" }
                    : { kind };
              onEndingInput(undefined);
              onChange({ ...command, lineEnding });
            }}
          >
            {endingKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind === "inherit"
                  ? t("commandLibrary.inheritEnding")
                  : kind === "none"
                    ? t("commandLibrary.noEnding")
                    : kind === "custom"
                      ? t("commandLibrary.customEnding")
                      : kind.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      {custom && (
        <label className="grid gap-1 text-sm">
          {t("commandLibrary.customEnding")}
          <Input
            aria-invalid={invalidEnding}
            value={
              endingInput ??
              formatHex(
                Uint8Array.from(atob(custom.bytesBase64), (byte) =>
                  byte.charCodeAt(0),
                ),
              )
            }
            onChange={(event) => {
              const value = event.target.value;
              onEndingInput(value);
              const bytes = customEndingBytes(value);
              if (!bytes) {
                onInvalidEdit();
                return;
              }
              onChange({
                ...command,
                lineEnding: {
                  kind: "custom",
                  bytesBase64: bytesToBase64(bytes),
                },
              });
            }}
          />
          {invalidEnding && (
            <span role="alert" className="text-destructive">
              {t("commandLibrary.invalidHex")}
            </span>
          )}
        </label>
      )}
    </>
  );
}
