import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/providers/i18n";
import { HostRequestError } from "@serial-workbench/host-client";

export function BrowserPairingScreen({
  pair,
}: {
  pair: (code: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "unavailable">();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const ticket = code.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      setError("invalid");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await pair(ticket);
    } catch (error) {
      setError(
        error instanceof HostRequestError && error.code === "UNAUTHENTICATED"
          ? "invalid"
          : "unavailable",
      );
      setBusy(false);
    }
  };
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <form
        className="grid w-full max-w-sm gap-4 rounded-lg border bg-card p-5 text-card-foreground sm:p-6"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="grid gap-2">
          <h1 className="text-lg font-semibold">{t("browserPairing.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("browserPairing.instructions")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="browser-pairing-code">
            {t("browserPairing.code")}
          </Label>
          <Input
            id="browser-pairing-code"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error === "invalid"}
            aria-describedby={error ? "browser-pairing-error" : undefined}
            value={code}
            readOnly={busy}
            required
            onChange={(event) => {
              setCode(event.target.value);
              setError(undefined);
            }}
          />
          {error && (
            <p
              id="browser-pairing-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {t(
                error === "invalid"
                  ? "browserPairing.invalid"
                  : "browserPairing.unavailable",
              )}
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy}>
          {t(busy ? "browserPairing.connecting" : "browserPairing.connect")}
        </Button>
      </form>
    </main>
  );
}
