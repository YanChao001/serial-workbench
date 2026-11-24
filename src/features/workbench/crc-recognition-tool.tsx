import { useId, useRef, useState, type FormEvent } from "react";
import { parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { crcWidths } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/crc-catalogue";
import {
  maxCrcSampleBytes,
  maxCrcSamples,
  recognizeCrc,
  type CrcOrder,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/crc-recognition";

type Sample = { id: number; bytes: string; checksum: string };
type SampleField = "bytes" | "checksum";
const initialSample: Sample = { id: 0, bytes: "", checksum: "" };

function readHex(value: string, index: number, field: SampleField) {
  try {
    return parseHex(value);
  } catch {
    throw new ProtocolFieldError(`samples[${index}].${field}`, "Invalid HEX");
  }
}

function hex(value: number, width: number) {
  return (
    "0x" +
    value
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(width / 4), "0")
  );
}

export default function CrcRecognitionTool() {
  const { t } = useI18n();
  const id = useId();
  const nextSample = useRef(1);
  const [samples, setSamples] = useState<Sample[]>([initialSample]);
  const [width, setWidth] = useState("auto");
  const [order, setOrder] = useState<CrcOrder>("auto");
  const [result, setResult] = useState<ReturnType<typeof recognizeCrc>>();
  const [failure, setFailure] = useState<string>();
  const dirty =
    width !== "auto" ||
    order !== "auto" ||
    samples.length !== 1 ||
    samples.some((sample) => sample.bytes !== "" || sample.checksum !== "");
  useUnsavedWork({
    id,
    label: t("workbench.crc.title"),
    dirty,
    retainAfterUnmount: false,
    discard: () => {
      setSamples([initialSample]);
      setWidth("auto");
      setOrder("auto");
      clearResult();
    },
  });

  function clearResult() {
    setResult(undefined);
    setFailure(undefined);
  }

  function updateSample(key: number, field: SampleField, value: string) {
    setSamples((current) =>
      current.map((sample) =>
        sample.id === key ? { ...sample, [field]: value } : sample,
      ),
    );
    clearResult();
  }

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearResult();
    try {
      setResult(
        recognizeCrc(
          samples.map((sample, index) => ({
            bytes: readHex(sample.bytes, index, "bytes"),
            checksum: readHex(sample.checksum, index, "checksum"),
          })),
          { order, width: width === "auto" ? undefined : Number(width) },
        ),
      );
    } catch (error) {
      setFailure(error instanceof ProtocolFieldError ? error.path : "samples");
    }
  }

  const resultMessages = {
    matched: "workbench.crc.matched",
    "more-samples": "workbench.crc.moreSamples",
    "no-match": "workbench.crc.noMatch",
    contradictory: "workbench.crc.contradictory",
  } as const;

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.crc.title")}
      </summary>
      <form className="space-y-3" onSubmit={analyze}>
        <p className="text-xs text-muted-foreground">
          {t("workbench.crc.help")}
        </p>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-width"}>
            {t("workbench.crc.width")}
            <OptionsSelect
              id={id + "-width"}
              value={width}
              options={[
                { value: "auto", label: t("workbench.crc.auto") },
                ...crcWidths.map((bits) => ({
                  value: String(bits),
                  label: t("workbench.crc.bits", { bits }),
                })),
              ]}
              onValueChange={(value) => {
                setWidth(value);
                clearResult();
              }}
            />
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-order"}>
            {t("workbench.crc.order")}
            <OptionsSelect<CrcOrder>
              id={id + "-order"}
              value={order}
              options={[
                { value: "auto", label: t("workbench.crc.auto") },
                { value: "big", label: t("workbench.fields.bigEndian") },
                { value: "little", label: t("workbench.fields.littleEndian") },
              ]}
              onValueChange={(value) => {
                setOrder(value);
                clearResult();
              }}
            />
          </label>
        </div>
        {samples.map((sample, index) => {
          const group = id + "-" + sample.id;
          const samplePosition = `samples[${index}]`;
          const sampleLabel = t("workbench.crc.sample", { index: index + 1 });
          return (
            <fieldset
              key={sample.id}
              className="space-y-2 rounded-md border p-2"
            >
              <legend className="px-1 text-sm font-medium">
                {sampleLabel}
              </legend>
              <label
                className="grid gap-1.5 text-sm"
                htmlFor={group + "-bytes"}
              >
                {t("workbench.crc.bytes")}
                <Textarea
                  id={group + "-bytes"}
                  aria-invalid={failure === samplePosition + ".bytes"}
                  className="min-h-14 font-mono text-xs"
                  value={sample.bytes}
                  maxLength={maxCrcSampleBytes * 3}
                  spellCheck={false}
                  onChange={(event) =>
                    updateSample(sample.id, "bytes", event.currentTarget.value)
                  }
                />
              </label>
              <label
                className="grid gap-1.5 text-sm"
                htmlFor={group + "-checksum"}
              >
                {t("workbench.crc.checksum")}
                <Input
                  id={group + "-checksum"}
                  aria-invalid={failure === samplePosition + ".checksum"}
                  className="font-mono"
                  value={sample.checksum}
                  maxLength={12}
                  spellCheck={false}
                  onChange={(event) =>
                    updateSample(
                      sample.id,
                      "checksum",
                      event.currentTarget.value,
                    )
                  }
                />
              </label>
              {samples.length > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t("workbench.crc.removeSample", {
                    index: index + 1,
                  })}
                  onClick={() => {
                    setSamples((current) =>
                      current.filter(({ id }) => id !== sample.id),
                    );
                    clearResult();
                  }}
                >
                  {t("workbench.crc.remove")}
                </Button>
              ) : null}
            </fieldset>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{t("workbench.crc.analyze")}</Button>
          <Button
            type="button"
            variant="outline"
            disabled={samples.length >= maxCrcSamples}
            onClick={() => {
              const next = { ...initialSample, id: nextSample.current++ };
              setSamples((current) => [...current, next]);
              clearResult();
            }}
          >
            {t("workbench.crc.add")}
          </Button>
        </div>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {t("workbench.crc.invalid", { path: failure })}
          </p>
        ) : null}
      </form>
      {result ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {t(resultMessages[result.status])}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("workbench.crc.counts", {
              distinct: result.distinctSamples,
              duplicates: result.duplicateSamples,
              candidates: result.candidates.length,
            })}
          </p>
          {result.candidates.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-start text-xs">
                <caption className="sr-only">
                  {t("workbench.crc.candidates")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-1 text-start">
                      {t("workbench.crc.model")}
                    </th>
                    <th scope="col" className="p-1 text-start">
                      {t("workbench.crc.order")}
                    </th>
                    <th scope="col" className="p-1 text-start">
                      {t("workbench.crc.parameters")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map((candidate) => (
                    <tr
                      key={candidate.name + "-" + candidate.order}
                      className="border-t align-top"
                    >
                      <th scope="row" className="p-1 text-start font-medium">
                        {candidate.name}
                      </th>
                      <td className="p-1">
                        {t(
                          candidate.width <= 8
                            ? "workbench.crc.singleByte"
                            : candidate.order === "big"
                              ? "workbench.fields.bigEndian"
                              : "workbench.fields.littleEndian",
                        )}
                      </td>
                      <td className="p-1">
                        <code className="block whitespace-nowrap">
                          {t("workbench.crc.register", {
                            poly: hex(candidate.polynomial, candidate.width),
                            initial: hex(candidate.initial, candidate.width),
                            final: hex(candidate.finalXor, candidate.width),
                          })}
                        </code>
                        {t("workbench.crc.reflection", {
                          input: candidate.reflectInput ? 1 : 0,
                          output: candidate.reflectOutput ? 1 : 0,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
