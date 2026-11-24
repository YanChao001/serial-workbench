import { useId, useState, type FormEvent } from "react";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { ModbusUnitRouting } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange";
import {
  encodeModbusFrame,
  modbusFrameLimits,
  type ModbusTransport,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import {
  modbusServerLimits,
  simulateModbusServer,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-server";

type Draft = {
  transport: ModbusTransport;
  routing: ModbusUnitRouting;
  definition: string;
  request: string;
};
type Model = ReturnType<typeof simulateModbusServer>["model"];
type Result = ReturnType<typeof simulateModbusServer>;
const initial: Draft = {
  transport: "rtu",
  routing: "gateway",
  definition: "",
  request: "",
};

function requestSample(input: string) {
  try {
    return parseHex(input);
  } catch {
    throw new ProtocolFieldError("request.hex", "Expected hexadecimal request");
  }
}

export default function ModbusServerTool() {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [model, setModel] = useState<Model>();
  const [result, setResult] = useState<Result>();
  const [issue, setIssue] = useState<string>();
  useUnsavedWork({
    id,
    label: t("workbench.modbusServer.title"),
    dirty: draft.definition !== "" || draft.request !== "",
    retainAfterUnmount: false,
    discard: () => {
      change(initial);
      setModel(undefined);
    },
  });

  function change(patch: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setIssue(undefined);
    setResult(undefined);
    if (patch.definition !== undefined) setModel(undefined);
  }

  function example() {
    const unitId = 1;
    const definition = {
      unitId,
      tables: {
        coils: [{ start: 0, values: [true, false, true, false] }],
        discreteInputs: [{ start: 0, values: [false, true] }],
        holdingRegisters: [{ start: 0, values: [4660, 0, 22136] }],
        inputRegisters: [{ start: 100, values: [25, 50] }],
      },
    };
    const packet = {
      unitId,
      ...(draft.transport === "tcp" ? { transactionId: 1 } : {}),
      pdu: { functionCode: 6, address: 1, value: 258 },
    };
    change({
      definition: JSON.stringify(definition, null, 2),
      request: formatHex(encodeModbusFrame(draft.transport, "request", packet)),
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(undefined);
    setIssue(undefined);
    try {
      const definition: unknown = model ?? JSON.parse(draft.definition);
      const next = simulateModbusServer(
        draft.transport,
        requestSample(draft.request),
        definition,
        draft.routing,
      );
      setModel(next.model);
      setResult(next);
    } catch (error) {
      if (error instanceof ProtocolFieldError) setIssue(error.path);
      else if (error instanceof SyntaxError) setIssue("model.json");
      else throw error;
    }
  }

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.modbusServer.title")}
      </summary>
      <form className="space-y-3" onSubmit={submit}>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-transport"}>
            {t("workbench.modbus.transport")}
            <OptionsSelect<ModbusTransport>
              id={id + "-transport"}
              value={draft.transport}
              options={[
                { value: "rtu", label: "RTU" },
                { value: "ascii", label: "ASCII" },
                { value: "tcp", label: "TCP" },
              ]}
              onValueChange={(transport) => change({ transport })}
            />
          </label>
          {draft.transport === "tcp" ? (
            <label className="grid gap-1.5 text-sm" htmlFor={id + "-routing"}>
              {t("workbench.modbus.routing")}
              <OptionsSelect<ModbusUnitRouting>
                id={id + "-routing"}
                value={draft.routing}
                options={[
                  { value: "gateway", label: t("workbench.modbus.gateway") },
                  { value: "direct", label: t("workbench.modbus.direct") },
                ]}
                onValueChange={(routing) => change({ routing })}
              />
            </label>
          ) : null}
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-model"}>
          {t("workbench.modbusServer.model")}
          <Textarea
            id={id + "-model"}
            value={draft.definition}
            maxLength={modbusServerLimits.definition}
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
            aria-invalid={issue?.startsWith("model") ?? false}
            aria-describedby={
              id + (issue?.startsWith("model") ? "-error" : "-help")
            }
            onChange={(event) =>
              change({ definition: event.currentTarget.value })
            }
          />
        </label>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-request"}>
          {t("workbench.modbus.requestFrame")}
          <Textarea
            id={id + "-request"}
            value={draft.request}
            maxLength={modbusFrameLimits.ascii * 3}
            className="min-h-16 font-mono text-xs"
            spellCheck={false}
            aria-invalid={issue?.startsWith("request") ?? false}
            aria-describedby={
              id + (issue?.startsWith("request") ? "-error" : "-help")
            }
            onChange={(event) => change({ request: event.currentTarget.value })}
          />
        </label>
        <p id={id + "-help"} className="text-xs text-muted-foreground">
          {t("workbench.modbusServer.help")}
        </p>
        {issue ? (
          <p
            id={id + "-error"}
            className="text-sm text-destructive"
            role="alert"
          >
            {t("workbench.modbusServer.invalid", { path: issue })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={!draft.request.trim() || !draft.definition.trim()}
          >
            {t("workbench.modbusServer.run")}
          </Button>
          <Button type="button" variant="outline" onClick={example}>
            {t("workbench.modbusServer.example")}
          </Button>
          {model ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setModel(undefined);
                setResult(undefined);
                setIssue(undefined);
              }}
            >
              {t("workbench.modbusServer.reset")}
            </Button>
          ) : null}
        </div>
      </form>
      {result ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {result.status === "exception"
              ? t("workbench.modbusServer.exception", {
                  code: result.exceptionCode,
                })
              : result.status === "discarded"
                ? t("workbench.modbusServer.discarded", { path: result.path })
                : t(`workbench.modbusServer.result.${result.status}`)}
          </p>
          {"responseBytes" in result ? (
            <output
              aria-label={t("workbench.modbus.responseFrame")}
              className="block wrap-anywhere rounded-md border p-2 font-mono text-xs"
            >
              {formatHex(result.responseBytes)}
            </output>
          ) : null}
        </div>
      ) : null}
      {model ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t("workbench.modbusServer.current")}
          </summary>
          <pre className="mt-2 max-h-52 overflow-auto rounded-md border p-2 text-xs">
            {JSON.stringify(model, null, 2)}
          </pre>
        </details>
      ) : null}
    </details>
  );
}
