import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  OpenParams,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { tcpHostPattern } from "../../../packages/plugin-sdk/examples/reference-transport/tcp-endpoint";

export type Rfc2217SerialConfiguration = Pick<
  SerialConfiguration,
  "baudRate" | "dataBits" | "parity" | "stopBits" | "flowControl"
>;

const hostStopBits = { "1": "one", "1.5": "onePointFive", "2": "two" } as const;
const hostFlowControl = {
  none: "none",
  software: "xonXoff",
  hardware: "rtsCts",
} as const;

const transportStopBits = { one: "1", onePointFive: "1.5", two: "2" } as const;
const transportFlowControl = {
  dsrDtr: "",
  none: "none",
  xonXoff: "software",
  rtsCts: "hardware",
} as const;

type LineSetting = "keep" | "set" | "clear";
type Rfc2217Draft = {
  host: string;
  port: string;
  baudRate: string;
  dataBits: "5" | "6" | "7" | "8";
  parity: "none" | "odd" | "even" | "mark" | "space";
  stopBits: "1" | "1.5" | "2";
  flowControl: "none" | "software" | "hardware" | "";
  dtr: LineSetting;
  rts: LineSetting;
};

const initial: Rfc2217Draft = {
  host: "",
  port: "",
  baudRate: "115200",
  dataBits: "8",
  parity: "none",
  stopBits: "1",
  flowControl: "none",
  dtr: "keep",
  rts: "keep",
};

function positiveInteger(input: string, max: number) {
  const value = Number(input);
  return /^\d+$/.test(input) && value > 0 && value <= max;
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      {children}
      {error && (
        <p id={id + "-error"} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function Rfc2217ConnectionParameters({
  initialConfiguration,
  opening,
  error,
  onSubmit,
}: {
  initialConfiguration?: Rfc2217SerialConfiguration;
  opening: boolean;
  error?: string;
  onSubmit: (
    params: NonNullable<OpenParams["transportParams"]>,
    configuration: Rfc2217SerialConfiguration,
  ) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const addressInput = useRef<HTMLInputElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const baudInput = useRef<HTMLInputElement>(null);
  const stopInput = useRef<HTMLButtonElement>(null);
  const flowInput = useRef<HTMLButtonElement>(null);
  const lineSettings = useRef<HTMLDetailsElement>(null);
  const [baseline] = useState<Rfc2217Draft>(() =>
    initialConfiguration
      ? {
          ...initial,
          baudRate: initialConfiguration.baudRate,
          dataBits: initialConfiguration.dataBits,
          parity: initialConfiguration.parity,
          stopBits: transportStopBits[initialConfiguration.stopBits],
          flowControl: transportFlowControl[initialConfiguration.flowControl],
        }
      : initial,
  );
  const [draft, setDraft] = useState(baseline);
  const [attempted, setAttempted] = useState(false);
  const host = draft.host.trim();
  const hostValid = tcpHostPattern.test(host);
  const portValid = positiveInteger(draft.port, 65_535);
  const baudValid = positiveInteger(draft.baudRate, 0xffff_ffff);
  const stopValid = draft.stopBits !== "1.5" || draft.dataBits === "5";
  const hardwareFlow = draft.flowControl === "hardware";
  const flowOptions = [
    { value: "none", label: t("rfc2217Connection.noFlowControl") },
    { value: "software", label: t("workbench.tools.xonXoff") },
    { value: "hardware", label: t("workbench.tools.rtsCts") },
  ] as const;
  const lineOptions = [
    { value: "keep", label: t("rfc2217Connection.keep") },
    { value: "set", label: t("rfc2217Connection.set") },
    { value: "clear", label: t("rfc2217Connection.clear") },
  ] as const;
  const flowLabel = flowOptions.find(
    (option) => option.value === draft.flowControl,
  )?.label;
  const lineSummary =
    draft.dataBits + draft.parity.charAt(0).toUpperCase() + draft.stopBits;

  useUnsavedWork({
    id,
    label: t("rfc2217Connection.title"),
    dirty: Object.keys(baseline).some((field) => {
      const key = field as keyof Rfc2217Draft;
      return draft[key] !== baseline[key];
    }),
    retainAfterUnmount: false,
    discard: () => {
      setDraft(baseline);
      setAttempted(false);
    },
  });

  function update<Key extends keyof Rfc2217Draft>(
    key: Key,
    value: Rfc2217Draft[Key],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (opening) return;
    setAttempted(true);
    if (!hostValid) addressInput.current?.focus();
    else if (!portValid) portInput.current?.focus();
    else if (!baudValid) baudInput.current?.focus();
    else if (!stopValid) {
      if (lineSettings.current) lineSettings.current.open = true;
      stopInput.current?.focus();
    } else if (!draft.flowControl) {
      if (lineSettings.current) lineSettings.current.open = true;
      flowInput.current?.focus();
    } else {
      onSubmit(
        {
          host,
          port: Number(draft.port),
          baudRate: Number(draft.baudRate),
          dataBits: Number(draft.dataBits),
          parity: draft.parity,
          stopBits: draft.stopBits,
          flowControl: draft.flowControl,
          ...(draft.dtr !== "keep" && { dtr: draft.dtr === "set" }),
          ...(!hardwareFlow &&
            draft.rts !== "keep" && { rts: draft.rts === "set" }),
        },
        {
          baudRate: String(Number(draft.baudRate)),
          dataBits: draft.dataBits,
          parity: draft.parity,
          stopBits: hostStopBits[draft.stopBits],
          flowControl: hostFlowControl[draft.flowControl],
        },
      );
    }
  }

  const connectionFields = [
    {
      key: "host",
      label: t("tcpConnection.remoteAddress"),
      valid: hostValid,
      message: t("tcpConnection.invalidRemoteAddress"),
      ref: addressInput,
    },
    {
      key: "port",
      label: t("tcpConnection.port"),
      valid: portValid,
      message: t("tcpConnection.invalidPort"),
      ref: portInput,
    },
    {
      key: "baudRate",
      label: t("rfc2217Connection.baudRate"),
      valid: baudValid,
      message: t("rfc2217Connection.invalidBaudRate"),
      ref: baudInput,
    },
  ] as const;

  return (
    <form
      className="workbench-rfc2217-connection"
      aria-busy={opening}
      onSubmit={submit}
    >
      <div className="workbench-rfc2217-fields grid content-start gap-3">
        <div className="grid min-w-0 items-start gap-3 @sm/workbench-tool:grid-cols-[minmax(0,1fr)_9rem]">
          {connectionFields.map(({ key, label, valid, message, ref }) => {
            const fieldId = id + "-" + key;
            const invalid = attempted && !valid;
            return (
              <Field
                key={key}
                id={fieldId}
                label={label}
                error={invalid ? message : undefined}
              >
                <Input
                  id={fieldId}
                  ref={ref}
                  className="w-full font-mono tabular-nums"
                  inputMode={key === "host" ? undefined : "numeric"}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft[key]}
                  readOnly={opening}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? fieldId + "-error" : undefined}
                  onChange={(event) => update(key, event.currentTarget.value)}
                />
              </Field>
            );
          })}
        </div>

        <details
          ref={lineSettings}
          className="min-w-0 rounded-none border-x-0 border-b-0"
        >
          <summary className="cursor-pointer rounded-none px-0 py-2.5 text-sm">
            {t("rfc2217Connection.lineSettings")}
            <span className="ms-2 text-muted-foreground">
              {lineSummary} ·{" "}
              {flowLabel ?? t("rfc2217Connection.chooseFlowControl")}
            </span>
          </summary>
          <div className="grid min-w-0 items-start gap-3 pt-2.5 @sm/workbench-tool:grid-cols-3">
            <Field id={id + "-dataBits"} label={t("workbench.tools.dataBits")}>
              <OptionsSelect
                id={id + "-dataBits"}
                value={draft.dataBits}
                options={(["5", "6", "7", "8"] as const).map((value) => ({
                  value,
                  label: value,
                }))}
                className="w-full"
                disabled={opening}
                onValueChange={(value) => update("dataBits", value)}
              />
            </Field>
            <Field id={id + "-parity"} label={t("workbench.tools.parity")}>
              <OptionsSelect
                id={id + "-parity"}
                value={draft.parity}
                options={(
                  ["none", "odd", "even", "mark", "space"] as const
                ).map((value) => ({
                  value,
                  label: t(`workbench.tools.${value}`),
                }))}
                className="w-full"
                disabled={opening}
                onValueChange={(value) => update("parity", value)}
              />
            </Field>
            <Field
              id={id + "-stopBits"}
              label={t("workbench.tools.stopBits")}
              error={
                !stopValid ? t("rfc2217Connection.invalidStopBits") : undefined
              }
            >
              <OptionsSelect
                id={id + "-stopBits"}
                value={draft.stopBits}
                triggerRef={stopInput}
                options={(["1", "1.5", "2"] as const).map((value) => ({
                  value,
                  label: value,
                }))}
                aria-invalid={!stopValid || undefined}
                aria-describedby={
                  !stopValid ? id + "-stopBits-error" : undefined
                }
                className="w-full"
                disabled={opening}
                onValueChange={(value) => update("stopBits", value)}
              />
            </Field>
            <Field
              id={id + "-flowControl"}
              label={t("workbench.tools.flowControl")}
              error={
                draft.flowControl
                  ? undefined
                  : t("rfc2217Connection.chooseFlowControl")
              }
            >
              <OptionsSelect
                id={id + "-flowControl"}
                value={draft.flowControl}
                options={flowOptions}
                triggerRef={flowInput}
                aria-invalid={!draft.flowControl}
                aria-describedby={
                  draft.flowControl ? undefined : id + "-flowControl-error"
                }
                className="w-full"
                disabled={opening}
                onValueChange={(value) => update("flowControl", value)}
              />
            </Field>
            <Field id={id + "-dtr"} label="DTR">
              <OptionsSelect
                id={id + "-dtr"}
                value={draft.dtr}
                options={lineOptions}
                className="w-full"
                disabled={opening}
                onValueChange={(value) => update("dtr", value)}
              />
            </Field>
            <Field id={id + "-rts"} label="RTS">
              <OptionsSelect
                id={id + "-rts"}
                value={hardwareFlow ? "keep" : draft.rts}
                options={lineOptions}
                aria-describedby={
                  hardwareFlow ? id + "-rts-managed" : undefined
                }
                className="w-full"
                disabled={opening || hardwareFlow}
                onValueChange={(value) => update("rts", value)}
              />
              {hardwareFlow && (
                <p
                  className="text-sm text-muted-foreground"
                  id={id + "-rts-managed"}
                >
                  {t("rfc2217Connection.managedRts")}
                </p>
              )}
            </Field>
          </div>
        </details>
      </div>

      <div className="grid min-w-0 gap-2">
        {error && (
          <p role="alert" className="text-sm text-destructive wrap-anywhere">
            {error}
          </p>
        )}
        <div className="workbench-tool-footer flex-wrap">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={opening}>
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button type="submit" disabled={opening}>
            {t(
              opening
                ? "rfc2217Connection.negotiating"
                : "tcpConnection.connect",
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
