import { Command } from "cmdk";
import { useEffect, useRef, useState, type RefObject } from "react";
import { SearchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  commandAvailable,
  type AppCommand,
  type CommandGroup,
} from "@/commands/types";
import {
  formatShortcut,
  sameShortcut,
  shortcutFromEvent,
  SEND_EDITOR_SHORTCUT,
  type Shortcut,
} from "@/commands/shortcuts";
import type { ShortcutBinding } from "@/lib/generated/bindings";
import { useCommands } from "@/providers/commands";
import { useI18n, type DictKey } from "@/providers/i18n";

const GROUPS: Array<{ id: CommandGroup; labelKey: DictKey }> = [
  { id: "navigation", labelKey: "commands.groupNavigation" },
  { id: "appearance", labelKey: "commands.groupAppearance" },
  { id: "window", labelKey: "commands.groupWindow" },
  { id: "tools", labelKey: "commands.groupTools" },
  { id: "help", labelKey: "commands.groupHelp" },
];

export function CommandPalette() {
  const { t } = useI18n();
  const {
    commands,
    execute,
    paletteOpen,
    shortcutHelp,
    changeShortcut,
    setPaletteOpen,
  } = useCommands();
  const [query, setQuery] = useState("");
  const actionsSearch = useRef<HTMLInputElement>(null);
  const shortcutsSearch = useRef<HTMLInputElement>(null);
  const mode = paletteOpen ? (shortcutHelp ? "shortcuts" : "actions") : null;
  useEffect(() => {
    if (!mode) return;
    const frame = requestAnimationFrame(() => {
      (mode === "shortcuts" ? shortcutsSearch : actionsSearch).current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  return (
    <Dialog
      open={paletteOpen}
      onOpenChange={(open) => {
        setPaletteOpen(open);
        if (!open) setQuery("");
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        closeLabel={t("common.close")}
      >
        <DialogHeader className={shortcutHelp ? "px-4 pt-4 pr-12" : "sr-only"}>
          <DialogTitle>
            {t(shortcutHelp ? "commands.shortcuts" : "commands.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              shortcutHelp ? "commands.shortcutSearch" : "commands.description",
            )}
          </DialogDescription>
        </DialogHeader>
        {shortcutHelp ? (
          <ShortcutReference
            commands={commands}
            searchRef={shortcutsSearch}
            changeShortcut={changeShortcut}
          />
        ) : (
          <Command loop label={t("commands.title")} className="flex flex-col">
            <div className="flex items-center border-b px-4 py-1.5 pr-12">
              <div className="relative flex min-w-0 flex-1">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Command.Input
                  ref={actionsSearch}
                  value={query}
                  onValueChange={setQuery}
                  data-surface="transparent"
                  className="w-full min-w-0 bg-transparent pl-9 outline-none"
                  aria-label={t("commands.title")}
                />
              </div>
            </div>
            <Command.List
              data-surface="transparent"
              className="h-[min(60vh,24rem)] overflow-y-auto p-2"
            >
              <Command.Empty className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t("commands.empty")}
              </Command.Empty>
              {GROUPS.map((group) => {
                const items = commands.filter(
                  (command) =>
                    command.id !== "command-palette" &&
                    command.group === group.id &&
                    commandAvailable(command),
                );
                if (!items.length) return null;
                return (
                  <Command.Group
                    key={group.id}
                    heading={t(group.labelKey)}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {items.map((command) => (
                      <Command.Item
                        key={command.id}
                        value={command.id}
                        keywords={[
                          command.label ?? t(command.labelKey),
                          ...(command.keywords ?? []),
                          ...(command.keywordKeys?.map((key) => t(key)) ?? []),
                        ]}
                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-(--surface-state-selected) data-[selected=true]:text-(--surface-selected-foreground)"
                        onSelect={() => {
                          setPaletteOpen(false);
                          setQuery("");
                          void execute(command.id);
                        }}
                      >
                        {command.icon ? (
                          <command.icon className="size-4" aria-hidden="true" />
                        ) : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {command.label ?? t(command.labelKey)}
                          </span>
                          {command.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {command.description}
                            </span>
                          ) : null}
                        </span>
                        {command.shortcuts?.[0] ? (
                          <kbd className="ml-4 font-mono text-[11px] text-muted-foreground">
                            {formatShortcut(command.shortcuts[0])}
                          </kbd>
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShortcutReference({
  commands,
  searchRef,
  changeShortcut,
}: {
  commands: AppCommand[];
  searchRef: RefObject<HTMLInputElement | null>;
  changeShortcut?: (id: string, binding: ShortcutBinding) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const available = commands.filter(commandAvailable);
  const selected = available.find((command) => command.id === editing);
  const defaultShortcut = selected?.defaultShortcut;
  function finishEditing() {
    setEditing(undefined);
    requestAnimationFrame(() => {
      const button = trigger.current;
      (button?.isConnected ? button : searchRef.current)?.focus();
    });
  }
  const bindings = available.flatMap((command) =>
    (command.shortcuts ?? []).map((shortcut) => ({
      id: command.id,
      label: command.label ?? t(command.labelKey),
      key: formatShortcut(shortcut),
      editable: !!command.defaultShortcut && !!changeShortcut,
    })),
  );
  const ownersByKey = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const key = binding.key.toLowerCase();
    const owners = ownersByKey.get(key) ?? new Set<string>();
    owners.add(binding.id);
    ownersByKey.set(key, owners);
  }
  const rows = [
    ...bindings.map((binding) => ({
      ...binding,
      note:
        (ownersByKey.get(binding.key.toLowerCase())?.size ?? 0) > 1
          ? t("commands.shortcutConflict")
          : "",
    })),
    {
      id: "send-editor",
      label: t("commands.shortcutSend"),
      key: formatShortcut(SEND_EDITOR_SHORTCUT),
      note: t("commands.shortcutSendContext"),
      editable: false,
    },
  ];
  const terms = query.toLowerCase().trim().split(/\s+/);
  const matches = rows.filter(({ label, key, note }) => {
    const searchable = `${label} ${key} ${note}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });

  return (
    <>
      <div className="border-b p-4">
        <Input
          ref={searchRef}
          type="search"
          aria-label={t("commands.shortcutSearch")}
          placeholder={t("commands.shortcutSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full"
        />
      </div>
      {selected && defaultShortcut && changeShortcut && (
        <ShortcutEditor
          key={selected.id}
          label={selected.label ?? t(selected.labelKey)}
          defaultShortcut={defaultShortcut}
          commands={available.filter((command) => command.id !== selected.id)}
          onCancel={finishEditing}
          onSave={(binding) => {
            changeShortcut(selected.id, binding);
            finishEditing();
          }}
        />
      )}
      <div className="h-[min(50vh,20rem)] overflow-y-auto p-2">
        {matches.length ? (
          <ul>
            {matches.map(({ id, key, label, note, editable }) => (
              <li
                key={editable ? id : `${id}-${key}`}
                className="flex items-start justify-between gap-3 rounded-md px-2 py-2"
              >
                <span>
                  <span className="block">{label}</span>
                  {note && (
                    <span className="block text-xs text-muted-foreground">
                      {note}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <kbd className="font-mono text-xs text-muted-foreground">
                    {key}
                  </kbd>
                  {editable && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      aria-label={t("commands.shortcutChange", { name: label })}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setEditing(id);
                      }}
                    >
                      {t("commands.shortcutEdit")}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p
            role="status"
            className="px-4 py-8 text-center text-muted-foreground"
          >
            {t("commands.shortcutEmpty")}
          </p>
        )}
      </div>
    </>
  );
}

function ShortcutEditor({
  label,
  defaultShortcut,
  commands,
  onCancel,
  onSave,
}: {
  label: string;
  defaultShortcut: Shortcut;
  commands: AppCommand[];
  onCancel: () => void;
  onSave: (binding: ShortcutBinding) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ShortcutBinding>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const names = draft
    ? commands
        .filter((command) =>
          command.shortcuts?.some((shortcut) => sameShortcut(draft, shortcut)),
        )
        .map((command) => command.label ?? t(command.labelKey))
    : [];
  if (draft && sameShortcut(draft, SEND_EDITOR_SHORTCUT))
    names.push(t("commands.shortcutSend"));
  const conflict = names.join(" · ");
  return (
    <div className="grid gap-2 border-b px-4 py-3">
      <label htmlFor="shortcut-capture">
        {t("commands.shortcutChange", { name: label })}
      </label>
      <Input
        id="shortcut-capture"
        ref={input}
        readOnly
        placeholder={t("commands.shortcutPress")}
        value={draft ? formatShortcut(draft) : ""}
        aria-describedby={conflict ? "shortcut-conflict" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Tab" || event.key === "Escape") return;
          event.preventDefault();
          const binding = shortcutFromEvent(event.nativeEvent);
          if (binding) setDraft(binding);
        }}
      />
      {conflict && (
        <p
          id="shortcut-conflict"
          role="status"
          className="text-sm text-destructive"
        >
          {t("commands.shortcutTaken", { name: conflict })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!draft || !!conflict}
          onClick={() => {
            if (draft && !conflict) onSave(draft);
          }}
        >
          {t("common.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setDraft({
              key: defaultShortcut.key,
              primary: !!defaultShortcut.primary,
              alt: !!defaultShortcut.alt,
              shift: !!defaultShortcut.shift,
            })
          }
        >
          {t("commands.shortcutDefault")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
