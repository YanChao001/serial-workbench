import { useContext, useEffect, useRef, useState } from "react";
import { SettingRow } from "@/components/setting-row";
import { ExternalLink } from "@/components/external-link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { hostBrowserAccess, type LocalBrowserAccess } from "@/lib/tauri";
import { nativeErrorText } from "@/lib/native-error";
import { SETTINGS_ICONS } from "@/lib/settings-icons";
import { HostContext } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import type {
  BrowserAccessMode,
  BrowserAccessState,
} from "@serial-workbench/contracts";

export function BrowserAccessSettings() {
  const generation = useContext(HostContext)?.connection?.generation;
  return <BrowserAccessRow key={generation} generation={generation} />;
}

function BrowserAccessRow({ generation }: { generation: string | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BrowserAccessMode>("readOnly");
  const [access, setAccess] = useState<BrowserAccessState>();
  const [pending, setPending] = useState<LocalBrowserAccess["kind"]>();
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const opened = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function apply(intent: LocalBrowserAccess) {
    if (!generation || running.current) return;
    running.current = true;
    setPending(intent.kind);
    setError(null);
    setCopied(false);
    try {
      const next = await hostBrowserAccess(generation, intent);
      if (!mounted.current) return;
      if (next.kind !== "disabled") setMode(next.mode);
      // A closed dialog should not keep the one-time code for the next visit.
      setAccess(
        next.kind === "pairing" && !opened.current
          ? { kind: "enabled", mode: next.mode, url: next.entry.url }
          : next,
      );
    } catch (reason) {
      if (mounted.current) setError(reason);
      if (intent.kind !== "status") {
        const actual = await hostBrowserAccess(generation, {
          kind: "status",
        }).catch(() => undefined);
        if (mounted.current && actual) setAccess(actual);
      }
    } finally {
      running.current = false;
      if (mounted.current) setPending(undefined);
    }
  }

  function changeOpen(next: boolean) {
    opened.current = next;
    setOpen(next);
    setCopied(false);
    if (next) {
      if (!running.current) {
        setAccess(undefined);
        void apply({ kind: "status" });
      }
    } else if (access?.kind === "pairing") {
      setAccess({ kind: "enabled", mode: access.mode, url: access.entry.url });
    }
  }

  const enabled = access?.kind === "enabled" || access?.kind === "pairing";
  const url =
    access?.kind === "pairing"
      ? access.entry.url
      : access?.kind === "enabled"
        ? access.url
        : undefined;
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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("browserAccess.title")}</DialogTitle>
            <DialogDescription>
              {t("browserAccess.description")}
            </DialogDescription>
          </DialogHeader>
          {pending === "status" && (
            <p role="status">{t("browserAccess.loading")}</p>
          )}
          {error != null && (
            <p role="alert" className="text-sm text-destructive">
              {nativeErrorText(error, t)}
            </p>
          )}
          {access && (
            <>
              {access.kind === "enabled" && (
                <p role="status" className="text-sm">
                  {t("browserAccess.enabled")}
                </p>
              )}
              {access.kind === "pairing" ? (
                <div className="grid gap-2">
                  <Label htmlFor="desktop-browser-code">
                    {t("browserPairing.code")}
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="desktop-browser-code"
                      value={access.entry.pairingCode}
                      className="min-w-40 flex-1 font-mono"
                      readOnly
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        void copyText(access.entry.pairingCode).then(
                          () => {
                            if (mounted.current && opened.current)
                              setCopied(true);
                          },
                          (reason: unknown) => {
                            if (mounted.current && opened.current)
                              setError(reason);
                          },
                        );
                      }}
                    >
                      {t(
                        copied ? "browserAccess.copied" : "browserAccess.copy",
                      )}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("browserAccess.paste")}
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="desktop-browser-mode">
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
                    <SelectTrigger id="desktop-browser-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="readOnly">
                        {t("browserAccess.readOnly")}
                      </SelectItem>
                      <SelectItem value="operate">
                        {t("browserAccess.operate")}
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
              )}
            </>
          )}
          <DialogFooter>
            {enabled && (
              <Button
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => void apply({ kind: "revoke" })}
              >
                {t(
                  pending === "revoke"
                    ? "browserAccess.revoking"
                    : "browserAccess.revoke",
                )}
              </Button>
            )}
            {access?.kind === "pairing" && url ? (
              <ExternalLink href={url} className={buttonVariants()}>
                {t("browserAccess.open")}
              </ExternalLink>
            ) : access ? (
              <Button
                disabled={Boolean(pending)}
                onClick={() => void apply({ kind: "pair", mode })}
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
