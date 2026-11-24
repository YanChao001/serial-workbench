import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  compileProtocolFieldDocument,
  maxDefinitionLength,
  ProtocolDefinitionError,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import {
  ProtocolFieldError,
  type FieldReading,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { FramingFrame } from "./framing-model";
import type { FramingInspection } from "./framing-anomalies-model";
import { FieldChart } from "./field-chart";
import { isChartField } from "./field-chart-model";
import type { ChartSourceSelection } from "./stream-chart-selection";
import { FramingAnomaliesTool } from "./framing-anomalies-tool";
import {
  DefinitionFileError,
  readProtocolDefinitionFile,
  type ProtocolDefinitionFileAccess,
} from "./protocol-definition-file";
import { useToolAction } from "./transfer-capture-actions";

type FieldCodec = ReturnType<typeof compileProtocolFieldDocument>["codec"];
type FieldEditor = {
  reading: FieldReading;
  signed: boolean;
  littleEndian: boolean;
};
type Construction = {
  codec: FieldCodec;
  base?: Uint8Array;
  fields: FieldEditor[];
  initialValues: Record<string, string>;
  values: Record<string, string>;
  preview?: { hex: string; readings: FieldReading[] };
  invalidField?: string;
};
type Attempt = {
  frame?: FramingFrame;
  readings?: FieldReading[];
  construction?: Construction;
  error?: { path: string; position?: ProtocolDefinitionError["position"] };
};

function definitionIssue(error: unknown): NonNullable<Attempt["error"]> {
  return {
    path:
      error instanceof ProtocolFieldError
        ? error.path.slice(0, 120)
        : "definition",
    position:
      error instanceof ProtocolDefinitionError ? error.position : undefined,
  };
}

function frameId(frame: FramingFrame) {
  return `${frame.eventStart}:${frame.byteStart}`;
}

export default function ProtocolFieldPreview({
  frames,
  fileAccess,
  inspection,
  readOnly = false,
  sourceSelection,
  onRevealSource,
}: {
  frames: readonly FramingFrame[];
  fileAccess?: ProtocolDefinitionFileAccess;
  inspection?: FramingInspection;
  readOnly?: boolean;
  sourceSelection?: ChartSourceSelection;
  onRevealSource?: (source: ChartSourceSelection) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [definition, setDefinition] = useState("");
  const [format, setFormat] = useState<FieldDefinitionFormat>("json");
  const [openedFile, setOpenedFile] = useState<{
    name: string;
    text: string;
    format: FieldDefinitionFormat;
  }>();
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<Attempt>();
  const [chartSelection, setChartSelection] = useState<{
    inspection: FramingInspection;
    definition: string;
    format: FieldDefinitionFormat;
    field: string;
    frame: FramingFrame;
  }>();
  const [fileDefinitionIssue, setFileDefinitionIssue] =
    useState<Attempt["error"]>();
  const pendingFile = useRef<AbortController | null>(null);
  const picker = fileAccess?.pickFile;
  useEffect(() => () => pendingFile.current?.abort(), [picker]);
  const opening = useToolAction((error) =>
    error instanceof DefinitionFileError
      ? t(error.key)
      : nativeErrorCode(error) === "LIMIT_EXCEEDED"
        ? t("workbench.fields.fileSize")
        : nativeErrorText(error, t),
  );
  const frame =
    selected === "empty"
      ? undefined
      : (frames.find((entry) => frameId(entry) === selected) ?? frames[0]);
  const current = result && result.frame === frame ? result : undefined;
  const construction = current?.construction;
  const readings = construction?.preview?.readings ?? current?.readings;
  const chart =
    chartSelection?.inspection === inspection &&
    chartSelection?.definition === definition &&
    chartSelection?.format === format
      ? chartSelection
      : undefined;
  const origin = current?.readings && frame ? BigInt(frame.byteStart) : 0n;
  const issue = current?.error ?? fileDefinitionIssue;
  const valuesDirty = construction
    ? Object.entries(construction.initialValues).some(
        ([field, value]) => construction.values[field] !== value,
      )
    : false;
  useUnsavedWork({
    id,
    label: t("workbench.fields.definition"),
    dirty:
      valuesDirty ||
      (openedFile
        ? definition !== openedFile.text || format !== openedFile.format
        : definition.trim() !== ""),
    retainAfterUnmount: false,
    discard: () => {
      changeDefinition(openedFile?.text ?? "");
      setFormat(openedFile?.format ?? "json");
    },
  });

  function changeDefinition(value: string) {
    pendingFile.current?.abort();
    setDefinition(value);
    setResult(undefined);
    setFileDefinitionIssue(undefined);
  }

  function openDefinition() {
    if (!fileAccess) return;
    void opening.run(async (closed) => {
      const read = new AbortController();
      pendingFile.current = read;
      const signal = AbortSignal.any([closed, read.signal]);
      try {
        const file = await readProtocolDefinitionFile(fileAccess, signal);
        signal.throwIfAborted();
        if (!file) return;
        pendingFile.current = null;
        changeDefinition(file.text);
        setFormat(file.format);
        setOpenedFile(file);
        try {
          compileProtocolFieldDocument(file.text, file.format);
        } catch (error) {
          setFileDefinitionIssue(definitionIssue(error));
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        pendingFile.current = null;
      }
    });
  }

  function showExample() {
    const width = frame
      ? Number(BigInt(frame.byteEnd) - BigInt(frame.byteStart))
      : 6;
    const fields = frame
      ? [{ id: "payload", kind: "bytes", byteOffset: 0, width }]
      : [
          {
            id: "sample",
            kind: "integer",
            byteOffset: 0,
            width: 2,
            signed: true,
            order: "little",
          },
          {
            id: "reading",
            kind: "float",
            byteOffset: 2,
            width: 4,
            order: "big",
          },
        ];
    setFormat("json");
    changeDefinition(
      JSON.stringify(
        {
          version: "1",
          byteLength: width,
          fields,
        },
        null,
        2,
      ),
    );
  }

  function prepare(build: boolean) {
    if (!frame) setSelected("empty");
    try {
      const { codec, definition: input } = compileProtocolFieldDocument(
        definition,
        format,
      );
      const base = frame ? parseHex(frame.hex) : undefined;
      const decoded = codec.decode(base ?? new Uint8Array(codec.byteLength));
      if (!build) {
        setResult({ frame, readings: decoded });
        return;
      }
      const specifications: readonly unknown[] =
        isRecord(input) && Array.isArray(input.fields) ? input.fields : [];
      const fields = decoded.flatMap((reading, index) => {
        if (reading.kind === "checksum") return [];
        const spec = specifications[index];
        return [
          {
            reading,
            signed: isRecord(spec) && spec.signed === true,
            littleEndian: isRecord(spec) && spec.order === "little",
          },
        ];
      });
      const values = Object.fromEntries(
        fields.map(({ reading }) => [
          reading.id,
          reading.kind === "utf8"
            ? JSON.stringify(base ? reading.value : "")
            : reading.value,
        ]),
      );
      setResult({
        frame,
        construction: { codec, base, fields, initialValues: values, values },
      });
    } catch (error) {
      setResult({
        frame,
        error: definitionIssue(error),
      });
    }
  }

  function generate(event: FormEvent) {
    event.preventDefault();
    if (!construction) return;
    const values = Object.fromEntries(
      construction.fields.map(({ reading }) => {
        const value = construction.values[reading.id] ?? "";
        if (reading.kind !== "utf8") return [reading.id, value];
        try {
          const text: unknown = JSON.parse(value);
          return [reading.id, text];
        } catch {
          return [reading.id, undefined];
        }
      }),
    );
    try {
      const bytes = construction.codec.encode(values, construction.base);
      setResult({
        frame,
        construction: {
          ...construction,
          invalidField: undefined,
          preview: {
            hex: formatHex(bytes),
            readings: construction.codec.decode(bytes),
          },
        },
      });
    } catch (error) {
      setResult({
        frame,
        construction: {
          ...construction,
          preview: undefined,
          invalidField:
            error instanceof ProtocolFieldError
              ? error.path.slice(0, 120)
              : "values",
        },
      });
    }
  }

  return (
    <section
      aria-labelledby={id + "-title"}
      className="space-y-3 border-t pt-3"
    >
      <h3 id={id + "-title"} className="text-sm font-medium">
        {t("workbench.fields.title")}
      </h3>
      <div className="space-y-2">
        {frames.length > 0 ? (
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-frame"}>
            <span>{t("workbench.fields.frame")}</span>
            <OptionsSelect
              id={id + "-frame"}
              value={frame ? frameId(frame) : "empty"}
              options={[
                ...(readOnly
                  ? []
                  : [
                      { value: "empty", label: t("workbench.fields.zeroBase") },
                    ]),
                ...frames.map((entry) => ({
                  value: frameId(entry),
                  label: t("workbench.fields.byteRange", {
                    start: entry.byteStart,
                    end: entry.byteEnd,
                  }),
                })),
              ]}
              onValueChange={(value) => {
                setSelected(value);
                setResult(undefined);
              }}
            />
          </label>
        ) : null}
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-format"}>
          <span>{t("workbench.fields.format")}</span>
          <OptionsSelect
            id={id + "-format"}
            value={format}
            options={[
              { value: "json", label: "JSON" },
              { value: "yaml", label: "YAML" },
            ]}
            onValueChange={(value) => {
              if (value !== "json" && value !== "yaml") return;
              pendingFile.current?.abort();
              setFormat(value);
              setResult(undefined);
              setFileDefinitionIssue(undefined);
            }}
          />
        </label>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-definition"}>
          <span>{t("workbench.fields.definition")}</span>
          <Textarea
            id={id + "-definition"}
            aria-invalid={Boolean(issue)}
            aria-describedby={issue ? id + "-error" : id + "-help"}
            className="min-h-24 font-mono text-xs"
            value={definition}
            maxLength={maxDefinitionLength}
            spellCheck={false}
            onChange={(event) => changeDefinition(event.currentTarget.value)}
          />
        </label>
        <p id={id + "-help"} className="text-xs text-muted-foreground">
          {t("workbench.fields.help")}
        </p>
        {openedFile ? (
          <p
            role="status"
            className="wrap-anywhere text-xs text-muted-foreground"
          >
            {t("workbench.fields.openedFile", { name: openedFile.name })}
          </p>
        ) : null}
        {opening.error ? (
          <p role="alert" className="text-sm text-destructive">
            {opening.error}
          </p>
        ) : null}
        {issue ? (
          <p
            id={id + "-error"}
            role="alert"
            className="text-sm text-destructive"
          >
            {issue.position
              ? t("workbench.fields.invalidDefinitionAt", {
                  path: issue.path,
                  ...issue.position,
                })
              : t("workbench.fields.invalidDefinition", {
                  path: issue.path,
                })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {fileAccess ? (
            <Button
              type="button"
              variant="outline"
              disabled={opening.busy}
              onClick={openDefinition}
            >
              {t(
                opening.busy
                  ? "workbench.fields.openingFile"
                  : "workbench.fields.openFile",
              )}
            </Button>
          ) : null}
          {frame ? (
            <Button
              type="button"
              disabled={!definition.trim()}
              onClick={() => prepare(false)}
            >
              {t("workbench.fields.decode")}
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              type="button"
              variant={frame ? "outline" : "default"}
              disabled={!definition.trim()}
              onClick={() => prepare(true)}
            >
              {t("workbench.fields.edit")}
            </Button>
          ) : null}
          {frame || !readOnly ? (
            <Button type="button" variant="outline" onClick={showExample}>
              {t(
                frame
                  ? "workbench.fields.example"
                  : "workbench.fields.numericExample",
              )}
            </Button>
          ) : null}
        </div>
      </div>
      {construction ? (
        <form className="space-y-2" onSubmit={generate}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {t("workbench.fields.values")}
            </legend>
            {construction.fields.map(({ reading, signed, littleEndian }) => {
              const inputId = id + "-value-" + reading.id;
              const width = reading.bits
                ? reading.bits.end - reading.bits.start
                : (reading.bytes.end - reading.bytes.start) * 8;
              const endian = t(
                littleEndian
                  ? "workbench.fields.littleEndian"
                  : "workbench.fields.bigEndian",
              );
              const path = "values." + reading.id;
              const invalid = construction.invalidField === path;
              const byteWidth = reading.bytes.end - reading.bytes.start;
              let description: string;
              let maxLength = 81;
              switch (reading.kind) {
                case "bytes":
                  description = t("workbench.fields.hexInput", {
                    width: byteWidth,
                  });
                  maxLength = byteWidth * 2;
                  break;
                case "utf8":
                  description = t("workbench.fields.textInput", {
                    width: byteWidth,
                  });
                  maxLength = byteWidth * 6 + 2;
                  break;
                case "float":
                  description = t("workbench.fields.floating", {
                    width,
                    endian,
                  });
                  maxLength = 64;
                  break;
                default:
                  description = t(
                    signed
                      ? "workbench.fields.signed"
                      : "workbench.fields.unsigned",
                    { width, endian },
                  );
              }
              return (
                <div key={reading.id} className="grid gap-1.5 text-sm">
                  <label htmlFor={inputId}>
                    {reading.id}
                    {reading.unit ? " (" + reading.unit + ")" : ""}
                  </label>
                  <Input
                    id={inputId}
                    className="font-mono"
                    aria-describedby={
                      inputId +
                      "-description" +
                      (invalid ? " " + id + "-value-error" : "")
                    }
                    aria-invalid={invalid}
                    maxLength={maxLength}
                    spellCheck={false}
                    value={construction.values[reading.id] ?? ""}
                    onChange={(event) => {
                      pendingFile.current?.abort();
                      setResult({
                        frame,
                        construction: {
                          ...construction,
                          values: {
                            ...construction.values,
                            [reading.id]: event.currentTarget.value,
                          },
                          preview: undefined,
                          invalidField: undefined,
                        },
                      });
                    }}
                  />
                  <span
                    id={inputId + "-description"}
                    className="text-xs text-muted-foreground"
                  >
                    {description}
                  </span>
                </div>
              );
            })}
          </fieldset>
          <Button type="submit">{t("workbench.fields.generate")}</Button>
          {construction.invalidField ? (
            <p
              id={id + "-value-error"}
              role="alert"
              className="text-sm text-destructive"
            >
              {t("workbench.fields.invalidValue", {
                path: construction.invalidField,
              })}
            </p>
          ) : null}
          {construction.preview ? (
            <div className="grid gap-1 text-sm">
              <label htmlFor={id + "-generated"}>
                {t("workbench.fields.generated")}
              </label>
              <output
                id={id + "-generated"}
                className="wrap-anywhere rounded-md border p-2 font-mono text-xs"
              >
                {construction.preview.hex}
              </output>
            </div>
          ) : null}
        </form>
      ) : null}
      {inspection?.frames.length ? (
        <FieldChart
          inspection={inspection}
          definition={definition}
          format={format}
          frame={frame}
          field={chart?.field}
          selectionLocked={valuesDirty}
          sourceSelection={sourceSelection}
          onRevealSource={onRevealSource}
          onSelect={(entry, field) => {
            pendingFile.current?.abort();
            setSelected(frameId(entry.frame));
            setResult({ frame: entry.frame, readings: entry.readings });
            setChartSelection({
              inspection,
              definition,
              format,
              field,
              frame: entry.frame,
            });
          }}
        />
      ) : null}
      {readings ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-start text-xs">
            <caption className="sr-only">{t("workbench.fields.title")}</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="p-1 text-start">
                  {t("workbench.fields.name")}
                </th>
                <th scope="col" className="p-1 text-start">
                  {t("workbench.fields.value")}
                </th>
                <th scope="col" className="p-1 text-start">
                  {t(
                    construction
                      ? "workbench.fields.generated"
                      : "workbench.fields.source",
                  )}
                </th>
              </tr>
            </thead>
            <tbody className="align-top">
              {readings.map((reading) => (
                <tr
                  key={reading.id}
                  className="border-t data-[chart-selected=true]:bg-primary/10"
                  data-chart-selected={
                    Boolean(
                      !construction &&
                      chart?.frame === frame &&
                      chart?.field === reading.id,
                    ) || undefined
                  }
                >
                  <th scope="row" className="p-1 text-start font-medium">
                    {!construction &&
                    chart &&
                    frame &&
                    isChartField(reading) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-pressed={
                          chart.frame === frame && chart.field === reading.id
                        }
                        aria-label={t("workbench.fieldChart.selectField", {
                          field: reading.id,
                        })}
                        onClick={() =>
                          setChartSelection({
                            ...chart,
                            frame,
                            field: reading.id,
                          })
                        }
                      >
                        {reading.id}
                      </Button>
                    ) : (
                      reading.id
                    )}
                  </th>
                  <td className="p-1 wrap-anywhere">
                    {reading.calibration?.status === "unmapped" ? (
                      <span>{t("workbench.fields.calibrationUnmapped")}</span>
                    ) : (
                      <span>
                        {reading.value}
                        {reading.unit ? " " + reading.unit : ""}
                      </span>
                    )}
                    {reading.calibration && reading.rawValue !== undefined ? (
                      <div className="text-muted-foreground">
                        {t("workbench.fields.calibrationOrigin", {
                          revision: reading.calibration.revision,
                          raw: reading.rawValue,
                        })}
                      </div>
                    ) : null}
                    {reading.label ? <div>{reading.label}</div> : null}
                    {reading.checksum ? (
                      <div>
                        {reading.checksum.valid
                          ? t("workbench.fields.checksumValid")
                          : t("workbench.fields.checksumExpected", {
                              hex: reading.checksum.expectedHex,
                            })}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-1 wrap-anywhere">
                    {t("workbench.fields.byteRange", {
                      start: (origin + BigInt(reading.bytes.start)).toString(),
                      end: (origin + BigInt(reading.bytes.end)).toString(),
                    })}
                    {reading.bits ? (
                      <div>{t("workbench.fields.bitRange", reading.bits)}</div>
                    ) : null}
                    <code className="block">{reading.rawHex}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {inspection && (inspection.frames.length || inspection.previous) ? (
        <FramingAnomaliesTool
          inspection={inspection}
          definition={definition}
          format={format}
        />
      ) : null}
    </section>
  );
}
