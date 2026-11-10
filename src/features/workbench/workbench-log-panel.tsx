import { useContext, useState, useSyncExternalStore } from "react";
import { Eraser, Info } from "lucide-react";
import { useI18n } from "@/providers/i18n";
import {
  clearUserLog,
  getUserLog,
  subscribeUserLog,
  USER_LOG_MODULES,
  type UserLogLevel,
  type UserLogModule,
} from "@/lib/user-log";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { SettingsContext } from "@/providers/settings-context";
import { Button } from "@/components/ui/button";

export function WorkbenchLogPanel() {
  const { t } = useI18n();
  const settings = useContext(SettingsContext);
  const entries = useSyncExternalStore(
    subscribeUserLog,
    getUserLog,
    getUserLog,
  );
  const [module, setModule] = useState<UserLogModule | "all">("all");
  const [level, setLevel] = useState<UserLogLevel | "all">("all");
  const visible = entries.filter(
    (entry) =>
      (module === "all" || entry.module === module) &&
      (level === "all" || entry.level === level),
  );
  return (
    <section className="workbench-log-panel" aria-label={t("workbench.logs")}>
      <div className="workbench-toolbar">
        <Select
          value={module}
          onValueChange={(value) => {
            const selected = USER_LOG_MODULES.find((item) => item === value);
            if (value === "all" || selected) setModule(selected ?? "all");
          }}
        >
          <SelectTrigger aria-label={t("logs.module")} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("logs.allModules")}</SelectItem>
            {USER_LOG_MODULES.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`logs.module.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={level}
          onValueChange={(value) => {
            if (
              value === "all" ||
              value === "info" ||
              value === "warning" ||
              value === "error"
            )
              setLevel(value);
          }}
        >
          <SelectTrigger aria-label={t("logs.level")} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("logs.allLevels")}</SelectItem>
            {(["info", "warning", "error"] as const).map((item) => (
              <SelectItem key={item} value={item}>
                {t(`logs.level.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="workbench-toolbar-spacer" />
        <WorkbenchIconButton
          label={t("logs.clear")}
          disabled={!entries.length}
          onClick={clearUserLog}
        >
          <Eraser aria-hidden="true" />
        </WorkbenchIconButton>
      </div>
      <div
        className="workbench-log-list app-scroll-region"
        role="log"
        aria-live="off"
        aria-label={t("workbench.logs")}
      >
        {!visible.length && (
          <p className="text-muted-foreground">{t("logs.empty")}</p>
        )}
        <ul>
          {visible.map((entry) => {
            const moduleName = t(`logs.module.${entry.module}`);
            const levelName = t(`logs.level.${entry.level}`);
            const details = [
              [t("logs.firstAt"), entry.firstAt],
              [t("logs.lastAt"), entry.lastAt],
              [t("logs.module"), moduleName],
              [t("logs.level"), levelName],
              [t("logs.message"), entry.message],
              [t("logs.context"), entry.context],
              [t("logs.code"), entry.code],
              [t("logs.count"), String(entry.count)],
            ]
              .filter(([, value]) => value !== undefined)
              .map(([label, value]) => `${label}: ${value}`)
              .join("\n");
            return (
              <li key={entry.id} data-level={entry.level}>
                <time dateTime={entry.lastAt} title={entry.lastAt}>
                  {new Date(entry.lastAt).toLocaleTimeString(undefined, {
                    hourCycle: "h23",
                  })}
                </time>
                <span className="workbench-log-module">{moduleName}</span>
                <div className="workbench-log-message">
                  <span className="workbench-log-level">{levelName}</span>{" "}
                  {entry.context && <span>{entry.context}: </span>}
                  {entry.message}
                </div>
                <span
                  className="workbench-log-count"
                  aria-label={t("logs.count")}
                  title={t("logs.count")}
                >
                  {entry.count > 1 ? `×${entry.count}` : ""}
                </span>
                <Popover>
                  <PopoverTrigger asChild>
                    <WorkbenchIconButton label={t("common.details")}>
                      <Info aria-hidden="true" />
                    </WorkbenchIconButton>
                  </PopoverTrigger>
                  <PopoverContent
                    className="workbench-detail-popover"
                    aria-label={t("logs.details")}
                    side="left"
                    align="end"
                  >
                    <Textarea
                      readOnly
                      value={details}
                      aria-label={t("logs.details")}
                      className="workbench-log-details"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    {entry.module ===
                      (settings?.persistenceScope === "serial"
                        ? "serial"
                        : "settings") &&
                      settings?.persistence === "error" &&
                      settings.persistenceScope !== "connection" &&
                      settings.persistenceError === entry.code &&
                      entry.code !== "FUTURE_FORMAT" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={settings.retrySave}
                        >
                          {t("common.retry")}
                        </Button>
                      )}
                  </PopoverContent>
                </Popover>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
