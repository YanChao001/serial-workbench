import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { StreamItem, TextEncoding } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { detectTextEncoding } from "@/lib/encoding-detection";
import { createTextDecoder } from "@/lib/text-encoding";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { receiveTextSample } from "./encoding-sample";
import {
  characterRemapLimits,
  remapCharacters,
  type CharacterRemapRules,
} from "./character-remap";

type Direction = "rx" | "tx";
type RemapDraft = Omit<CharacterRemapRules, "replacements"> & {
  sample: "current" | "example";
  replacements: readonly { id: number; source: string; replacement: string }[];
};

const emptyDraft: RemapDraft = {
  newline: "keep",
  backspace: "keep",
  letterCase: "keep",
  sample: "current",
  replacements: [],
};
function draftFromRules(rules: CharacterRemapRules | undefined): RemapDraft {
  return rules
    ? {
        ...rules,
        sample: "current",
        replacements: rules.replacements.map((entry, index) => ({
          ...entry,
          id: index + 1,
        })),
      }
    : emptyDraft;
}

function rulesOf(draft: RemapDraft): CharacterRemapRules {
  return {
    newline: draft.newline,
    backspace: draft.backspace,
    letterCase: draft.letterCase,
    replacements: draft.replacements.map(({ source, replacement }) => ({
      source,
      replacement,
    })),
  };
}
const example = { rx: "temp=2\b5\r\nOK\r", tx: "status?\nnext=x\b3" };

function asEscapedText(value: string) {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f]/gu,
      (character) =>
        "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
    );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      {children}
    </div>
  );
}

export function CharacterRemapTool({
  items,
  receiveEncoding,
  sendText,
  appliedReceive,
  onApplyReceive,
  appliedSend,
  onApplySend,
}: {
  items: readonly StreamItem[];
  receiveEncoding: TextEncoding | null;
  sendText?: string;
  appliedReceive?: CharacterRemapRules;
  onApplyReceive?: (rules: CharacterRemapRules) => void;
  appliedSend?: CharacterRemapRules;
  onApplySend?: (rules: CharacterRemapRules) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const nextRow = useRef(
    Math.max(
      appliedReceive?.replacements.length ?? 0,
      appliedSend?.replacements.length ?? 0,
    ),
  );
  const addReplacement = useRef<HTMLButtonElement>(null);
  const [direction, setDirection] = useState<Direction>("rx");
  const [drafts, setDrafts] = useState(() => ({
    rx: draftFromRules(appliedReceive),
    tx: draftFromRules(appliedSend),
  }));
  const draft = drafts[direction];
  const change = (patch: Partial<RemapDraft>) =>
    setDrafts((current) => ({
      ...current,
      [direction]: { ...current[direction], ...patch },
    }));
  const rules = rulesOf(draft);
  const applied = direction === "rx" ? appliedReceive : appliedSend;
  const apply = direction === "rx" ? onApplyReceive : onApplySend;
  const matches = (
    edited: RemapDraft,
    saved: CharacterRemapRules | undefined,
  ) =>
    JSON.stringify(rulesOf(edited)) ===
    JSON.stringify(saved ?? rulesOf(emptyDraft));
  const dirty =
    !matches(drafts.rx, appliedReceive) || !matches(drafts.tx, appliedSend);
  useUnsavedWork({
    id,
    label: t("characterRemap.title"),
    dirty,
    discard: () =>
      setDrafts({
        rx: draftFromRules(appliedReceive),
        tx: draftFromRules(appliedSend),
      }),
    retainAfterUnmount: false,
  });

  const original = useMemo(() => {
    if (draft.sample === "example") return example[direction];
    if (direction === "tx") return sendText;
    const { bytes: sample, completeMessage } = receiveTextSample(items);
    if (sample.length === 0) return;
    const encoding =
      receiveEncoding ?? detectTextEncoding(sample)?.encoding ?? "utf-8";
    return createTextDecoder(encoding).decode(
      Uint8Array.from(sample, (byte) => byte.charCodeAt(0)),
      { stream: !completeMessage },
    );
  }, [direction, draft.sample, items, receiveEncoding, sendText]);
  const limit = characterRemapLimits.previewInput;
  const splitPoint = original?.codePointAt(limit - 1) ?? 0;
  const shown = original?.slice(0, splitPoint > 0xffff ? limit - 1 : limit);
  const mapped = useMemo(
    () =>
      remapCharacters(shown ?? "", draft, characterRemapLimits.previewOutput),
    [shown, draft],
  );
  const rowIssues = !mapped.ok && mapped.code === "rows" ? mapped.issues : [];
  const previewIssue =
    !mapped.ok && mapped.code !== "rows" ? mapped : undefined;
  const updateRow = (
    row: number,
    field: "source" | "replacement",
    value: string,
  ) =>
    change({
      replacements: draft.replacements.map((item) =>
        item.id === row ? { ...item, [field]: value } : item,
      ),
    });
  const newlineOptions = (["keep", "cr", "lf", "crlf"] as const).map(
    (value) => ({
      value,
      label: t(`characterRemap.newline.${value}`),
    }),
  );
  const backspaceOptions = (["keep", "remove", "apply"] as const).map(
    (value) => ({
      value,
      label: t(`characterRemap.backspace.${value}`),
    }),
  );
  const caseOptions = (["keep", "lower", "upper"] as const).map((value) => ({
    value,
    label: t(`characterRemap.case.${value}`),
  }));

  return (
    <div className="min-w-0 space-y-4">
      <ToggleGroup
        type="single"
        value={direction}
        aria-label={t("characterRemap.direction")}
        variant="outline"
        size="sm"
        spacing={0}
        onValueChange={(value) => {
          if (value === "rx" || value === "tx") setDirection(value);
        }}
      >
        <ToggleGroupItem value="rx">
          {t("characterRemap.receive")}
        </ToggleGroupItem>
        <ToggleGroupItem value="tx">{t("characterRemap.send")}</ToggleGroupItem>
      </ToggleGroup>

      <div className="workbench-form-grid workbench-form-grid-pair">
        <Field label={t("characterRemap.newline")} id={id + "-newline"}>
          <OptionsSelect
            id={id + "-newline"}
            value={draft.newline}
            options={newlineOptions}
            onValueChange={(newline) => change({ newline })}
          />
        </Field>
        <Field label={t("characterRemap.backspace")} id={id + "-backspace"}>
          <OptionsSelect
            id={id + "-backspace"}
            value={draft.backspace}
            options={backspaceOptions}
            onValueChange={(backspace) => change({ backspace })}
          />
        </Field>
        <Field label={t("characterRemap.case")} id={id + "-case"}>
          <OptionsSelect
            id={id + "-case"}
            value={draft.letterCase}
            options={caseOptions}
            onValueChange={(letterCase) => change({ letterCase })}
          />
        </Field>
      </div>

      <section
        aria-labelledby={id + "-replacements"}
        className="space-y-2 border-t pt-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={id + "-replacements"} className="text-sm font-medium">
            {t("characterRemap.replacements")}
          </h3>
          <Button
            ref={addReplacement}
            type="button"
            size="sm"
            variant="outline"
            disabled={
              draft.replacements.length >= characterRemapLimits.replacements
            }
            onClick={() =>
              change({
                replacements: [
                  ...draft.replacements,
                  { id: ++nextRow.current, source: "", replacement: "" },
                ],
              })
            }
          >
            {t("characterRemap.add")}
          </Button>
        </div>
        {draft.replacements.map((value, index) => {
          const row = id + "-" + value.id;
          const issue = rowIssues.find((entry) => entry.row === index)?.code;
          const sourceInvalid = issue === "source" || issue === "duplicate";
          return (
            <div key={value.id} className="space-y-1.5">
              <div className="workbench-remap-row">
                <Field label={t("characterRemap.source")} id={row + "-source"}>
                  <Input
                    id={row + "-source"}
                    className="font-mono"
                    spellCheck={false}
                    value={value.source}
                    maxLength={2}
                    aria-invalid={sourceInvalid}
                    aria-describedby={
                      sourceInvalid ? row + "-issue" : undefined
                    }
                    onChange={(event) =>
                      updateRow(value.id, "source", event.currentTarget.value)
                    }
                  />
                </Field>
                <Field
                  label={t("characterRemap.replacement")}
                  id={row + "-replacement"}
                >
                  <Input
                    id={row + "-replacement"}
                    className="font-mono"
                    spellCheck={false}
                    value={value.replacement}
                    maxLength={characterRemapLimits.replacementLength}
                    aria-invalid={issue === "replacement"}
                    aria-describedby={
                      issue === "replacement" ? row + "-issue" : undefined
                    }
                    onChange={(event) =>
                      updateRow(
                        value.id,
                        "replacement",
                        event.currentTarget.value,
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => {
                    const neighbor =
                      draft.replacements[index + 1] ??
                      draft.replacements[index - 1];
                    const nextFocus = neighbor
                      ? document.getElementById(
                          id + "-" + neighbor.id + "-source",
                        )
                      : addReplacement.current;
                    nextFocus?.focus({ preventScroll: true });
                    change({
                      replacements: draft.replacements.filter(
                        (item) => item.id !== value.id,
                      ),
                    });
                  }}
                >
                  {t("characterRemap.remove")}
                </Button>
              </div>
              {issue && (
                <p
                  className="text-sm text-destructive"
                  id={row + "-issue"}
                  role="status"
                >
                  {t(`characterRemap.error.${issue}`)}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section
        className="space-y-2 border-t pt-3"
        aria-label={t("characterRemap.preview")}
      >
        <ToggleGroup
          type="single"
          value={draft.sample}
          aria-label={t("characterRemap.sample")}
          variant="outline"
          size="sm"
          spacing={0}
          onValueChange={(value) => {
            if (value === "current" || value === "example")
              change({ sample: value });
          }}
        >
          <ToggleGroupItem value="current">
            {t("characterRemap.current")}
          </ToggleGroupItem>
          <ToggleGroupItem value="example">
            {t("characterRemap.example")}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="workbench-form-grid workbench-form-grid-pair">
          <Field label={t("characterRemap.before")} id={id + "-before"}>
            <Textarea
              id={id + "-before"}
              className="min-h-20 resize-y font-mono"
              readOnly
              value={shown === undefined ? "" : asEscapedText(shown)}
            />
          </Field>
          <Field label={t("characterRemap.after")} id={id + "-after"}>
            <Textarea
              id={id + "-after"}
              className="min-h-20 resize-y font-mono"
              readOnly
              value={mapped.ok ? asEscapedText(mapped.text) : ""}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          {shown === undefined || shown.length === 0
            ? t(
                direction === "tx"
                  ? "characterRemap.emptySend"
                  : "characterRemap.emptyReceive",
              )
            : t("characterRemap.escaped")}
        </p>
        {original && original.length > limit && (
          <p className="text-xs text-muted-foreground">
            {t("characterRemap.sampleLimit", { limit })}
          </p>
        )}
        {previewIssue && (
          <p className="text-sm text-destructive" role="status">
            {t(`characterRemap.error.${previewIssue.code}`)}
          </p>
        )}
      </section>
      <div className="workbench-remap-apply">
        <p className="text-xs text-muted-foreground" role="status">
          {apply
            ? applied && matches(draft, applied)
              ? t(
                  direction === "rx"
                    ? "characterRemap.receiveApplied"
                    : "characterRemap.sendApplied",
                )
              : null
            : t(
                direction === "rx"
                  ? "characterRemap.receiveConnect"
                  : "characterRemap.sendConnect",
              )}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!apply || (!mapped.ok && mapped.code !== "output")}
          onClick={() => apply?.(rules)}
        >
          {t(
            direction === "rx"
              ? "characterRemap.receiveApply"
              : "characterRemap.sendApply",
          )}
        </Button>
      </div>
    </div>
  );
}
