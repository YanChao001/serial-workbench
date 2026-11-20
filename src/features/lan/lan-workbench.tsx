import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LanRoute } from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getHostClient } from "@/lib/host-client";
import { nativeErrorText } from "@/lib/native-error";
import { hostSelectLanRoute, isTauri } from "@/lib/tauri";
import { HostProvider } from "@/providers/host";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { UnsavedWorkScope, useRequestLeave } from "@/providers/unsaved-work";
import {
  lastLanConnection,
  readLanInvitation,
  rememberLanConnection,
} from "./lan-pairing";
import { LanWorkbenchContext } from "./lan-workbench-context";

const workbenchScope = "workbench-connection";

export function LanWorkbench({ children }: { children: ReactNode }) {
  return isTauri() ? (
    <DesktopLanWorkbench>{children}</DesktopLanWorkbench>
  ) : (
    children
  );
}

function DesktopLanWorkbench({ children }: { children: ReactNode }) {
  const local = useHost();
  const { t } = useI18n();
  const [route, setRoute] = useState<LanRoute>();
  const [prompt, setPrompt] = useState<{
    returnFocus: HTMLButtonElement | null;
  }>();
  const connect = useCallback(async () => {
    const connection = await getHostClient();
    if (
      !route ||
      connection.lanRoute?.hostId !== route.hostId ||
      connection.lanRoute.address !== route.address
    ) {
      connection.dispose();
      throw new HostRequestError({
        code: "EPOCH_MISMATCH",
        message: "The selected computer changed",
        retryable: true,
      });
    }
    return connection;
  }, [route]);
  return (
    <UnsavedWorkScope scope={workbenchScope}>
      <HostProvider
        enabled={route !== undefined}
        connect={connect}
        localWorkspace={local}
      >
        <LanWorkbenchContext
          value={{
            route,
            title: t("lanConnection.title"),
            source: t("lanConnection.source"),
            description:
              route &&
              t("lanConnection.sourceDetail", { address: route.address }),
            open: (returnFocus) => setPrompt({ returnFocus }),
          }}
        >
          {children}
        </LanWorkbenchContext>
        {prompt && (
          <LanConnectionDialog
            current={route}
            returnFocus={prompt.returnFocus}
            onClose={() => setPrompt(undefined)}
            onConnected={(selected) => {
              setRoute(selected);
              setPrompt(undefined);
            }}
          />
        )}
      </HostProvider>
    </UnsavedWorkScope>
  );
}

function LanConnectionDialog({
  current,
  returnFocus,
  onClose,
  onConnected,
}: {
  current?: LanRoute;
  returnFocus: HTMLButtonElement | null;
  onClose: () => void;
  onConnected: (route: LanRoute | undefined) => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const id = useId();
  const requestLeave = useRequestLeave();
  const [route, setRoute] = useState(lastLanConnection);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const operation = useRef<AbortController>(null);
  const pairingInput = useRef<HTMLInputElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const nextFocus = useRef<"pairing" | "address">(null);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (nextFocus.current === null) return;
    const input = nextFocus.current === "pairing" ? pairingInput : addressInput;
    input.current?.focus();
    nextFocus.current = null;
  }, [route?.hostId]);

  function chooseInvitation(value: string) {
    const invitation = readLanInvitation(value);
    setError(undefined);
    if (!invitation) {
      setText(value);
      return;
    }
    nextFocus.current = "address";
    setRoute({
      hostId: invitation.peer.hostId,
      address: invitation.address ?? "",
    });
    setText("");
  }

  async function select(next: LanRoute | null) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError(undefined);
    try {
      if (!(await requestLeave(workbenchScope, controller.signal))) return;
      controller.signal.throwIfAborted();
      const result = await hostSelectLanRoute(
        host.connection?.generation,
        next,
      );
      if (controller.signal.aborted) return;
      if (result.lanRoute) rememberLanConnection(result.lanRoute);
      onConnected(result.lanRoute);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason);
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (returnFocus?.isConnected) {
            event.preventDefault();
            returnFocus.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("lanConnection.title")}</DialogTitle>
          <DialogDescription>
            {current
              ? t("lanConnection.connected", { address: current.address })
              : t("lanConnection.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (current) void select(null);
            else if (route?.address.trim())
              void select({ ...route, address: route.address.trim() });
          }}
        >
          {!current && (
            <div className="grid gap-2">
              {route ? (
                <>
                  <Label htmlFor={id}>{t("lanConnection.address")}</Label>
                  <Input
                    id={id}
                    ref={addressInput}
                    required
                    maxLength={128}
                    placeholder="192.168.1.8:8022"
                    autoComplete="off"
                    disabled={pending}
                    value={route.address}
                    onChange={(event) =>
                      setRoute({ ...route, address: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="justify-self-start"
                    disabled={pending}
                    onClick={() => {
                      nextFocus.current = "pairing";
                      setRoute(undefined);
                      setError(undefined);
                    }}
                  >
                    {t("lanConnection.changeComputer")}
                  </Button>
                </>
              ) : (
                <>
                  <Label htmlFor={id}>{t("lanConnection.invitation")}</Label>
                  <Input
                    id={id}
                    ref={pairingInput}
                    type="password"
                    autoComplete="off"
                    maxLength={768}
                    value={text}
                    disabled={pending}
                    onChange={(event) => chooseInvitation(event.target.value)}
                  />
                  {text && (
                    <p className="text-sm text-muted-foreground">
                      {t("lanAccess.invalidPeer")}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {error !== undefined && (
            <p className="text-sm text-destructive" role="alert">
              {nativeErrorText(error, t)}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={pending || (!current && !route?.address.trim())}
              aria-busy={pending}
            >
              {pending
                ? t("lanConnection.switching")
                : current
                  ? t("lanConnection.returnLocal")
                  : t("lanConnection.connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
