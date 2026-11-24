import { useId, useState, type FormEvent } from "react";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  compareModbusExchange,
  type ModbusExchange,
  type ModbusUnitRouting,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange";
import {
  decodeModbusFrame,
  encodeModbusFrame,
  modbusFrameLimits,
  type ModbusTransport,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import type { ModbusDirection } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-pdu";

type Mode = "decode" | "encode" | "compare";
type Draft = {
  mode: Mode;
  transport: ModbusTransport;
  direction: ModbusDirection;
  unitRouting: ModbusUnitRouting;
  inputs: Record<Mode | "response", string>;
};
type Result =
  | { kind: "decoded"; data: ReturnType<typeof decodeModbusFrame> }
  | { kind: "encoded"; hex: string; ascii?: string }
  | { kind: "compared"; data: ModbusExchange };
const initialDraft: Draft = {
  mode: "decode",
  transport: "rtu",
  direction: "request",
  unitRouting: "gateway",
  inputs: { decode: "", encode: "", compare: "", response: "" },
};

function sampleHex(input: string, path: string) {
  try {
    return parseHex(input);
  } catch {
    throw new ProtocolFieldError(path, "Expected hexadecimal sample");
  }
}

export default function ModbusFrameTool() {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initialDraft);
  const input = draft.inputs[draft.mode];
  const [result, setResult] = useState<Result>();
  const [issue, setIssue] = useState<string>();
  useUnsavedWork({
    id,
    label: t("workbench.modbus.title"),
    dirty: Object.values(draft.inputs).some((value) => value.trim() !== ""),
    discard: () => change(initialDraft),
    retainAfterUnmount: false,
  });

  function change(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setResult(undefined);
    setIssue(undefined);
  }

  function changeInput(mode: Mode, input: string) {
    change({ mode, inputs: { ...draft.inputs, [mode]: input } });
  }

  function showExample() {
    const header = {
      unitId: 1,
      ...(draft.transport === "tcp" ? { transactionId: 1 } : {}),
    };
    const request = {
      ...header,
      pdu: { functionCode: 3, address: 0, quantity: 2 },
    };
    const response = {
      ...header,
      pdu: { functionCode: 3, values: [0x1234, 0x5678] },
    };
    if (draft.mode === "compare") {
      change({
        inputs: {
          ...draft.inputs,
          compare: formatHex(
            encodeModbusFrame(draft.transport, "request", request),
          ),
          response: formatHex(
            encodeModbusFrame(draft.transport, "response", response),
          ),
        },
      });
      return;
    }
    const packet = draft.direction === "request" ? request : response;
    changeInput(
      draft.mode,
      draft.mode === "decode"
        ? formatHex(encodeModbusFrame(draft.transport, draft.direction, packet))
        : JSON.stringify(packet, null, 2),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(undefined);
    setIssue(undefined);
    try {
      if (draft.mode === "compare") {
        const response = draft.inputs.response;
        const data = compareModbusExchange(
          draft.transport,
          sampleHex(input, "request.frame.hex"),
          response.trim()
            ? sampleHex(response, "response.frame.hex")
            : undefined,
          draft.unitRouting,
        );
        setResult({ kind: "compared", data });
      } else if (draft.mode === "decode") {
        const data = decodeModbusFrame(
          draft.transport,
          draft.direction,
          sampleHex(input, "frame.hex"),
        );
        setResult({ kind: "decoded", data });
      } else {
        const packet: unknown = JSON.parse(input);
        const bytes = encodeModbusFrame(
          draft.transport,
          draft.direction,
          packet,
        );
        setResult({
          kind: "encoded",
          hex: formatHex(bytes),
          ascii:
            draft.transport === "ascii"
              ? JSON.stringify(new TextDecoder().decode(bytes))
              : undefined,
        });
      }
    } catch (error) {
      if (error instanceof ProtocolFieldError) setIssue(error.path);
      else if (error instanceof SyntaxError && draft.mode === "encode")
        setIssue("packet.json");
      else throw error;
    }
  }

  const comparing = draft.mode === "compare";
  const responseIssue = issue?.startsWith("response.") ?? false;
  const inputIssue = Boolean(issue) && !responseIssue;
  const inputLabel =
    draft.mode === "encode"
      ? "workbench.modbus.packet"
      : comparing
        ? "workbench.modbus.requestFrame"
        : "workbench.modbus.frame";
  const submitLabel =
    draft.mode === "encode"
      ? "workbench.modbus.build"
      : comparing
        ? "workbench.modbus.compare"
        : "workbench.modbus.verify";

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.modbus.title")}
      </summary>
      <form className="space-y-3" onSubmit={submit}>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-mode"}>
            {t("workbench.modbus.mode")}
            <OptionsSelect<Mode>
              id={id + "-mode"}
              value={draft.mode}
              options={[
                { value: "decode", label: t("workbench.modbus.decode") },
                { value: "encode", label: t("workbench.modbus.encode") },
                { value: "compare", label: t("workbench.modbus.compare") },
              ]}
              onValueChange={(mode) => {
                if (mode !== draft.mode) change({ mode });
              }}
            />
          </label>
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
          {!comparing ? (
            <label className="grid gap-1.5 text-sm" htmlFor={id + "-direction"}>
              {t("workbench.modbus.direction")}
              <OptionsSelect<ModbusDirection>
                id={id + "-direction"}
                value={draft.direction}
                options={[
                  { value: "request", label: t("workbench.modbus.request") },
                  { value: "response", label: t("workbench.modbus.response") },
                ]}
                onValueChange={(direction) => change({ direction })}
              />
            </label>
          ) : draft.transport === "tcp" ? (
            <label className="grid gap-1.5 text-sm" htmlFor={id + "-routing"}>
              {t("workbench.modbus.routing")}
              <OptionsSelect<ModbusUnitRouting>
                id={id + "-routing"}
                value={draft.unitRouting}
                options={[
                  { value: "gateway", label: t("workbench.modbus.gateway") },
                  { value: "direct", label: t("workbench.modbus.direct") },
                ]}
                onValueChange={(unitRouting) => change({ unitRouting })}
              />
            </label>
          ) : null}
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-input"}>
          {t(inputLabel)}
          <Textarea
            id={id + "-input"}
            className="min-h-20 font-mono text-xs"
            value={input}
            maxLength={
              draft.mode === "encode" ? 24_576 : modbusFrameLimits.ascii * 3
            }
            spellCheck={false}
            aria-invalid={inputIssue}
            aria-describedby={id + (inputIssue ? "-error" : "-help")}
            onChange={(event) =>
              changeInput(draft.mode, event.currentTarget.value)
            }
          />
        </label>
        {comparing ? (
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-response"}>
            {t("workbench.modbus.responseFrame")}
            <Textarea
              id={id + "-response"}
              className="min-h-20 font-mono text-xs"
              value={draft.inputs.response}
              maxLength={modbusFrameLimits.ascii * 3}
              spellCheck={false}
              aria-invalid={responseIssue}
              aria-describedby={id + (responseIssue ? "-error" : "-help")}
              onChange={(event) =>
                change({
                  inputs: {
                    ...draft.inputs,
                    response: event.currentTarget.value,
                  },
                })
              }
            />
          </label>
        ) : null}
        <p id={id + "-help"} className="text-xs text-muted-foreground">
          {t(
            draft.mode === "encode"
              ? "workbench.modbus.packetHelp"
              : comparing
                ? "workbench.modbus.compareHelp"
                : "workbench.modbus.hexHelp",
          )}
        </p>
        {issue ? (
          <p
            id={id + "-error"}
            className="text-sm text-destructive"
            role="alert"
          >
            {t("workbench.modbus.invalid", { path: issue })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!input.trim()}>
            {t(submitLabel)}
          </Button>
          <Button type="button" variant="outline" onClick={showExample}>
            {t("workbench.modbus.example")}
          </Button>
        </div>
      </form>
      {result?.kind === "compared" ? (
        <p role="status" className="text-sm">
          {result.data.status === "mismatch"
            ? t(`workbench.modbus.mismatch.${result.data.reason}`)
            : result.data.status === "device-exception"
              ? t("workbench.modbus.deviceException", {
                  code: result.data.exceptionCode,
                })
              : t(`workbench.modbus.result.${result.data.status}`)}
        </p>
      ) : null}
      {result?.kind === "decoded" ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {t(
              result.data.broadcast
                ? "workbench.modbus.broadcast"
                : "workbench.modbus.verified",
            )}
          </p>
          <pre
            aria-label={t("workbench.modbus.packet")}
            className="max-h-52 overflow-auto rounded-md border p-2 text-xs"
          >
            {JSON.stringify(result.data.packet, null, 2)}
          </pre>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              changeInput("encode", JSON.stringify(result.data.packet, null, 2))
            }
          >
            {t("workbench.modbus.edit")}
          </Button>
        </div>
      ) : null}
      {result?.kind === "encoded" ? (
        <div className="space-y-2">
          <label htmlFor={id + "-hex"} className="text-sm">
            {t("workbench.modbus.generated")}
          </label>
          <output
            id={id + "-hex"}
            className="block wrap-anywhere rounded-md border p-2 font-mono text-xs"
          >
            {result.hex}
          </output>
          {result.ascii ? (
            <code className="block wrap-anywhere text-xs">{result.ascii}</code>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => changeInput("decode", result.hex)}
          >
            {t("workbench.modbus.verifyGenerated")}
          </Button>
        </div>
      ) : null}
    </details>
  );
}
