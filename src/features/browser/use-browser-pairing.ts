import { useCallback, useRef, useState } from "react";
import { HostRequestError } from "@serial-workbench/host-client";
import {
  browserReconnectCredential,
  createBrowserHostConnection,
} from "@/lib/host-browser-transport";
import { browserHostClientId } from "@/lib/browser-host-page";

type SavedPairing = { credential: string; hostId: string };
type BrowserConnection = Awaited<
  ReturnType<typeof createBrowserHostConnection>
>;

function readPairing(key: string): SavedPairing | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "credential" in value &&
      typeof value.credential === "string" &&
      "hostId" in value &&
      typeof value.hostId === "string"
    )
      return { credential: value.credential, hostId: value.hostId };
  } catch {
    // Pairing remains available in memory if browser storage is disabled.
  }
}

export function useBrowserPairing() {
  const [clientId] = useState(browserHostClientId);
  const key = `serial-workbench.browser-pairing.v1.${clientId}`;
  const [saved, setSaved] = useState(() =>
    clientId ? readPairing(key) : undefined,
  );
  const initialConnection = useRef<BrowserConnection>(undefined);

  const connect = useCallback(async () => {
    const attached = initialConnection.current;
    initialConnection.current = undefined;
    if (attached && !attached.browser.closed.aborted) return attached;
    if (!saved) throw new Error("The browser has not been paired");
    try {
      return await createBrowserHostConnection(saved.credential, {
        expectedHostId: saved.hostId,
      });
    } catch (error) {
      if (
        error instanceof HostRequestError &&
        (error.code === "UNAUTHENTICATED" || error.code === "HOST_ID_MISMATCH")
      ) {
        try {
          sessionStorage.removeItem(key);
        } catch {
          // The next manual pairing can still keep its proof in memory.
        }
        setSaved(undefined);
      }
      throw error;
    }
  }, [key, saved]);

  const pair = async (code: string) => {
    if (!clientId) throw new Error("The browser pairing page is unavailable");
    const credential = browserReconnectCredential();
    const attached = await createBrowserHostConnection(credential, {
      pairingCode: code,
    }).catch((error: unknown) => {
      if (
        error instanceof HostRequestError &&
        error.code === "BROWSER_CONNECTION_CLOSED"
      )
        return createBrowserHostConnection(credential);
      throw error;
    });
    const pairing = { credential, hostId: attached.attachment.hostId };
    try {
      sessionStorage.setItem(key, JSON.stringify(pairing));
    } catch {
      // This tab can still reconnect with the credential held in memory.
    }
    initialConnection.current = attached;
    setSaved(pairing);
  };
  return { clientId, paired: Boolean(saved), connect, pair };
}
