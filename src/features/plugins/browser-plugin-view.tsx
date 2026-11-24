import { useEffect, useRef, useState } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import { XIcon } from "lucide-react";
import type { HostConnection } from "@/lib/host-client";
import { LanguageSwitch } from "@/components/language-switch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { getLocale } from "@/i18n/registry";
import { useI18n } from "@/providers/i18n";
import {
  prepareBrowserView,
  type BrowserViewRequest,
} from "./browser-view-assets";
import { readBrowserViewDerived } from "./browser-view-derived";
import { readBrowserViewRaw } from "./browser-view-raw";
import { PluginError } from "./plugin-error";

export type BrowserViewOpen = BrowserViewRequest & {
  title: string;
  dark: boolean;
  opener?: HTMLElement;
  forgetFeed?: () => void;
};

export function BrowserPluginView({
  connection,
  view,
  onClose,
}: {
  connection: HostConnection;
  view: BrowserViewOpen;
  onClose: () => void;
}) {
  const { language, t } = useI18n();
  const locale = getLocale(language).documentLang;
  const latestLocale = useRef(locale);
  const localePort = useRef<MessagePort | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    latestLocale.current = locale;
    localePort.current?.postMessage({ kind: "viewLocale", locale });
  }, [locale]);

  useEffect(() => {
    const browser = connection.browser;
    if (!container || !browser) return;
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, browser.closed]);
    let port: MessagePort | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: unknown) => {
      if (signal.aborted) return;
      if (
        reason instanceof HostRequestError &&
        (reason.code === "NOT_FOUND" ||
          reason.code === "CATALOG_CHANGED" ||
          reason.code === "UNSUPPORTED_CAPABILITY")
      )
        view.forgetFeed?.();
      setError(reason);
      owner.abort();
    };

    void (async () => {
      const viewConnection = await browser.openViewConnection(signal);
      signal.throwIfAborted();
      const viewClosed = viewConnection.browser?.closed;
      if (!viewClosed)
        throw new ContractValidationError("Plugin view connection changed");
      viewClosed.throwIfAborted();
      viewClosed.addEventListener("abort", () => fail(viewClosed.reason), {
        signal,
        once: true,
      });
      const [prepared, snapshot] = await Promise.all([
        prepareBrowserView(connection, view, signal),
        connection.client.query(
          connection.buildQuery("session.get", view.target),
          signal,
        ),
      ]);
      if (
        snapshot.kind !== "session" ||
        snapshot.value.sessionId !== view.target.sessionId ||
        snapshot.value.sessionEpoch !== view.target.sessionEpoch
      )
        throw new ContractValidationError("Plugin session changed");

      signal.throwIfAborted();
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.title = view.title;
      frame.className =
        "block h-[min(28rem,60dvh)] w-full rounded-md bg-background";
      const frameId = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const url = new URL("/browser-plugin-frame", location.origin);
      url.hash = [
        frameId,
        latestLocale.current,
        view.dark ? "dark" : "light",
        "locale",
      ].join(".");
      let loaded = false;
      let transferred = false;
      function onLoad() {
        if (loaded) {
          fail(new ContractValidationError("Plugin frame changed"));
          return;
        }
        loaded = true;
        void prepared
          .authorize()
          .then(() => {
            signal.throwIfAborted();
            // opaque origin 不能作为 targetOrigin。浏览器父页仅向本次创建的 frame 发送验证后资源。
            transferred = true;
            const { payload } = prepared;
            frame.contentWindow?.postMessage(
              payload,
              "*",
              [...payload.scripts, ...payload.styles].map(
                ({ buffer }) => buffer,
              ),
            );
          })
          .catch(fail);
      }
      frame.addEventListener("load", onLoad, { signal });
      window.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          const [opened] = event.ports;
          const data = event.data;
          const localeUpdates = Boolean(
            data &&
            typeof data === "object" &&
            "frameId" in data &&
            data.frameId === frameId &&
            "localeUpdates" in data &&
            data.localeUpdates === true,
          );
          if (
            !opened ||
            port ||
            !transferred ||
            event.source !== frame.contentWindow ||
            event.origin !== "null" ||
            (data !== frameId && !localeUpdates) ||
            event.ports.length !== 1
          )
            return;
          clearTimeout(timer);
          port = opened;
          opened.onmessageerror = () =>
            fail(new ContractValidationError("Plugin port closed"));
          void (async () => {
            await prepared.authorize();
            signal.throwIfAborted();
            opened.postMessage({ ok: true, result: snapshot });
            if (localeUpdates) {
              localePort.current = opened;
              opened.postMessage({
                kind: "viewLocale",
                locale: latestLocale.current,
              });
            }
            setReading(true);
            if (prepared.feed === "derived") {
              await readBrowserViewDerived(
                viewConnection,
                view,
                opened,
                prepared.authorize,
                fail,
                signal,
              );
            } else {
              await readBrowserViewRaw(
                viewConnection,
                view.target,
                opened,
                prepared.authorize,
                fail,
                signal,
              );
            }
          })().catch(fail);
        },
        { signal },
      );
      await connection
        .onCatalogChanged(() => void prepared.authorize().catch(fail))
        .then((unsubscribe) => {
          if (signal.aborted) unsubscribe();
          else signal.addEventListener("abort", unsubscribe, { once: true });
        });
      signal.throwIfAborted();
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          if (localePort.current === port) localePort.current = null;
          port?.close();
          frame.remove();
        },
        { once: true },
      );
      timer = setTimeout(
        () => fail(new ContractValidationError("Plugin frame unavailable")),
        10000,
      );
      frame.src = url.href;
      container.append(frame);
    })().catch(fail);

    return () => owner.abort();
  }, [connection, container, view]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] gap-3 sm:max-w-3xl"
        aria-describedby={undefined}
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          if (!view.opener?.isConnected) return;
          event.preventDefault();
          view.opener.focus();
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
          <DialogTitle className="col-span-3 leading-snug wrap-anywhere sm:col-span-1">
            {view.title}
          </DialogTitle>
          <LanguageSwitch className="col-start-2 w-fit" />
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("common.close")}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>
        <PluginError error={error} message="plugins.viewError" />
        {!reading && !error ? (
          <p
            role="status"
            data-surface="reading"
            className="flex min-h-20 items-center rounded-md px-3 text-muted-foreground"
          >
            {t("common.loading")}
          </p>
        ) : null}
        <div ref={setContainer} hidden={!reading || Boolean(error)} />
      </DialogContent>
    </Dialog>
  );
}
