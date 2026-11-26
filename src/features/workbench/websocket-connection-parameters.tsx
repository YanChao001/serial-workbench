import { useId, useState, type FormEvent } from "react";
import type { OpenParams } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  websocketEndpoint,
  type WebsocketRole,
  type WebsocketSendType,
} from "../../../packages/plugin-sdk/examples/reference-websocket/endpoint";

const initial = {
  role: "client" as WebsocketRole,
  sendType: "binary" as WebsocketSendType,
  url: "",
  bindAddress: "127.0.0.1",
  port: "",
  path: "/device",
  browserOrigin: "",
};
type Field = Exclude<keyof typeof initial, "role" | "sendType">;

export function WebsocketConnectionParameters({
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
  const [fields, setFields] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState<string>();
  const { role, sendType } = fields;
  const listening = role === "server";
  const common = { role, sendType };
  const browserOrigin = fields.browserOrigin.trim();
  const endpoint = websocketEndpoint(
    listening
      ? {
          ...common,
          bindAddress: fields.bindAddress.trim(),
          port: /^\d{1,5}$/.test(fields.port.trim())
            ? Number(fields.port)
            : Number.NaN,
          path: fields.path.trim(),
          ...(browserOrigin ? { browserOrigin } : {}),
        }
      : { ...common, url: fields.url.trim() },
  );
  const invalid = "error" in endpoint ? endpoint.error : undefined;
  const signature = JSON.stringify(endpoint);
  const hostError =
    !opening && !invalid && submitted === signature ? error : undefined;

  useUnsavedWork({
    id,
    label: t("websocketConnection.title"),
    dirty: Object.keys(initial).some((name) => {
      const field = name as keyof typeof initial;
      return fields[field] !== initial[field];
    }),
    retainAfterUnmount: false,
    discard: () => {
      setFields(initial);
      setAttempted(false);
      setSubmitted(undefined);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (opening) return;
    setAttempted(true);
    if (!endpoint.role) {
      const input = event.currentTarget.elements.namedItem(invalid ?? "");
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setSubmitted(signature);
    if (endpoint.role === "server") {
      const { role, sendType, bindAddress, port, path, browserOrigin } =
        endpoint;
      onSubmit({
        role,
        sendType,
        bindAddress,
        port,
        path,
        ...(browserOrigin ? { browserOrigin } : {}),
      });
    } else {
      onSubmit({
        role: endpoint.role,
        sendType: endpoint.sendType,
        url: endpoint.url,
      });
    }
  }

  function field(
    name: Field,
    label: string,
    validation: string,
    hint?: string,
    placeholder?: string,
  ) {
    const inputId = id + "-" + name;
    const failed = attempted && invalid === name;
    const messageId = inputId + "-message";
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
          inputMode={name === "port" ? "numeric" : undefined}
          placeholder={placeholder}
          value={fields[name]}
          readOnly={opening}
          aria-invalid={failed || undefined}
          aria-describedby={failed || hint ? messageId : undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFields((current) => ({ ...current, [name]: value }));
          }}
        />
        {failed ? (
          <p
            id={messageId}
            role="alert"
            className="text-sm text-destructive wrap-anywhere"
          >
            {validation}
          </p>
        ) : hint ? (
          <p id={messageId} className="text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="grid min-w-0 gap-3" aria-busy={opening} onSubmit={submit}>
      <div className="grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-role"}>
            {t("tcpConnection.role")}
          </label>
          <OptionsSelect<WebsocketRole>
            id={id + "-role"}
            className="w-full"
            value={role}
            disabled={opening}
            options={[
              { value: "client", label: t("websocketConnection.client") },
              { value: "server", label: t("websocketConnection.server") },
            ]}
            onValueChange={(value) => {
              setFields((current) => ({ ...current, role: value }));
              setAttempted(false);
            }}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label className="text-sm" htmlFor={id + "-send-type"}>
            {t("websocketConnection.sendType")}
          </label>
          <OptionsSelect<WebsocketSendType>
            id={id + "-send-type"}
            className="w-full"
            value={sendType}
            disabled={opening}
            options={[
              { value: "binary", label: t("websocketConnection.binary") },
              { value: "text", label: t("websocketConnection.text") },
            ]}
            onValueChange={(value) =>
              setFields((current) => ({ ...current, sendType: value }))
            }
          />
        </div>
      </div>
      {listening ? (
        <fieldset className="workbench-connection-fields grid min-w-0 gap-3">
          <legend className="sr-only">
            {t("websocketConnection.listenerSettings")}
          </legend>
          <div className="grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-[minmax(0,1fr)_9rem]">
            {field(
              "bindAddress",
              t("tcpConnection.bindAddress"),
              t("tcpConnection.invalidBindAddress"),
            )}
            {field(
              "port",
              t("tcpConnection.port"),
              t("tcpConnection.invalidPort"),
            )}
          </div>
          {field(
            "path",
            t("websocketConnection.path"),
            t("websocketConnection.invalidPath"),
          )}
          {field(
            "browserOrigin",
            t("websocketConnection.browserOrigin"),
            t("websocketConnection.invalidOrigin"),
            t("websocketConnection.originHelp"),
            "http://localhost:5173",
          )}
        </fieldset>
      ) : (
        field(
          "url",
          t("websocketConnection.url"),
          t("websocketConnection.invalidUrl"),
          undefined,
          "ws://127.0.0.1:8080/device",
        )
      )}
      {hostError ? (
        <p role="alert" className="text-sm text-destructive wrap-anywhere">
          {hostError}
        </p>
      ) : null}
      <Button type="submit" disabled={opening} className="justify-self-end">
        {listening
          ? t(opening ? "tcpConnection.starting" : "tcpConnection.listen")
          : t(opening ? "tcpConnection.connecting" : "tcpConnection.connect")}
      </Button>
    </form>
  );
}
