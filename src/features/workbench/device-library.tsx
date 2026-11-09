import { useEffect, useRef, useState } from "react";
import type {
  DeviceDescriptor,
  FavoritesSaveParams,
  RecentList,
  RebindParams,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { stateScopeKey } from "@/lib/host-scope";
import { Button } from "@/components/ui/button";

export type DeviceLibraryLabels = Record<
  | "deviceLibrary"
  | "deviceInformation"
  | "manufacturer"
  | "driver"
  | "usbVid"
  | "usbPid"
  | "serialNumber"
  | "topologyPath"
  | "identityEvidence"
  | "missingEvidence"
  | "recentConnections"
  | "favorites"
  | "noRecent"
  | "noBindings"
  | "addFavorite"
  | "removeFavorite"
  | "rebind"
  | "chooseDevice"
  | "binding"
  | "configuration"
  | "disconnected"
  | "refreshRecent"
  | "unavailable"
  | "rebindHelp",
  string
> & { editedWhileSaving?: string };
export type DeviceLibraryProps = {
  devices: readonly DeviceDescriptor[];
  workspace?: WorkspaceDocumentResult;
  recent?: RecentList;
  labels: DeviceLibraryLabels;
  disabled?: boolean;
  onSaveFavorites?: (
    base: WorkspaceDocumentResult,
    params: FavoritesSaveParams,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDocumentResult>;
  onRebindDevice?: (
    base: WorkspaceDocumentResult,
    params: RebindParams,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDocumentResult>;
  onAcknowledged?: (result: WorkspaceDocumentResult) => void;
  onRefreshRecent?: (signal?: AbortSignal) => Promise<void>;
};
export function DeviceLibrary(props: DeviceLibraryProps) {
  return (
    <LibraryContent key={stateScopeKey(props.workspace?.scope)} {...props} />
  );
}

function LibraryContent({
  devices,
  workspace,
  recent,
  labels,
  disabled = false,
  onSaveFavorites,
  onRebindDevice,
  onAcknowledged,
  onRefreshRecent,
}: DeviceLibraryProps) {
  const [selection, setSelection] = useState<RebindParams>();
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const [confirmed, setConfirmed] = useState(workspace);
  const incomingRevision = workspace?.document.revision;
  const previousRevision = useRef(incomingRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (previousRevision.current !== incomingRevision) {
      previousRevision.current = incomingRevision;
      pending.current?.abort();
      setConfirmed(workspace);
      setError(undefined);
    }
  }, [incomingRevision, workspace]);
  const document = confirmed?.document.value;
  const blocked = disabled || !confirmed;
  function changeSelection(next: RebindParams | undefined) {
    latestSelection.current = next;
    setSelection(next);
  }
  async function act<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (pending.current) throw new Error(labels.unavailable);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const release = () => {
      if (pending.current === controller) {
        pending.current = null;
        if (mounted.current) setBusy(false);
      }
    };
    controller.signal.addEventListener("abort", release, { once: true });
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        const code =
          typeof reason === "object" && reason !== null && "code" in reason
            ? reason.code
            : undefined;
        const message =
          reason instanceof Error
            ? reason.message
            : typeof reason === "object" &&
                reason !== null &&
                "message" in reason
              ? String(reason.message)
              : String(reason);
        setError(typeof code === "string" ? `${code}: ${message}` : message);
      }
      throw reason;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", release);
      release();
    }
  }
  async function mutate(
    action: (
      base: WorkspaceDocumentResult,
      signal: AbortSignal,
    ) => Promise<WorkspaceDocumentResult>,
    signal?: AbortSignal,
  ) {
    if (blocked || !confirmed) throw new Error(labels.unavailable);
    const result = await act(
      (requestSignal) => action(confirmed, requestSignal),
      signal,
    );
    setConfirmed(result);
    onAcknowledged?.(result);
  }
  async function saveFavorites(params: FavoritesSaveParams) {
    if (!onSaveFavorites) throw new Error(labels.unavailable);
    await mutate((base, signal) => onSaveFavorites(base, params, signal));
  }
  async function rebind(signal?: AbortSignal) {
    if (
      !onRebindDevice ||
      !selection ||
      !document?.bindings.some(
        (binding) =>
          binding.bindingId === selection.bindingId &&
          devices.some(
            (device) =>
              device.hostId === binding.hostId &&
              device.deviceId === selection.deviceId,
          ),
      )
    )
      throw new Error(labels.chooseDevice);
    const snapshot = selection;
    await mutate(
      (base, requestSignal) => onRebindDevice(base, snapshot, requestSignal),
      signal,
    );
    if (latestSelection.current === snapshot) changeSelection(undefined);
    else if (signal)
      throw new Error(labels.editedWhileSaving ?? "New changes need saving");
  }
  function run(action: () => Promise<unknown>) {
    void action().catch(() => {});
  }
  useUnsavedWork({
    id: `device-library-rebind-${workspace?.scope.target.hostId}-${workspace?.scope.target.id}`,
    label: labels.rebind,
    dirty: Boolean(selection),
    save: rebind,
    discard: () => changeSelection(undefined),
  });
  return (
    <section
      aria-label={labels.deviceLibrary}
      data-panel-id="device-library"
      className="space-y-3 border-t p-3 text-sm"
      aria-busy={busy}
    >
      <h2 className="font-medium">{labels.deviceLibrary}</h2>
      {error && <p role="alert">{error}</p>}
      <div className="space-y-2" aria-label={labels.deviceInformation}>
        {devices.map((device) => (
          <details key={`${device.hostId}:${device.deviceId}`} open>
            <summary className="cursor-pointer">{device.systemName}</summary>
            <dl className="grid grid-cols-2 gap-x-2 text-xs">
              {(
                [
                  [labels.manufacturer, device.manufacturer],
                  [labels.driver, device.driver],
                  [
                    labels.usbVid,
                    device.fingerprint.vid?.toString(16).padStart(4, "0"),
                  ],
                  [
                    labels.usbPid,
                    device.fingerprint.pid?.toString(16).padStart(4, "0"),
                  ],
                  [labels.serialNumber, device.fingerprint.serialNumber],
                  [labels.topologyPath, device.fingerprint.topologyPath],
                  [labels.identityEvidence, device.fingerprint.evidence],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all">
                    {value ?? labels.missingEvidence}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </div>
      <fieldset disabled={disabled || busy}>
        <legend>{labels.recentConnections}</legend>
        {onRefreshRecent && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run(() => act(onRefreshRecent))}
          >
            {labels.refreshRecent}
          </Button>
        )}
        {!recent ? (
          <p className="text-xs text-muted-foreground">{labels.unavailable}</p>
        ) : !recent.entries.length ? (
          <p>{labels.noRecent}</p>
        ) : (
          <ul className="space-y-2">
            {recent.entries.map((entry, index) => (
              <li key={`${entry.deviceId}:${entry.openedAt}:${index}`}>
                <p>{entry.deviceId}</p>
                <p className="text-xs">{entry.openedAt}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {entry.fingerprint.serialNumber ??
                    entry.fingerprint.topologyPath ??
                    labels.missingEvidence}{" "}
                  · {entry.fingerprint.evidence}
                </p>
                <pre
                  aria-label={labels.configuration}
                  className="overflow-auto text-xs"
                >
                  {JSON.stringify(entry.configuration, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <fieldset disabled={blocked}>
        <legend>{labels.favorites}</legend>
        {!document?.bindings.length ? (
          <p className="text-xs text-muted-foreground">{labels.noBindings}</p>
        ) : (
          <ul className="space-y-3">
            {document.bindings.map((binding) => {
              const favorite = document.favoriteBindingIds.includes(
                binding.bindingId,
              );
              const available = devices.some(
                (device) =>
                  device.deviceId === binding.deviceId &&
                  device.hostId === binding.hostId,
              );
              return (
                <li key={binding.bindingId} className="space-y-2">
                  <p>
                    {labels.binding}: {binding.bindingId} · {binding.deviceId}
                    {!available && ` · ${labels.disconnected}`}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${favorite ? labels.removeFavorite : labels.addFavorite} ${binding.bindingId}`}
                    disabled={busy || !onSaveFavorites}
                    onClick={() =>
                      run(() =>
                        saveFavorites({
                          bindingIds: favorite
                            ? document.favoriteBindingIds.filter(
                                (id) => id !== binding.bindingId,
                              )
                            : [
                                ...document.favoriteBindingIds,
                                binding.bindingId,
                              ],
                        }),
                      )
                    }
                  >
                    {favorite ? labels.removeFavorite : labels.addFavorite}
                  </Button>
                  <label className="block text-xs">
                    {labels.chooseDevice} {binding.bindingId}
                    <select
                      className="w-full"
                      disabled={!onRebindDevice}
                      value={
                        selection?.bindingId === binding.bindingId
                          ? selection.deviceId
                          : ""
                      }
                      onChange={(event) =>
                        changeSelection(
                          event.target.value
                            ? {
                                bindingId: binding.bindingId,
                                deviceId: event.target.value,
                              }
                            : undefined,
                        )
                      }
                    >
                      <option value="">{labels.chooseDevice}</option>
                      {devices
                        .filter((device) => device.hostId === binding.hostId)
                        .map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.systemName} ·{" "}
                            {device.fingerprint.serialNumber ??
                              device.fingerprint.topologyPath ??
                              labels.missingEvidence}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${labels.rebind} ${binding.bindingId}`}
                    disabled={
                      busy ||
                      !onRebindDevice ||
                      selection?.bindingId !== binding.bindingId ||
                      !devices.some(
                        (device) =>
                          device.deviceId === selection.deviceId &&
                          device.hostId === binding.hostId,
                      )
                    }
                    onClick={() => run(() => rebind())}
                  >
                    {labels.rebind}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{labels.rebindHelp}</p>
      </fieldset>
    </section>
  );
}
