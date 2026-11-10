import { useCallback, useEffect, useRef, useState } from "react";
import {
  MonitorIcon,
  MoonIcon,
  RotateCcwIcon,
  SunIcon,
  ChevronDownIcon,
  LanguagesIcon,
  SunMoonIcon,
  SquareIcon,
  TypeIcon,
  ALargeSmallIcon,
  ActivityIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  MoveHorizontalIcon,
  LocateIcon,
  GlobeIcon,
} from "lucide-react";
import { toast } from "sonner";
import { LanguageSwitch } from "@/components/language-switch";
import { SkinPicker } from "@/components/skin-picker";
import { AccentPicker } from "@/components/accent-picker";
import { SettingsSearch } from "@/components/settings-search";
import {
  SettingsPersistence,
  SettingsPersistenceRetry,
} from "@/components/settings-persistence";
import { TerminalTypographySettings } from "@/components/terminal-typography-settings";
import { DesktopSettings } from "@/components/desktop-settings";
import { UpdateSettings } from "@/components/update-settings";
import { SettingLabel, SettingRow } from "@/components/setting-row";
import { useThemeSwitch } from "@/hooks/use-theme-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import { useI18n } from "@/providers/i18n";
import {
  useSettings,
  type Font,
  type FontSize,
  type Radius,
} from "@/providers/settings";
import {
  getAppInfo,
  getWindowGeometry,
  isTauri,
  onWindowMoved,
  onWindowResized,
  resetWindowGeometry,
  setWindowSize,
  type WindowGeometry,
} from "@/lib/tauri";
import { nativeErrorText } from "@/lib/native-error";
import { cn } from "@/lib/utils";
import { DiagnosticsContent } from "./diagnostics";
import { focusSetting } from "@/commands/settings-search";

const THEMES = [
  { value: "light", labelKey: "title.light", icon: SunIcon },
  { value: "dark", labelKey: "title.dark", icon: MoonIcon },
  { value: "system", labelKey: "title.system", icon: MonitorIcon },
] as const;

const FONT_OPTIONS = [
  { value: "geist", labelKey: "settings.fontGeist" },
  { value: "system", labelKey: "settings.fontSystem" },
  { value: "serif", labelKey: "settings.fontSerif" },
  { value: "mono", labelKey: "settings.fontMono" },
] as const;

export default function Settings() {
  const { t } = useI18n();
  const translateLatest = useLatestTranslator();
  const { theme, setTheme } = useThemeSwitch();
  const { settings, update, reset } = useSettings();
  const [version, setVersion] = useState("—");
  const [confirmReset, setConfirmReset] = useState(false);
  const [windowGeometry, setGeometry] = useState<WindowGeometry | null>(null);
  const [windowError, setWindowError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  const geometryGeneration = useRef(0);
  const native = isTauri();
  const invalidateGeometry = useCallback(() => {
    geometryGeneration.current++;
  }, []);

  const refreshWindow = useCallback(async () => {
    if (running.current) return;
    const generation = ++geometryGeneration.current;
    try {
      const geometry = await getWindowGeometry();
      if (!mounted.current || geometryGeneration.current !== generation) return;
      setGeometry(geometry);
      setWindowError(null);
    } catch (error) {
      if (mounted.current && geometryGeneration.current === generation)
        setWindowError(error);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    const unlisten: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (native) {
      const changed = () => {
        if (stopped) return;
        invalidateGeometry();
        clearTimeout(timer);
        timer = setTimeout(() => void refreshWindow(), 200);
      };
      void Promise.allSettled([
        onWindowResized(changed),
        onWindowMoved(changed),
      ]).then((results) => {
        for (const result of results) {
          if (result.status === "fulfilled") {
            if (stopped) result.value();
            else unlisten.push(result.value);
          } else if (!stopped) {
            setWindowError(result.reason);
          }
        }
        if (!stopped) void refreshWindow();
      });
    }
    return () => {
      mounted.current = false;
      stopped = true;
      invalidateGeometry();
      clearTimeout(timer);
      for (const stop of unlisten) stop();
    };
  }, [native, refreshWindow, invalidateGeometry]);

  function acceptGeometry(geometry: WindowGeometry) {
    geometryGeneration.current++;
    setGeometry(geometry);
    setWindowError(null);
  }

  async function applyWindowSize(width: number, height: number) {
    if (
      !native ||
      running.current ||
      !windowGeometry ||
      width < windowGeometry.minWidth ||
      width > windowGeometry.maxWidth ||
      height < windowGeometry.minHeight ||
      height > windowGeometry.maxHeight
    )
      return;
    running.current = true;
    geometryGeneration.current++;
    setPending(true);
    setWindowError(null);
    try {
      const geometry = await setWindowSize(width, height);
      if (mounted.current) {
        acceptGeometry(geometry);
      }
    } catch (error) {
      if (mounted.current)
        toast.error(nativeErrorText(error, translateLatest), {
          action: {
            label: translateLatest("common.refresh"),
            onClick: () => void refreshWindow(),
          },
        });
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function restorePreferences() {
    if (running.current) return;
    running.current = true;
    geometryGeneration.current++;
    setPending(true);
    try {
      const geometry = native ? await resetWindowGeometry(false) : null;
      if (geometry && mounted.current) acceptGeometry(geometry);
      await reset();
      if (mounted.current) {
        setConfirmReset(false);
      }
    } catch (error) {
      if (mounted.current) toast.error(nativeErrorText(error, translateLatest));
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const standardWidth = windowGeometry
    ? Math.max(
        windowGeometry.minWidth,
        Math.min(windowGeometry.maxWidth, windowGeometry.defaultWidth),
      )
    : null;
  const standardHeight = windowGeometry
    ? Math.max(
        windowGeometry.minHeight,
        Math.min(windowGeometry.maxHeight, windowGeometry.defaultHeight),
      )
    : null;
  const fittedDefault =
    windowGeometry !== null &&
    (standardWidth !== windowGeometry.defaultWidth ||
      standardHeight !== windowGeometry.defaultHeight);
  const windowPresets = [
    { id: "compact", label: "settings.windowCompact", width: 960, height: 640 },
    {
      id: "standard",
      label: "settings.windowStandard",
      width: standardWidth,
      height: standardHeight,
    },
    {
      id: "comfortable",
      label: "settings.windowComfortable",
      width: 1280,
      height: 800,
    },
    {
      id: "spacious",
      label: "settings.windowSpacious",
      width: 1440,
      height: 900,
    },
  ] as const;
  // 品牌默认尺寸与固定预设相同时，只保留标准选项。
  const visiblePresets = windowPresets.filter(
    (preset) =>
      preset.id === "standard" ||
      preset.width !== standardWidth ||
      preset.height !== standardHeight,
  );

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await getAppInfo();
        if (cancelled) return;
        setVersion(info.version);
      } catch (error) {
        console.error("读取版本信息失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="studio-page settings-studio">
      <header className="settings-header">
        <h1>{t("settings.title")}</h1>
        <div className="settings-header-tools">
          <SettingsPersistenceRetry />
          <SettingsSearch />
        </div>
      </header>
      <nav aria-label={t("settings.sections")} className="settings-section-nav">
        {(
          [
            ["settings-appearance", "settings.appearance"],
            ["settings-terminalTypography", "settings.terminalTypography"],
            ["settings-skin", "settings.skinGallery"],
            ["settings-layout", "studio.settingsWorkspace"],
            ["settings-window", "desktop.settingsTitle"],
            ["settings-network", "settings.network"],
          ] as const
        ).map(([anchor, key]) => (
          <Button
            key={anchor}
            variant="ghost"
            size="sm"
            onClick={() => focusSetting(anchor)}
          >
            {t(key)}
          </Button>
        ))}
      </nav>
      <SettingsPersistence />

      <fieldset
        data-surface="panel"
        id="settings-appearance"
        tabIndex={-1}
        className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <legend className="text-sm font-medium">
          {t("settings.appearance")}
        </legend>
        <div className="settings-list">
          <SettingRow
            id="settings-language"
            icon={LanguagesIcon}
            label={t("common.language")}
          >
            <LanguageSwitch />
          </SettingRow>
          <div
            id="settings-theme"
            tabIndex={-1}
            className="space-y-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SettingLabel icon={SunMoonIcon} label={t("settings.theme")} />
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((item) => {
                const active = theme === item.value;
                return (
                  <button
                    key={item.value}
                    data-surface="control"
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTheme(item.value)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                      active
                        ? "border-primary bg-(--surface-state-selected) font-medium"
                        : "text-muted-foreground hover:bg-(--surface-state-hover)",
                    )}
                  >
                    <item.icon className="size-4" />
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          <AccentPicker />

          <SettingRow
            id="settings-radius"
            icon={SquareIcon}
            label={t("settings.radius")}
          >
            <ToggleGroup
              type="single"
              aria-label={t("settings.radius")}
              size="sm"
              value={settings.radius}
              onValueChange={(value) => {
                if (value) update({ radius: value as Radius });
              }}
            >
              <ToggleGroupItem value="sharp" className="text-xs">
                {t("settings.radiusSharp")}
              </ToggleGroupItem>
              <ToggleGroupItem value="soft" className="text-xs">
                {t("settings.radiusSoft")}
              </ToggleGroupItem>
              <ToggleGroupItem value="round" className="text-xs">
                {t("settings.radiusRound")}
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>

          <SettingRow
            id="settings-font"
            icon={TypeIcon}
            label={t("settings.font")}
          >
            <Select
              value={settings.font}
              onValueChange={(value) => update({ font: value as Font })}
            >
              <SelectTrigger
                className="w-40"
                size="sm"
                aria-label={t("settings.font")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            id="settings-fontSize"
            icon={ALargeSmallIcon}
            label={t("settings.fontSize")}
          >
            <ToggleGroup
              type="single"
              aria-label={t("settings.fontSize")}
              size="sm"
              value={settings.fontSize}
              onValueChange={(value) => {
                if (value) update({ fontSize: value as FontSize });
              }}
            >
              <ToggleGroupItem value="sm" className="text-xs">
                {t("settings.fontSizeSm")}
              </ToggleGroupItem>
              <ToggleGroupItem value="md" className="text-xs">
                {t("settings.fontSizeMd")}
              </ToggleGroupItem>
              <ToggleGroupItem value="lg" className="text-xs">
                {t("settings.fontSizeLg")}
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>

          <SettingRow
            id="settings-motion"
            icon={ActivityIcon}
            label={t("settings.motion")}
          >
            <ToggleGroup
              type="single"
              aria-label={t("settings.motion")}
              size="sm"
              value={settings.motion}
              onValueChange={(value) => {
                if (value) update({ motion: value as "full" | "reduced" });
              }}
            >
              <ToggleGroupItem value="full" className="text-xs">
                {t("settings.motionFull")}
              </ToggleGroupItem>
              <ToggleGroupItem value="reduced" className="text-xs">
                {t("settings.motionReduced")}
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>
        </div>
      </fieldset>

      <TerminalTypographySettings />

      <section
        id="settings-skin"
        tabIndex={-1}
        className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SkinPicker />
      </section>

      <fieldset
        data-surface="panel"
        id="settings-layout"
        tabIndex={-1}
        className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <legend className="text-sm font-medium">
          {t("studio.settingsWorkspace")}
        </legend>
        <div className="settings-list">
          <SettingRow
            id="settings-menuBar"
            icon={MenuIcon}
            label={t("settings.menuBar")}
          >
            <Switch
              checked={settings.menuBar}
              onCheckedChange={(checked) => update({ menuBar: checked })}
              aria-label={t("settings.menuBar")}
            />
          </SettingRow>
          <SettingRow
            icon={PanelLeftCloseIcon}
            label={t("settings.sidebarCollapsed")}
          >
            <Switch
              aria-label={t("settings.sidebarCollapsed")}
              checked={settings.sidebarCollapsed}
              onCheckedChange={(value) => update({ sidebarCollapsed: value })}
            />
          </SettingRow>
          <SettingRow
            icon={MoveHorizontalIcon}
            label={t("settings.sidebarWidth")}
          >
            <input
              type="range"
              min={180}
              max={360}
              step={4}
              value={settings.sidebarWidth}
              onChange={(event) =>
                update({ sidebarWidth: Number(event.target.value) })
              }
              aria-label={t("settings.sidebarWidth")}
              className="w-40 accent-primary"
            />
          </SettingRow>
        </div>
      </fieldset>

      <fieldset
        data-surface="panel"
        id="settings-window"
        tabIndex={-1}
        className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <legend className="text-sm font-medium">
          {t("desktop.settingsTitle")}
        </legend>
        <div className="settings-list">
          <DesktopSettings />
          <div className="space-y-3">
            <div
              role="group"
              aria-label={t("settings.windowSize")}
              className="window-preset-grid grid grid-cols-2 gap-2"
            >
              {visiblePresets.map((preset) => {
                const unavailable =
                  windowGeometry !== null &&
                  preset.width !== null &&
                  preset.height !== null &&
                  (preset.width < windowGeometry.minWidth ||
                    preset.width > windowGeometry.maxWidth ||
                    preset.height < windowGeometry.minHeight ||
                    preset.height > windowGeometry.maxHeight);
                const active =
                  windowGeometry !== null &&
                  preset.width === windowGeometry.width &&
                  preset.height === windowGeometry.height;
                const reasonId = `window-${preset.id}-unavailable`;
                const control = (
                  <button
                    key={preset.id}
                    data-surface="control"
                    data-window-preset={preset.id}
                    type="button"
                    aria-pressed={active}
                    aria-describedby={unavailable ? reasonId : undefined}
                    disabled={
                      !native || pending || !windowGeometry || unavailable
                    }
                    onClick={() => {
                      if (preset.width !== null && preset.height !== null)
                        void applyWindowSize(preset.width, preset.height);
                    }}
                    className={cn(
                      "flex min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      active
                        ? "border-primary bg-(--surface-state-selected)"
                        : "hover:bg-(--surface-state-hover)",
                      unavailable && "pointer-events-none h-full w-full",
                    )}
                  >
                    <span className="text-sm">{t(preset.label)}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {preset.width !== null && preset.height !== null
                        ? `${preset.width} × ${preset.height}`
                        : t("settings.windowDefaultSize")}
                    </span>{" "}
                    {preset.id === "standard" && fittedDefault ? (
                      <span className="sr-only">
                        {t("settings.windowSizeFitted")}
                      </span>
                    ) : null}
                    {unavailable ? (
                      <span id={reasonId} className="sr-only">
                        {t("settings.windowPresetUnavailable")}
                      </span>
                    ) : null}
                  </button>
                );
                return unavailable ? (
                  <TooltipProvider
                    key={preset.id}
                    delayDuration={650}
                    skipDelayDuration={0}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          role="group"
                          aria-label={t(preset.label)}
                          aria-describedby={reasonId}
                          tabIndex={0}
                          className="block min-w-0 cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {control}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t("settings.windowPresetUnavailable")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  control
                );
              })}
            </div>
            {native ? (
              <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 text-xs">
                {windowError ? (
                  <>
                    <span
                      role="alert"
                      className="min-w-0 break-words text-destructive"
                    >
                      {nativeErrorText(windowError, t)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => void refreshWindow()}
                    >
                      {t("common.retry")}
                    </Button>
                  </>
                ) : (
                  <span
                    className="truncate text-muted-foreground"
                    aria-live="polite"
                  >
                    {windowGeometry
                      ? t("settings.windowCurrentSize", {
                          width: windowGeometry.width,
                          height: windowGeometry.height,
                        })
                      : t("common.loading")}
                  </span>
                )}
              </div>
            ) : null}
          </div>
          <SettingRow
            id="settings-windowPosition"
            icon={LocateIcon}
            label={t("settings.windowPosition")}
          >
            <ToggleGroup
              type="single"
              aria-label={t("settings.windowPosition")}
              disabled={pending}
              value={settings.windowPosition}
              onValueChange={(value) => {
                if (value === "remember" || value === "center")
                  update({ windowPosition: value });
              }}
            >
              <ToggleGroupItem value="remember" data-window-position="remember">
                {t("settings.windowPositionRemember")}
              </ToggleGroupItem>
              <ToggleGroupItem value="center" data-window-position="center">
                {t("settings.windowPositionCenter")}
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>
        </div>
      </fieldset>

      <UpdateSettings />

      <fieldset
        data-surface="panel"
        id="settings-network"
        tabIndex={-1}
        className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <legend className="text-sm font-medium">{t("settings.network")}</legend>
        <div className="settings-list">
          <SettingRow
            id="settings-networkMode"
            icon={GlobeIcon}
            label={t("settings.networkMode")}
            hint={!native ? t("settings.networkModeBrowserHint") : undefined}
          >
            <Select
              value={settings.networkMode}
              disabled={!native}
              onValueChange={(value) => {
                if (value === "system" || value === "direct")
                  update({ networkMode: value });
              }}
            >
              <SelectTrigger
                className="w-44"
                size="sm"
                aria-label={t("settings.networkMode")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  {t("settings.networkModeSystem")}
                </SelectItem>
                <SelectItem value="direct">
                  {t("settings.networkModeDirect")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </div>
      </fieldset>

      <details
        data-disclosure-radius="xl"
        className="studio-panel settings-about"
        id="settings-about"
      >
        <summary>
          {t("studio.settingsAbout")}
          <ChevronDownIcon size={16} />
        </summary>
        <div className="settings-about-content">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("settings.runtime")}</CardTitle>
            </CardHeader>
            <CardContent className="settings-list">
              <SettingRow label={t("settings.appVersion")}>
                <span className="font-mono text-xs">{version}</span>
              </SettingRow>
              <SettingRow label={t("settings.environment")}>
                <Badge variant="outline" className="font-normal">
                  {isTauri() ? t("app.native") : t("app.preview")}
                </Badge>
              </SettingRow>
            </CardContent>
          </Card>
        </div>
      </details>

      <fieldset
        data-surface="panel"
        id="settings-recovery"
        tabIndex={-1}
        className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <legend className="text-sm font-medium">
          {t("shell.diagnostics")}
        </legend>
        <div className="space-y-3">
          {native ? (
            <DiagnosticsContent />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("native.description")}
            </p>
          )}
        </div>
      </fieldset>

      <Card className="flex-row items-center justify-between gap-4 px-4 py-3">
        <p className="min-w-0 text-sm">{t("common.reset")}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            setConfirmReset(true);
          }}
        >
          <RotateCcwIcon />
          {t("common.reset")}
        </Button>
      </Card>
      <Dialog
        open={confirmReset}
        onOpenChange={(open) => {
          if (!pending) setConfirmReset(open);
        }}
      >
        <DialogContent closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("settings.resetConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.resetConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmReset(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void restorePreferences()}
            >
              {t("common.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
