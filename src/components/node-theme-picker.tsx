import { SettingRow } from "@/components/setting-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/providers/i18n";
import { useSettings } from "@/providers/settings";
import { nodeThemeKey } from "@/providers/use-node-themes";

export function NodeThemePicker() {
  const { t } = useI18n();
  const { settings, update, nodeThemes } = useSettings();
  if (!nodeThemes || (!nodeThemes.length && !settings.nodeTheme)) return null;

  const selected = settings.nodeTheme
    ? nodeThemeKey(settings.nodeTheme)
    : "base";
  const available =
    selected === "base" ||
    nodeThemes.some((theme) => nodeThemeKey(theme) === selected);
  const label = t("settings.nodeTheme");

  return (
    <SettingRow label={label}>
      <Select
        value={available ? selected : "unavailable"}
        onValueChange={(value) => {
          if (value === "base") {
            update({ nodeTheme: undefined });
            return;
          }
          const theme = nodeThemes.find((item) => nodeThemeKey(item) === value);
          if (!theme) return;
          const { packageId, themeId, archiveSha256 } = theme;
          update({ nodeTheme: { packageId, themeId, archiveSha256 } });
        }}
      >
        <SelectTrigger aria-label={label} className="max-w-full truncate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="base">{t("settings.nodeThemeBase")}</SelectItem>
          {available ? null : (
            <SelectItem value="unavailable" disabled>
              {t("settings.nodeThemeUnavailable")}
            </SelectItem>
          )}
          {nodeThemes.map((theme) => {
            const value = nodeThemeKey(theme);
            return (
              <SelectItem
                key={value}
                value={value}
                textValue={theme.displayName}
              >
                <span
                  aria-hidden="true"
                  data-surface="artwork"
                  className="mr-1 inline-block size-3 rounded-full border align-middle"
                  style={{ backgroundColor: theme.accent }}
                />
                {theme.displayName}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
