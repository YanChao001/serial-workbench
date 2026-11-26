import { useId, useState, type FormEvent } from "react";
import type { OpenParams } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  udpEndpoint,
  type UdpFamily,
  type UdpMode,
} from "../../../packages/plugin-sdk/examples/reference-udp/endpoint";

const initial = { family: "ipv4", mode: "unicast" } satisfies {
  family: UdpFamily;
  mode: UdpMode;
};
const defaults = {
  host: "",
  port: "",
  localAddress: "",
  localPort: "",
  multicastInterface: "",
};
const endpointRow =
  "workbench-connection-fields grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-[minmax(0,1fr)_9rem]";

function numericPort(value: string) {
  return /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
}

export function UdpConnectionParameters({
  opening,
  error,
  onSubmit,
}: {
  opening: boolean;
  error?: string;
  onSubmit: (params: NonNullable<OpenParams["transportParams"]>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [family, setFamily] = useState<UdpFamily>(initial.family);
  const [mode, setMode] = useState<UdpMode>(initial.mode);
  const [drafts, setDrafts] = useState<Record<string, typeof defaults>>({});
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState<string>();
  const draftKey = family + "/" + mode;
  const fields = drafts[draftKey] ?? defaults;
  const signature = JSON.stringify([draftKey, fields]);
  const params = {
    family,
    mode,
    host: fields.host.trim(),
    port: numericPort(fields.port.trim()),
    ...(fields.localAddress.trim()
      ? { localAddress: fields.localAddress.trim() }
      : {}),
    ...(fields.localPort.trim()
      ? { localPort: numericPort(fields.localPort.trim()) }
      : {}),
    ...(mode === "multicast"
      ? { multicastInterface: fields.multicastInterface.trim() }
      : {}),
  };
  const endpoint = udpEndpoint(params);
  const invalid = "error" in endpoint ? endpoint.error : undefined;
  const hostError = !opening && submitted === signature ? error : undefined;
  const multicast = mode === "multicast";

  useUnsavedWork({
    id,
    label: t("udpConnection.title"),
    dirty:
      family !== initial.family ||
      mode !== initial.mode ||
      Object.values(drafts).some((draft) => Object.values(draft).some(Boolean)),
    retainAfterUnmount: false,
    discard: () => {
      setFamily(initial.family);
      setMode(initial.mode);
      setDrafts({});
      setAttempted(false);
      setSubmitted(undefined);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (opening) return;
    setAttempted(true);
    if (invalid) {
      const input = event.currentTarget.elements.namedItem(invalid);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setSubmitted(signature);
    onSubmit(params);
  }

  function field(
    name: keyof typeof defaults,
    label: string,
    validation: string,
    options?: { placeholder?: string; hint?: string; numeric?: boolean },
  ) {
    const inputId = id + "-" + name;
    const failed = attempted && invalid === name;
    return (
      <div className="grid min-w-0 gap-1.5">
        <label className="text-sm" htmlFor={inputId}>
          {label}
        </label>
        <Input
          id={inputId}
          name={name}
          className="w-full font-mono tabular-nums"
          autoComplete="off"
          spellCheck={false}
          inputMode={options?.numeric ? "numeric" : undefined}
          value={fields[name]}
          placeholder={options?.placeholder}
          readOnly={opening}
          aria-invalid={failed || undefined}
          aria-describedby={
            failed
              ? inputId + "-error"
              : options?.hint
                ? inputId + "-hint"
                : undefined
          }
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDrafts((current) => ({
              ...current,
              [draftKey]: { ...(current[draftKey] ?? defaults), [name]: value },
            }));
          }}
        />
        {failed ? (
          <p
            id={inputId + "-error"}
            role="alert"
            className="text-sm text-destructive wrap-anywhere"
          >
            {validation}
          </p>
        ) : options?.hint ? (
          <p id={inputId + "-hint"} className="text-sm text-muted-foreground">
            {options.hint}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="grid min-w-0 gap-3" aria-busy={opening} onSubmit={submit}>
      <div className="grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-family"}>
            {t("udpConnection.family")}
          </label>
          <OptionsSelect<UdpFamily>
            id={id + "-family"}
            value={family}
            className="w-full"
            options={[
              { value: "ipv4", label: "IPv4" },
              { value: "ipv6", label: "IPv6" },
            ]}
            disabled={opening}
            onValueChange={(next) => {
              setFamily(next);
              if (next === "ipv6" && mode === "broadcast") setMode("unicast");
              setAttempted(false);
            }}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-mode"}>
            {t("udpConnection.mode")}
          </label>
          <OptionsSelect<UdpMode>
            id={id + "-mode"}
            value={mode}
            className="w-full"
            options={[
              { value: "unicast", label: t("udpConnection.unicast") },
              ...(family === "ipv4"
                ? [
                    {
                      value: "broadcast" as const,
                      label: t("udpConnection.broadcast"),
                    },
                  ]
                : []),
              { value: "multicast", label: t("udpConnection.multicast") },
            ]}
            disabled={opening}
            onValueChange={(next) => {
              setMode(next);
              setAttempted(false);
            }}
          />
        </div>
      </div>
      <fieldset className={endpointRow}>
        <legend className="sr-only">{t("udpConnection.destination")}</legend>
        {field(
          "host",
          t(
            mode === "multicast"
              ? "udpConnection.groupAddress"
              : mode === "broadcast"
                ? "udpConnection.broadcastAddress"
                : "udpConnection.host",
          ),
          t("udpConnection.invalidHost"),
          mode === "broadcast" ? { placeholder: "255.255.255.255" } : undefined,
        )}
        {field(
          "port",
          t("udpConnection.port"),
          t("tcpConnection.invalidPort"),
          { numeric: true },
        )}
      </fieldset>
      <fieldset className={endpointRow}>
        <legend className="sr-only">{t("udpConnection.binding")}</legend>
        {multicast
          ? field(
              "multicastInterface",
              t("udpConnection.multicastInterface"),
              t(
                family === "ipv6"
                  ? "udpConnection.interfaceIndex"
                  : "udpConnection.interfaceAddress",
              ),
              {
                hint: t(
                  family === "ipv6"
                    ? "udpConnection.interfaceIndex"
                    : "udpConnection.interfaceAddress",
                ),
                numeric: family === "ipv6",
              },
            )
          : field(
              "localAddress",
              t("tcpConnection.bindAddress"),
              t("udpConnection.invalidLocalAddress"),
              {
                hint: t(
                  mode === "broadcast" &&
                    params.host &&
                    params.host !== "255.255.255.255"
                    ? "udpConnection.directedInterface"
                    : "udpConnection.anyAddress",
                ),
              },
            )}
        {field(
          "localPort",
          t("udpConnection.localPort"),
          t(
            multicast
              ? "tcpConnection.invalidPort"
              : "udpConnection.invalidLocalPort",
          ),
          {
            numeric: true,
            hint: t(
              multicast
                ? "udpConnection.destinationPortDefault"
                : "udpConnection.automaticPort",
            ),
          },
        )}
      </fieldset>
      {hostError ? (
        <p role="alert" className="text-sm text-destructive wrap-anywhere">
          {hostError}
        </p>
      ) : null}
      <Button type="submit" disabled={opening} className="justify-self-end">
        {t(opening ? "udpConnection.opening" : "udpConnection.open")}
      </Button>
    </form>
  );
}
