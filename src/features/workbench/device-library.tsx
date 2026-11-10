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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Info } from "lucide-react";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { nativeErrorCode } from "@/lib/native-error";

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
> & {
  editedWhileSaving?: string;
  onlineDevices: string;
  details: string;
  offlineDevice: string;
  noDevices: string;
  loading: string;
  retry: string;
  serialIdentity: string;
  topologyIdentity: string;
  unknownIdentity: string;
  virtualDevice: string;
  failure: (code: string) => string;
};
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
  recentLoading?: boolean;
  recentError?: string;
  onRetryRecent?: () => void;
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
  recentLoading,
  recentError,
  onRetryRecent,
}: DeviceLibraryProps) {
  const [activeDevice, setActiveDevice] = useState<string>();
  const selectedDevice =
    devices.find(
      (device) => `${device.hostId}:${device.deviceId}` === activeDevice,
    ) ?? devices[0];
  const [selection, setSelection] = useState<RebindParams>();
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const [confirmed, setConfirmed] = useState(workspace);
  const incomingRevision = workspace?.document.revision;
  const previousRevision = useRef(incomingRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [eventKey, setEventKey] = useState<string>();
  const [failureIndex, setFailureIndex] = useState(0);
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
      setEventKey(undefined);
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
    setEventKey(undefined);
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        setError(nativeErrorCode(reason) ?? "OPERATION_FAILED");
        setEventKey(operationFailureEventKey(reason));
        setFailureIndex((value) => value + 1);
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
      className="workbench-device-library text-sm"
      aria-busy={busy}
    >
      <h2 className="sr-only">{labels.deviceLibrary}</h2>
      <WorkbenchNotice
        noticeKey={`device:${failureIndex}`}
        eventKey={eventKey}
        log={{
          module: "workspace",
          level: "error",
          code: error,
          message: error ? labels.failure(error) : "",
        }}
      >
        {error ? <span role="alert">{labels.failure(error)}</span> : null}
      </WorkbenchNotice>
      <Tabs defaultValue="online" className="workbench-tool-pages">
        <TabsList variant="line">
          <TabsTrigger value="online">{labels.onlineDevices}</TabsTrigger>
          <TabsTrigger value="recent">{labels.recentConnections}</TabsTrigger>
          <TabsTrigger value="favorites">{labels.favorites}</TabsTrigger>
        </TabsList>
        <TabsContent value="online" className="workbench-device-browser">
          <div
            className="workbench-device-list app-scroll-region"
            aria-label={labels.onlineDevices}
          >
            {!devices.length && (
              <p className="text-muted-foreground">{labels.noDevices}</p>
            )}
            {devices.map((device) => (
              <Button
                key={`${device.hostId}:${device.deviceId}`}
                size="sm"
                variant="ghost"
                aria-pressed={selectedDevice === device}
                onClick={() =>
                  setActiveDevice(`${device.hostId}:${device.deviceId}`)
                }
              >
                {device.systemName}
              </Button>
            ))}
          </div>
          <div
            className="workbench-device-detail app-scroll-region"
            aria-label={labels.deviceInformation}
          >
            {(selectedDevice ? [selectedDevice] : []).map((device) => (
              <section
                key={`${device.hostId}:${device.deviceId}`}
                className="workbench-device-information"
              >
                <div className="workbench-toolbar">
                  <h3>{device.systemName}</h3>
                  <span className="workbench-toolbar-spacer" />
                  <DeviceDetails device={device} labels={labels} />
                </div>
                {device.fingerprint.transport === "virtual" ? (
                  <p className="text-muted-foreground">
                    {labels.virtualDevice}
                  </p>
                ) : (
                  <dl className="workbench-device-facts">
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
                        [
                          labels.identityEvidence,
                          device.fingerprint.evidence === "serialNumber"
                            ? labels.serialIdentity
                            : device.fingerprint.evidence === "topology"
                              ? labels.topologyIdentity
                              : labels.unknownIdentity,
                        ],
                      ] as const
                    )
                      .filter(([, value]) => value !== undefined)
                      .map(([label, value]) => (
                        <div key={label} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-all">
                            {value ?? labels.missingEvidence}
                          </dd>
                        </div>
                      ))}
                  </dl>
                )}
              </section>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="recent" className="workbench-tool-page">
          <fieldset disabled={disabled || busy} aria-busy={recentLoading}>
            <legend className="sr-only">{labels.recentConnections}</legend>
            {recentLoading && (
              <p role="status" className="text-muted-foreground">
                {labels.loading}
              </p>
            )}
            {recentError && (
              <div className="workbench-toolbar">
                <p>{labels.failure(recentError)}</p>
                <Button size="sm" variant="outline" onClick={onRetryRecent}>
                  {labels.retry}
                </Button>
              </div>
            )}
            {!recent ? null : !recent.entries.length ? (
              <p>{labels.noRecent}</p>
            ) : (
              <ul className="space-y-2">
                {recent.entries.map((entry, index) => (
                  <li key={`${entry.deviceId}:${entry.openedAt}:${index}`}>
                    <div className="workbench-toolbar">
                      <span>
                        {devices.find(
                          (device) => device.deviceId === entry.deviceId,
                        )?.systemName ?? `${labels.offlineDevice} ${index + 1}`}
                      </span>
                      <span className="workbench-toolbar-spacer" />
                      <DeviceDetails device={entry} labels={labels} />
                    </div>
                    <time
                      dateTime={entry.openedAt}
                      className="text-xs text-muted-foreground"
                    >
                      {new Date(entry.openedAt).toLocaleString(undefined, {
                        hourCycle: "h23",
                      })}
                    </time>
                    <p aria-label={labels.configuration} className="text-xs">
                      {entry.configuration.baudRate} /{" "}
                      {entry.configuration.dataBits}
                      {
                        {
                          none: "N",
                          even: "E",
                          odd: "O",
                          mark: "M",
                          space: "S",
                        }[entry.configuration.parity]
                      }
                      {
                        { one: "1", onePointFive: "1.5", two: "2" }[
                          entry.configuration.stopBits
                        ]
                      }
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </TabsContent>
        <TabsContent value="favorites" className="workbench-tool-page">
          <fieldset disabled={blocked}>
            <legend className="sr-only">{labels.favorites}</legend>
            {!document?.bindings.length ? (
              <p className="text-xs text-muted-foreground">
                {labels.noBindings}
              </p>
            ) : (
              <ul className="space-y-3">
                {document.bindings.map((binding, index) => {
                  const bindingName =
                    document.views.find(
                      (view) => view.bindingId === binding.bindingId,
                    )?.name ?? `${labels.binding} ${index + 1}`;
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
                        {bindingName} ·{" "}
                        {devices.find(
                          (device) =>
                            device.deviceId === binding.deviceId &&
                            device.hostId === binding.hostId,
                        )?.systemName ?? labels.offlineDevice}
                        {!available && ` · ${labels.disconnected}`}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${favorite ? labels.removeFavorite : labels.addFavorite} ${bindingName}`}
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
                      <label className="workbench-form-row">
                        <span>{labels.chooseDevice}</span>
                        <Select
                          disabled={blocked || !onRebindDevice}
                          value={
                            selection?.bindingId === binding.bindingId
                              ? selection.deviceId
                              : ""
                          }
                          onValueChange={(value) =>
                            changeSelection(
                              value
                                ? {
                                    bindingId: binding.bindingId,
                                    deviceId: value,
                                  }
                                : undefined,
                            )
                          }
                        >
                          <SelectTrigger
                            aria-label={`${labels.chooseDevice} ${bindingName}`}
                          >
                            <SelectValue placeholder={labels.chooseDevice} />
                          </SelectTrigger>
                          <SelectContent>
                            {devices
                              .filter(
                                (device) => device.hostId === binding.hostId,
                              )
                              .map((device) => (
                                <SelectItem
                                  key={device.deviceId}
                                  value={device.deviceId}
                                >
                                  {device.systemName}
                                  {device.fingerprint.serialNumber
                                    ? ` · ${device.fingerprint.serialNumber}`
                                    : ""}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${labels.rebind} ${bindingName}`}
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
            <p className="sr-only">{labels.rebindHelp}</p>
          </fieldset>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function DeviceDetails({
  device,
  labels,
}: {
  device: Pick<DeviceDescriptor, "deviceId" | "fingerprint">;
  labels: DeviceLibraryLabels;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkbenchIconButton label={labels.details}>
          <Info aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        className="workbench-detail-popover"
        aria-label={labels.details}
      >
        <Textarea
          readOnly
          aria-label={labels.details}
          value={JSON.stringify(
            { deviceId: device.deviceId, fingerprint: device.fingerprint },
            null,
            2,
          )}
          onFocus={(event) => event.currentTarget.select()}
        />
      </PopoverContent>
    </Popover>
  );
}
