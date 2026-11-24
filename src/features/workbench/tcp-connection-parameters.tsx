import { useId, useRef, useState, type FormEvent } from "react";
import type { OpenParams } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  defaultTcpHost,
  tcpHostPattern,
  type TcpRole,
} from "../../../packages/plugin-sdk/examples/reference-transport/tcp-endpoint";

const initial = { role: "client" as TcpRole, host: defaultTcpHost, port: "" };

function isListeningAddress(host: string) {
  if (!host.includes(":")) {
    const parts = host.split(".");
    return (
      parts.length === 4 &&
      parts.every(
        (part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
      )
    );
  }

  const [ip, scope, ...extra] = host.split("%");
  if (scope === "" || extra.length > 0) return false;
  try {
    new URL("http://[" + ip + "]/");
    return true;
  } catch {
    return false;
  }
}

export function TcpConnectionParameters({
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
  const addressInput = useRef<HTMLInputElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const { role } = fields;
  const listening = role === "server";
  const host = fields.host.trim();
  const port = Number(fields.port);
  const hostValid =
    tcpHostPattern.test(host) && (!listening || isListeningAddress(host));
  const portValid = /^\d{1,5}$/.test(fields.port) && port > 0 && port <= 65_535;
  const hostInvalid = attempted && !hostValid;
  const portInvalid = attempted && !portValid;
  const button = listening
    ? opening
      ? t("tcpConnection.starting")
      : t("tcpConnection.listen")
    : opening
      ? t("tcpConnection.connecting")
      : t("tcpConnection.connect");

  useUnsavedWork({
    id,
    label: t("tcpConnection.title"),
    dirty:
      role !== initial.role ||
      fields.host !== initial.host ||
      fields.port !== initial.port,
    retainAfterUnmount: false,
    discard: () => {
      setFields(initial);
      setAttempted(false);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (opening) return;
    setAttempted(true);
    if (!hostValid) addressInput.current?.focus();
    else if (!portValid) portInput.current?.focus();
    else onSubmit({ role, host, port });
  }

  return (
    <form className="grid min-w-0 gap-3" aria-busy={opening} onSubmit={submit}>
      <div className="grid min-w-0 gap-1.5">
        <label className="text-sm" htmlFor={id + "-role"}>
          {t("tcpConnection.role")}
        </label>
        <OptionsSelect<TcpRole>
          id={id + "-role"}
          value={role}
          className="w-full"
          options={[
            { value: "client", label: t("tcpConnection.client") },
            { value: "server", label: t("tcpConnection.server") },
          ]}
          disabled={opening}
          onValueChange={(next) =>
            setFields((current) => ({ ...current, role: next }))
          }
        />
      </div>
      <div className="grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-[minmax(0,1fr)_9rem]">
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-host"}>
            {t(
              listening
                ? "tcpConnection.bindAddress"
                : "tcpConnection.remoteAddress",
            )}
          </label>
          <Input
            id={id + "-host"}
            ref={addressInput}
            className="w-full font-mono"
            autoComplete="off"
            spellCheck={false}
            value={fields.host}
            readOnly={opening}
            aria-invalid={hostInvalid || undefined}
            aria-describedby={hostInvalid ? id + "-host-error" : undefined}
            onChange={(event) => {
              const host = event.currentTarget.value;
              setFields((current) => ({ ...current, host }));
            }}
          />
          {hostInvalid ? (
            <p
              id={id + "-host-error"}
              role="alert"
              className="text-sm text-destructive"
            >
              {t(
                listening
                  ? "tcpConnection.invalidBindAddress"
                  : "tcpConnection.invalidRemoteAddress",
              )}
            </p>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-port"}>
            {t("tcpConnection.port")}
          </label>
          <Input
            id={id + "-port"}
            ref={portInput}
            className="w-full font-mono tabular-nums"
            inputMode="numeric"
            autoComplete="off"
            value={fields.port}
            readOnly={opening}
            aria-invalid={portInvalid || undefined}
            aria-describedby={portInvalid ? id + "-port-error" : undefined}
            onChange={(event) => {
              const port = event.currentTarget.value;
              setFields((current) => ({ ...current, port }));
            }}
          />
          {portInvalid ? (
            <p
              id={id + "-port-error"}
              role="alert"
              className="text-sm text-destructive"
            >
              {t("tcpConnection.invalidPort")}
            </p>
          ) : null}
        </div>
      </div>
      {listening ? (
        <p className="text-sm text-muted-foreground">
          {t("tcpConnection.listenerHelp")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive wrap-anywhere">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={opening} className="justify-self-end">
        {button}
      </Button>
    </form>
  );
}
