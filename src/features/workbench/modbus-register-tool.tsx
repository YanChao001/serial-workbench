import { useEffect, useId, useRef, useState } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorText } from "@/lib/native-error";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  decodeRegisterValue,
  initialRegisterDraft,
  registerFormats,
  registerOrders,
  registerRange,
  registerRequest,
  registerResult,
  selectRegisterWrite,
  type RegisterDraft,
  type RegisterWrite,
} from "./modbus-register-model";
import {
  runModbusTransaction,
  type ModbusTransactionAccess,
} from "./modbus-transaction";
import { useToolAction } from "./transfer-capture-actions";

const transports = ["rtu", "ascii", "tcp"] as const;

function waitForPoll(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    function stop() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

function wordText(word: number) {
  return word.toString(16).padStart(4, "0").toUpperCase();
}

function valueText(value: number) {
  return Object.is(value, -0) ? "-0" : String(value);
}

export default function ModbusRegisterTool({
  access,
}: {
  access: ModbusTransactionAccess;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initialRegisterDraft);
  const [writeAddress, setWriteAddress] = useState<string>();
  const [writeValue, setWriteValue] = useState("");
  const [confirmed, setConfirmed] = useState<number[]>();
  const [last, setLast] = useState<{
    result: ReturnType<typeof registerResult>;
    write: boolean;
  }>();
  const [mode, setMode] = useState<"single" | "watch" | "stopping">();
  const monitor = useRef<AbortController>(undefined);
  const nextTransaction = useRef<number>(undefined);
  const latestAccess = useRef(access);
  latestAccess.current = access;
  const action = useToolAction((reason) => nativeErrorText(reason, t));
  const range = registerRange(draft);
  const targetAddress = writeAddress ?? draft.address;
  const write = selectRegisterWrite(draft, range, targetAddress, writeValue);
  useUnsavedWork({
    id,
    label: t("workbench.registers.title"),
    dirty:
      writeAddress !== undefined ||
      writeValue !== "" ||
      JSON.stringify(draft) !== JSON.stringify(initialRegisterDraft),
    retainAfterUnmount: false,
    discard: () => {
      monitor.current?.abort();
      change(initialRegisterDraft);
    },
  });
  useEffect(() => {
    if (!access.available) monitor.current?.abort();
  }, [access.available]);

  function change(patch: Partial<RegisterDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setWriteAddress(undefined);
    setWriteValue("");
    setConfirmed(undefined);
    setLast(undefined);
  }

  function stopWatching() {
    if (!monitor.current || monitor.current.signal.aborted) return;
    monitor.current.abort();
    setMode("stopping");
  }

  function run(watch: boolean, write?: RegisterWrite) {
    if (
      !range ||
      action.busy ||
      !access.available ||
      (watch && range.interval === undefined)
    )
      return;
    const polling = watch ? new AbortController() : undefined;
    monitor.current = polling;
    setMode(watch ? "watch" : "single");
    setLast(undefined);
    if (write) setConfirmed(undefined);
    void action.run(async (signal) => {
      const waiting = polling
        ? AbortSignal.any([polling.signal, signal])
        : signal;
      try {
        do {
          const current = latestAccess.current;
          if (!current.available || waiting.aborted) return;
          const transactionId =
            nextTransaction.current ??
            crypto.getRandomValues(new Uint16Array(1))[0]!;
          nextTransaction.current = (transactionId + 1) & 0xffff;
          const request = registerRequest(draft, range, transactionId, write);
          const { attempts } = await runModbusTransaction(
            current,
            {
              transport: draft.transport,
              requestBase64: bytesToBase64(request),
              ...(draft.transport === "tcp" && { unitRouting: draft.routing }),
              responseTimeoutMs: range.timeout,
              lateResponseWaitMs: 100,
              retryLimit: 0,
            },
            signal,
          );
          const [attempt] = attempts;
          if (
            attempts.length !== 1 ||
            !attempt ||
            (draft.transport === "tcp" &&
              attempt.transactionId !== transactionId)
          )
            throw new ContractValidationError(
              "Modbus register operation requires one attempt",
            );
          const result = registerResult(draft, request, attempt, !!write);
          signal.throwIfAborted();
          setLast({ result, write: !!write });
          if (result.words) setConfirmed(result.words);
          if (
            attempt.outcome !== "matched" ||
            !polling ||
            range.interval === undefined
          )
            return;
        } while (await waitForPoll(range.interval, waiting));
      } finally {
        if (monitor.current === polling) monitor.current = undefined;
        if (!signal.aborted) setMode(undefined);
      }
    });
  }

  const orders = registerOrders(draft.format);
  const writeFunction = orders.length === 2 ? 6 : 16;
  const numberInputs = [
    ["unit", "workbench.registers.unit"],
    ["address", "workbench.registers.address"],
    ["count", "workbench.registers.count"],
    ["timeout", "workbench.timeline.timeout"],
    ["interval", "workbench.registers.interval"],
  ] as const;
  return (
    <details
      className="rounded-md border border-border bg-card px-3 py-2"
      onToggle={(event) => {
        if (!event.currentTarget.open) stopWatching();
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.registers.title")}
      </summary>
      {!access.available ? (
        <p className="mt-2 text-sm">{t("workbench.registers.unavailable")}</p>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <fieldset
            disabled={action.busy}
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            <label className="grid gap-1">
              {t("workbench.modbus.transport")}
              <OptionsSelect
                label={t("workbench.modbus.transport")}
                value={draft.transport}
                options={transports.map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
                onValueChange={(transport) => change({ transport })}
              />
            </label>
            {draft.transport === "tcp" ? (
              <label className="grid gap-1">
                {t("workbench.modbus.routing")}
                <OptionsSelect
                  label={t("workbench.modbus.routing")}
                  value={draft.routing}
                  options={[
                    { value: "gateway", label: t("workbench.modbus.gateway") },
                    { value: "direct", label: t("workbench.modbus.direct") },
                  ]}
                  onValueChange={(routing) => change({ routing })}
                />
              </label>
            ) : null}
            <label className="grid gap-1">
              {t("workbench.registers.table")}
              <OptionsSelect
                label={t("workbench.registers.table")}
                value={draft.table}
                options={[
                  { value: "holding", label: t("workbench.registers.holding") },
                  { value: "input", label: t("workbench.registers.input") },
                ]}
                onValueChange={(table) => change({ table })}
              />
            </label>
            <label className="grid gap-1">
              {t("workbench.registers.base")}
              <OptionsSelect
                label={t("workbench.registers.base")}
                value={draft.base}
                options={[
                  { value: "0", label: t("workbench.registers.zero") },
                  { value: "1", label: t("workbench.registers.one") },
                ]}
                onValueChange={(base) =>
                  change({
                    base,
                    address: String((range?.address ?? 0) + Number(base)),
                  })
                }
              />
            </label>
            <label className="grid gap-1">
              {t("workbench.registers.format")}
              <OptionsSelect
                label={t("workbench.registers.format")}
                value={draft.format}
                options={registerFormats.map((value) => ({
                  value,
                  label: t(`workbench.registers.format.${value}`),
                }))}
                onValueChange={(format) =>
                  change({ format, order: registerOrders(format)[0] })
                }
              />
            </label>
            <label className="grid gap-1">
              {t("workbench.registers.order")}
              <OptionsSelect
                label={t("workbench.registers.order")}
                value={draft.order}
                options={orders.map((value) => ({ value, label: value }))}
                onValueChange={(order) => change({ order })}
              />
            </label>
            {numberInputs.map(([key, label]) => (
              <label key={key} className="grid gap-1">
                {t(label)}
                <Input
                  type="number"
                  step={1}
                  min={0}
                  value={draft[key]}
                  onChange={(event) =>
                    change({ [key]: event.currentTarget.value })
                  }
                />
              </label>
            ))}
          </fieldset>
          {range ? (
            <p className="text-muted-foreground">
              {t("workbench.registers.range", {
                address: range.address,
                count: range.quantity,
              })}
            </p>
          ) : (
            <p role="status" className="text-muted-foreground">
              {t("workbench.registers.invalid")}
            </p>
          )}
          {range && range.interval === undefined ? (
            <p className="text-muted-foreground">
              {t("workbench.registers.invalidInterval")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!range || action.busy}
              onClick={() => run(false)}
            >
              {t("workbench.registers.read", {
                code: draft.table === "holding" ? "03" : "04",
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!range || range.interval === undefined || action.busy}
              onClick={() => run(true)}
            >
              {t("workbench.registers.watch")}
            </Button>
            {mode === "watch" || mode === "stopping" ? (
              <Button
                type="button"
                variant="outline"
                disabled={mode === "stopping"}
                onClick={stopWatching}
              >
                {t("workbench.registers.stop")}
              </Button>
            ) : null}
          </div>
          {draft.table === "holding" ? (
            <fieldset
              disabled={action.busy}
              className="space-y-2 border-t pt-2"
            >
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  {t("workbench.registers.writeAddress")}
                  <Input
                    type="number"
                    step={1}
                    min={0}
                    value={targetAddress}
                    onChange={(event) =>
                      setWriteAddress(event.currentTarget.value)
                    }
                  />
                </label>
                <label className="grid gap-1">
                  {t("workbench.registers.writeValue")}
                  <Input
                    value={writeValue}
                    onChange={(event) =>
                      setWriteValue(event.currentTarget.value)
                    }
                  />
                </label>
              </div>
              {write && range ? (
                <p className="text-muted-foreground">
                  {t("workbench.registers.writeWords", {
                    address: range.address + write.index * range.width,
                  })}{" "}
                  <code>{write.words.map(wordText).join(" ")}</code>
                </p>
              ) : writeValue ? (
                <p className="text-muted-foreground">
                  {t("workbench.registers.invalidWrite")}
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!write}
                onClick={() => write && run(false, write)}
              >
                {t("workbench.registers.write", {
                  code: String(writeFunction).padStart(2, "0"),
                })}
              </Button>
            </fieldset>
          ) : null}
          {mode === "watch" ? (
            <p role="status">{t("workbench.registers.watching")}</p>
          ) : null}
          {mode === "stopping" ? (
            <p role="status">{t("workbench.registers.stopping")}</p>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-destructive">
              {action.error}
            </p>
          ) : null}
          {last ? (
            <p
              role={
                mode === "watch" && last.result.attempt.outcome === "matched"
                  ? undefined
                  : "status"
              }
            >
              {last.write && last.result.attempt.outcome === "matched"
                ? t("workbench.registers.writeConfirmed")
                : t(
                    `workbench.timeline.outcome.${last.result.attempt.outcome}`,
                  )}
              {last.result.attempt.response?.exceptionCode !== undefined ? (
                <>
                  {" "}
                  · {t("workbench.timeline.exception")}{" "}
                  <code>{last.result.attempt.response.exceptionCode}</code>
                </>
              ) : null}
              {last.result.attempt.response ? (
                <>
                  {" "}
                  ·{" "}
                  {last.result.attempt.response.late
                    ? t("workbench.timeline.late")
                    : "RX"}{" "}
                  <code>
                    [{String(last.result.attempt.response.byteStart)},{" "}
                    {String(last.result.attempt.response.byteEnd)})
                  </code>
                </>
              ) : null}
            </p>
          ) : null}
          {range && confirmed ? (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-left">
                <caption className="pb-1 text-left">
                  {t("workbench.registers.lastRead")}
                </caption>
                <thead>
                  <tr className="border-b">
                    <th scope="col">{t("workbench.registers.address")}</th>
                    <th scope="col">{t("workbench.registers.words")}</th>
                    <th scope="col">{t("workbench.registers.value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: range.count }, (_, index) => {
                    const offset = index * range.width;
                    const words = confirmed.slice(offset, offset + range.width);
                    const address = range.address + range.base + offset;
                    return (
                      <tr key={address} className="border-b font-mono">
                        <th scope="row">{address}</th>
                        <td>{words.map(wordText).join(" ")}</td>
                        <td>{valueText(decodeRegisterValue(words, draft))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </details>
  );
}
