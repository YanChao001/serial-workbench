import { useEffect, useState } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type { HostConnection } from "@/lib/host-client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/providers/i18n";
import {
  prepareBrowserView,
  type BrowserViewRequest,
} from "./browser-view-assets";
import { readBrowserViewRaw } from "./browser-view-raw";
import { PluginError } from "./plugin-error";

export type BrowserViewOpen = BrowserViewRequest & {
  title: string;
  locale: string;
  dark: boolean;
  opener?: HTMLElement;
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
  const { t } = useI18n();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const browser = connection.browser;
    if (!container || !browser) return;
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, browser.closed]);
    let port: MessagePort | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: unknown) => {
      if (signal.aborted) return;
      setError(reason);
      owner.abort();
    };

    void (async () => {
      const viewConnection = await browser.openViewConnection(signal);
      signal.throwIfAborted();
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
      frame.className = "h-[min(28rem,65vh)] w-full rounded-md bg-background";
      const frameId = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const url = new URL("/browser-plugin-frame", location.origin);
      url.hash = [frameId, view.locale, view.dark ? "dark" : "light"].join(".");
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
          if (
            !opened ||
            port ||
            !transferred ||
            event.source !== frame.contentWindow ||
            event.origin !== "null" ||
            event.data !== frameId ||
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
            setReading(true);
            await readBrowserViewRaw(
              viewConnection,
              view.target,
              opened,
              prepared.authorize,
              fail,
              signal,
            );
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
        className="sm:max-w-3xl"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (!view.opener?.isConnected) return;
          event.preventDefault();
          view.opener.focus();
        }}
      >
        <DialogTitle>{view.title}</DialogTitle>
        <PluginError error={error} message="plugins.viewError" />
        {!reading && !error ? <p role="status">{t("common.loading")}</p> : null}
        <div ref={setContainer} />
      </DialogContent>
    </Dialog>
  );
}
