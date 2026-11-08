import { useId, useState, type FocusEvent } from "react";
import { defaults, type TerminalTypography } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/setting-row";
import { useI18n } from "@/providers/i18n";
import { useSettings } from "@/providers/settings";
import { useUnsavedWork } from "@/providers/unsaved-work";

type TextField = "fontFamily" | "fontSize" | "lineHeightPercent";
type TypographyDraft = Partial<Record<TextField, string>>;

export function TerminalTypographySettings() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const id = useId();
  const [draft, setDraft] = useState<TypographyDraft>({});
  const typography =
    settings.terminal.typography ?? defaults.terminalTypography;
  const values = {
    fontFamily: draft.fontFamily ?? typography.fontFamily,
    fontSize: draft.fontSize ?? String(typography.fontSize),
    lineHeightPercent:
      draft.lineHeightPercent ?? String(typography.lineHeightPercent),
  };
  const errors = {
    fontFamily:
      !values.fontFamily.trim() ||
      /\p{Cc}|[\uD800-\uDFFF]/u.test(values.fontFamily) ||
      [...values.fontFamily].length > 128,
    fontSize:
      !values.fontSize.trim() ||
      !Number.isInteger(Number(values.fontSize)) ||
      Number(values.fontSize) < 8 ||
      Number(values.fontSize) > 48,
    lineHeightPercent:
      !values.lineHeightPercent.trim() ||
      !Number.isInteger(Number(values.lineHeightPercent)) ||
      Number(values.lineHeightPercent) < 100 ||
      Number(values.lineHeightPercent) > 300,
  };
  const dirty = Object.keys(draft).length > 0;
  const invalid = Object.values(errors).some(Boolean);

  function apply() {
    if (invalid) throw { code: "VALIDATION" };
    if (!dirty) return;
    const next: TerminalTypography = {
      ...typography,
      ...(draft.fontFamily !== undefined
        ? { fontFamily: values.fontFamily }
        : {}),
      ...(draft.fontSize !== undefined
        ? { fontSize: Number(values.fontSize) }
        : {}),
      ...(draft.lineHeightPercent !== undefined
        ? { lineHeightPercent: Number(values.lineHeightPercent) }
        : {}),
    };
    update({ terminal: { ...settings.terminal, typography: next } });
    setDraft({});
  }

  function applyOnBlur(event: FocusEvent<HTMLInputElement>) {
    if (
      event.relatedTarget instanceof Element &&
      event.relatedTarget.closest("[data-typography-action]")
    )
      return;
    if (!invalid) apply();
  }

  useUnsavedWork({
    id,
    label: t("settings.terminalTypography"),
    dirty,
    save: async (signal) => {
      signal?.throwIfAborted();
      apply();
    },
    discard: (signal) => {
      signal?.throwIfAborted();
      setDraft({});
    },
  });

  const fields = [
    {
      key: "fontFamily",
      label: "settings.terminalFontFamily",
      hint: "settings.terminalFontFamilyHint",
      error: "settings.terminalFontFamilyError",
      type: "text",
    },
    {
      key: "fontSize",
      label: "settings.terminalFontSize",
      hint: "settings.terminalFontSizeHint",
      error: "settings.terminalFontSizeError",
      type: "number",
      min: 8,
      max: 48,
    },
    {
      key: "lineHeightPercent",
      label: "settings.terminalLineHeight",
      hint: "settings.terminalLineHeightHint",
      error: "settings.terminalLineHeightError",
      type: "number",
      min: 100,
      max: 300,
    },
  ] as const;

  return (
    <fieldset
      data-surface="panel"
      id="settings-terminalTypography"
      tabIndex={-1}
      className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <legend className="text-sm font-medium">
        {t("settings.terminalTypography")}
      </legend>
      <p className="text-xs text-muted-foreground">
        {t("settings.terminalTypographyHint")}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) apply();
        }}
      >
        <div className="settings-list">
          {fields.map((field) => {
            const inputId = `${id}-${field.key}`;
            const invalidField =
              draft[field.key] !== undefined && errors[field.key];
            return (
              <SettingRow
                key={field.key}
                label={<label htmlFor={inputId}>{t(field.label)}</label>}
              >
                <div className="w-full space-y-1 sm:max-w-80">
                  <Input
                    id={inputId}
                    type={field.type}
                    min={"min" in field ? field.min : undefined}
                    max={"max" in field ? field.max : undefined}
                    step={field.type === "number" ? 1 : undefined}
                    value={values[field.key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                    onBlur={applyOnBlur}
                    aria-invalid={invalidField}
                    aria-describedby={`${inputId}-hint${invalidField ? ` ${inputId}-error` : ""}`}
                  />
                  <p
                    id={`${inputId}-hint`}
                    className="text-xs text-muted-foreground"
                  >
                    {t(field.hint)}
                  </p>
                  {invalidField ? (
                    <p
                      id={`${inputId}-error`}
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {t(field.error)}
                    </p>
                  ) : null}
                </div>
              </SettingRow>
            );
          })}
          <SettingRow
            label={
              <label htmlFor={`${id}-ligatures`}>
                {t("settings.terminalLigatures")}
              </label>
            }
          >
            <div className="space-y-1">
              <Switch
                id={`${id}-ligatures`}
                checked={typography.ligatures}
                onCheckedChange={(ligatures) =>
                  update({
                    terminal: {
                      ...settings.terminal,
                      typography: { ...typography, ligatures },
                    },
                  })
                }
                aria-describedby={`${id}-ligatures-hint`}
              />
              <p
                id={`${id}-ligatures-hint`}
                className="text-xs text-muted-foreground"
              >
                {t("settings.terminalLigaturesHint")}
              </p>
            </div>
          </SettingRow>
        </div>
        {dirty ? (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-typography-action
              onClick={() => setDraft({})}
            >
              {t("settings.terminalTypographyRevert")}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-typography-action
              disabled={invalid}
            >
              {t("settings.terminalTypographyApply")}
            </Button>
          </div>
        ) : null}
      </form>
    </fieldset>
  );
}
