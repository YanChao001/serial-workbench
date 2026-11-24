import { useContext, useEffect, useId, useRef, useState } from "react";
import type {
  BrowserAccessMode,
  BrowserAccessState,
} from "@serial-workbench/contracts";
import { SettingRow } from "@/components/setting-row";
import { ExternalLink } from "@/components/external-link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { copyText } from "@/lib/clipboard";
import { nativeErrorText } from "@/lib/native-error";
import { SETTINGS_ICONS } from "@/lib/settings-icons";
import { hostBrowserAccess, type LocalBrowserAccess } from "@/lib/tauri";
import { HostContext } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";

function withoutCode(access: BrowserAccessState): BrowserAccessState {
  return access.kind === "pairing"
    ? { kind: "enabled", mode: access.mode, url: access.entry.url }
    : access;
}

export function BrowserAccessSettings() {
  const generation = useContext(HostContext)?.connection?.generation;
  return <BrowserAccessRow key={generation} generation={generation} />;
}

function BrowserAccessRow({ generation }: { generation: string | undefined }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BrowserAccessMode>("readOnly");
  const [access, setAccess] = useState<BrowserAccessState>();
  const [pending, setPending] = useState<LocalBrowserAccess["kind"]>();
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const visit = useRef<symbol | undefined>(undefined);
  const copyRequest = useRef(0);
  const afterAction = useRef<"code" | "mode" | undefined>(undefined);
  const codeField = useRef<HTMLInputElement>(null);
  const modeField = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open || pending || !afterAction.current) return;
    const target = afterAction.current === "code" ? codeField : modeField;
    afterAction.current = undefined;
    target.current?.focus();
  }, [access, open, pending]);

  function modeLabel(mode: BrowserAccessMode) {
    return t(
      mode === "readOnly" ? "browserAccess.readOnly" : "browserAccess.operate",
    );
  }

  function recordAccess(next: BrowserAccessState, showCode = false) {
    setAccess(showCode ? next : withoutCode(next));
    if (next.kind !== "disabled") setMode(next.mode);
  }

  async function apply(intent: LocalBrowserAccess, origin?: HTMLButtonElement) {
    if (!generation || running.current) return;
    const owner = visit.current;
    running.current = true;
    copyRequest.current++;
    setPending(intent.kind);
    setError(null);
    setCopied(false);
    let refreshForNewVisit = false;
    try {
      const next = await hostBrowserAccess(generation, intent);
      if (!mounted.current) return;
      const sameVisit = visit.current === owner;
      if (sameVisit && origin && document.activeElement === origin) {
        if (next.kind === "pairing") afterAction.current = "code";
        else if (next.kind === "disabled" && intent.kind === "revoke")
          afterAction.current = "mode";
      }
      recordAccess(next, sameVisit && intent.kind === "pair");
    } catch (reason) {
      if (mounted.current && visit.current === owner) setError(reason);
      const actual =
        intent.kind === "status"
          ? undefined
          : await hostBrowserAccess(generation, { kind: "status" }).catch(
              () => undefined,
            );
      if (mounted.current && actual) recordAccess(actual);
      else
        refreshForNewVisit = Boolean(visit.current && visit.current !== owner);
    } finally {
      running.current = false;
      if (mounted.current) {
        setPending(undefined);
        if (refreshForNewVisit) void apply({ kind: "status" });
      }
    }
  }

  function changeOpen(next: boolean) {
    visit.current = next ? Symbol() : undefined;
    copyRequest.current++;
    afterAction.current = undefined;
    setOpen(next);
    setCopied(false);
    setError(null);
    if (next && !running.current) {
      setAccess(undefined);
      void apply({ kind: "status" });
    } else if (!next && access) {
      setAccess(withoutCode(access));
    }
  }

  async function copyCode(code: string) {
    if (running.current) return;
    const request = ++copyRequest.current;
    setCopied(false);
    setError(null);
    try {
      await copyText(code);
      if (mounted.current && copyRequest.current === request) setCopied(true);
    } catch (reason) {
      if (mounted.current && copyRequest.current === request) setError(reason);
    }
  }

  const enabled = access && access.kind !== "disabled";
  const entry = access?.kind === "pairing" ? access.entry : undefined;
  return (
    <SettingRow
      id="settings-browser-access"
      icon={SETTINGS_ICONS.browserAccess}
      label={t("browserAccess.title")}
    >
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            disabled={!generation}
            aria-label={t("browserAccess.manage")}
          >
            {t("browserAccess.configure")}
          </Button>
        </DialogTrigger>
        <DialogContent className="@container grid-rows-[auto_minmax(0,1fr)_auto] overflow-y-hidden sm:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle>{t("browserAccess.title")}</DialogTitle>
            <DialogDescription>
              {t("browserAccess.description")}
            </DialogDescription>
            <p role="status" className="text-sm wrap-anywhere">
              {enabled
                ? t("browserAccess.activeMode", {
                    mode: modeLabel(access.mode),
                  })
                : access
                  ? t("browserAccess.disabled")
                  : pending === "status"
                    ? t("browserAccess.loading")
                    : null}
            </p>
          </DialogHeader>
          <section
            aria-label={t("browserAccess.details")}
            className="grid min-h-0 content-start gap-3 overflow-y-auto p-0.5"
            tabIndex={0}
          >
            {error != null && (
              <p
                role="alert"
                className="text-sm text-destructive wrap-anywhere"
              >
                {nativeErrorText(error, t)}
              </p>
            )}
            {access &&
              (entry ? (
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor={id + "-code"}>
                    {t("browserPairing.code")}
                  </Label>
                  <div className="grid min-w-0 gap-2 @min-[27rem]:grid-cols-[minmax(0,1fr)_auto]">
                    <Input
                      id={id + "-code"}
                      ref={codeField}
                      value={entry.pairingCode}
                      className="min-w-0 font-mono text-xs"
                      readOnly
                    />
                    <Button
                      variant="outline"
                      className="justify-self-end"
                      aria-label={t("browserAccess.copy")}
                      disabled={Boolean(pending)}
                      onClick={() => void copyCode(entry.pairingCode)}
                    >
                      {t(
                        copied ? "browserAccess.copied" : "browserAccess.copy",
                      )}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("browserAccess.paste")}
                  </p>
                  <p role="status" className="sr-only">
                    {copied ? t("browserAccess.copied") : null}
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor={id + "-mode"}>
                    {t("browserAccess.mode")}
                  </Label>
                  <Select
                    value={mode}
                    onValueChange={(value) => {
                      if (value === "readOnly" || value === "operate")
                        setMode(value);
                    }}
                    disabled={Boolean(pending)}
                  >
                    <SelectTrigger
                      id={id + "-mode"}
                      ref={modeField}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="readOnly">
                        {modeLabel("readOnly")}
                      </SelectItem>
                      <SelectItem value="operate">
                        {modeLabel("operate")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      mode === "readOnly"
                        ? "browserAccess.readOnlyDescription"
                        : "browserAccess.operateDescription",
                    )}
                  </p>
                  {enabled && (
                    <p className="text-sm text-muted-foreground">
                      {t("browserAccess.replace")}
                    </p>
                  )}
                </div>
              ))}
          </section>
          <div className="grid min-w-0 gap-2 border-t pt-3 @min-[20rem]:flex @min-[20rem]:flex-wrap @min-[20rem]:justify-end">
            {enabled && (
              <Button
                variant="outline"
                aria-disabled={Boolean(pending)}
                className="aria-disabled:opacity-50"
                onClick={(event) =>
                  void apply({ kind: "revoke" }, event.currentTarget)
                }
              >
                {t(
                  pending === "revoke"
                    ? "browserAccess.revoking"
                    : "browserAccess.revoke",
                )}
              </Button>
            )}
            {entry ? (
              pending === "revoke" ? (
                <Button disabled>{t("browserAccess.open")}</Button>
              ) : (
                <ExternalLink href={entry.url} className={buttonVariants()}>
                  {t("browserAccess.open")}
                </ExternalLink>
              )
            ) : access ? (
              <Button
                aria-disabled={Boolean(pending)}
                className="aria-disabled:opacity-50"
                onClick={(event) =>
                  void apply({ kind: "pair", mode }, event.currentTarget)
                }
              >
                {t(
                  pending === "pair"
                    ? "browserAccess.pairing"
                    : enabled
                      ? "browserAccess.pairAgain"
                      : "browserAccess.pair",
                )}
              </Button>
            ) : error != null ? (
              <Button
                disabled={Boolean(pending)}
                onClick={() => void apply({ kind: "status" })}
              >
                {t("workbench.retryHost")}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
