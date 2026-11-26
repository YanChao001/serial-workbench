import { useId, useState, type FormEvent } from "react";
import {
  formatHex,
  HexInputError,
  parseHex,
} from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  compileFrameTemplate,
  defaultFrameTemplate,
  frameChecksumCoverage,
  frameLengthCoverage,
  frameTemplateWidths,
  type FrameTemplate,
  type FrameTemplateResult,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/frame-template";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { CHECKSUM_WIDTHS } from "../../../packages/plugin-sdk/src/wire-checksum";

type Mode = "assemble" | "decode";

const partLabels = {
  header: "workbench.frameTemplate.header",
  length: "workbench.frameTemplate.length",
  sequence: "workbench.frameTemplate.sequence",
  payload: "workbench.frameTemplate.payload",
  checksum: "workbench.frameTemplate.checksum",
  tail: "workbench.frameTemplate.tail",
} as const;

const coverageLabels = {
  payload: "workbench.frameTemplate.payload",
  "sequence-payload": "workbench.frameTemplate.fromSequence",
  "length-payload": "workbench.frameTemplate.fromLength",
  "header-payload": "workbench.frameTemplate.fromHeader",
  frame: "workbench.frameTemplate.wholeFrame",
} as const;

const algorithmLabels = {
  sum: "SUM",
  xor: "XOR",
  modbus: "CRC-16/MODBUS",
  ccitt: "CRC-16/CCITT-FALSE",
  crc32: "CRC-32",
} satisfies Record<keyof typeof CHECKSUM_WIDTHS, string>;

const inputLimit = 4096 * 3;

export default function FrameTemplateTool() {
  const { t } = useI18n();
  const id = useId();
  const [template, setTemplate] = useState(defaultFrameTemplate);
  const [mode, setMode] = useState<Mode>("assemble");
  const [sequence, setSequence] = useState("258");
  const [payload, setPayload] = useState("10 20 30");
  const [source, setSource] = useState("");
  const [json, setJson] = useState<string>();
  const [result, setResult] = useState<FrameTemplateResult>();
  const [issue, setIssue] = useState<string>();
  const dirty =
    JSON.stringify(template) !== JSON.stringify(defaultFrameTemplate) ||
    sequence !== "258" ||
    payload !== "10 20 30" ||
    source !== "" ||
    json !== undefined;

  function resetResult() {
    setResult(undefined);
    setIssue(undefined);
  }

  useUnsavedWork({
    id,
    label: t("workbench.frameTemplate.title"),
    dirty,
    discard: () => {
      setTemplate(defaultFrameTemplate);
      setMode("assemble");
      setSequence("258");
      setPayload("10 20 30");
      setSource("");
      setJson(undefined);
      resetResult();
    },
    retainAfterUnmount: false,
  });

  function changeTemplate<K extends keyof FrameTemplate>(
    key: K,
    value: FrameTemplate[K],
  ) {
    setTemplate((current) => ({ ...current, [key]: value }));
    resetResult();
  }

  function recordIssue(error: unknown, editingJson = false) {
    if (error instanceof ProtocolFieldError)
      setIssue(editingJson ? "json." + error.path : error.path);
    else if (error instanceof HexInputError) setIssue("frame");
    else if (error instanceof SyntaxError) setIssue("json");
    else throw error;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    resetResult();
    try {
      const codec = compileFrameTemplate(template);
      if (mode === "decode") {
        setResult(codec.decode(parseHex(source)));
      } else {
        setResult(
          codec.assemble({
            [template.sequence.variable]: sequence,
            [template.payload.variable]: payload,
          }),
        );
      }
    } catch (error) {
      recordIssue(error);
    }
  }

  function applyJson() {
    if (json === undefined) return;
    resetResult();
    try {
      const value: unknown = JSON.parse(json);
      setTemplate(compileFrameTemplate(value).definition);
      setJson(undefined);
    } catch (error) {
      recordIssue(error, true);
    }
  }

  const label = (part: keyof typeof partLabels, control: string) =>
    t("workbench.frameTemplate.controlFor", {
      part: t(partLabels[part]),
      control,
    });
  const problem = (path: string) =>
    issue === path || issue?.startsWith(path + ".");
  const feedback = (path: string) => ({
    "aria-invalid": problem(path),
    "aria-describedby": problem(path) ? id + "-issue" : undefined,
  });
  const wordWidths = frameTemplateWidths.map((value) => ({
    value: String(value),
    label: t("workbench.frameTemplate.widthBytes", { count: value }),
  }));
  const orders = [
    { value: "big", label: t("workbench.frameTemplate.big") },
    { value: "little", label: t("workbench.frameTemplate.little") },
  ] as const;

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.frameTemplate.title")}
      </summary>
      <form className="workbench-frame-template" onSubmit={submit}>
        <div className="workbench-frame-template-controls">
          <label>
            {t(partLabels.header)}
            <Input
              className="font-mono"
              maxLength={inputLimit}
              value={template.headerHex}
              onChange={(event) =>
                changeTemplate("headerHex", event.currentTarget.value)
              }
              {...feedback("headerHex")}
            />
          </label>
        </div>
        {(["length", "sequence"] as const).map((part) => (
          <fieldset key={part}>
            <legend>{t(partLabels[part])}</legend>
            <div className="workbench-frame-template-controls">
              <label>
                {t("workbench.frameTemplate.width")}
                <OptionsSelect
                  label={label(part, t("workbench.frameTemplate.width"))}
                  options={wordWidths}
                  value={String(template[part].width)}
                  onValueChange={(value) => {
                    const width = frameTemplateWidths.find(
                      (item) => String(item) === value,
                    );
                    if (width)
                      changeTemplate(part, { ...template[part], width });
                  }}
                  {...feedback(part + ".width")}
                />
              </label>
              <label>
                {t("workbench.frameTemplate.order")}
                <OptionsSelect
                  label={label(part, t("workbench.frameTemplate.order"))}
                  options={orders}
                  value={template[part].order}
                  onValueChange={(order) =>
                    changeTemplate(part, { ...template[part], order })
                  }
                />
              </label>
              {part === "length" ? (
                <label>
                  {t("workbench.frameTemplate.coverage")}
                  <OptionsSelect
                    label={label(part, t("workbench.frameTemplate.coverage"))}
                    options={frameLengthCoverage.map((value) => ({
                      value,
                      label: t(coverageLabels[value]),
                    }))}
                    value={template.length.coverage}
                    onValueChange={(coverage) =>
                      changeTemplate("length", { ...template.length, coverage })
                    }
                    {...feedback("length.coverage")}
                  />
                </label>
              ) : (
                <label>
                  {t("workbench.frameTemplate.variable")}
                  <Input
                    aria-label={label(
                      part,
                      t("workbench.frameTemplate.variable"),
                    )}
                    maxLength={64}
                    value={template.sequence.variable}
                    onChange={(event) =>
                      changeTemplate("sequence", {
                        ...template.sequence,
                        variable: event.currentTarget.value,
                      })
                    }
                    {...feedback("sequence.variable")}
                  />
                </label>
              )}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend>{t(partLabels.payload)}</legend>
          <div className="workbench-frame-template-controls">
            <label>
              {t("workbench.frameTemplate.variable")}
              <Input
                aria-label={label(
                  "payload",
                  t("workbench.frameTemplate.variable"),
                )}
                maxLength={64}
                value={template.payload.variable}
                onChange={(event) =>
                  changeTemplate("payload", {
                    ...template.payload,
                    variable: event.currentTarget.value,
                  })
                }
                {...feedback("payload.variable")}
              />
            </label>
            <label>
              {t("workbench.frameTemplate.format")}
              <OptionsSelect
                label={t("workbench.frameTemplate.format")}
                options={[
                  { value: "hex", label: "HEX" },
                  { value: "utf8", label: "UTF-8" },
                ]}
                value={template.payload.format}
                onValueChange={(format) =>
                  changeTemplate("payload", { ...template.payload, format })
                }
              />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>{t(partLabels.checksum)}</legend>
          <div className="workbench-frame-template-controls">
            <label>
              {t("workbench.frameTemplate.algorithm")}
              <OptionsSelect
                label={label(
                  "checksum",
                  t("workbench.frameTemplate.algorithm"),
                )}
                options={(
                  Object.keys(
                    algorithmLabels,
                  ) as (keyof typeof algorithmLabels)[]
                ).map((value) => ({ value, label: algorithmLabels[value] }))}
                value={template.checksum.algorithm}
                onValueChange={(algorithm) =>
                  changeTemplate("checksum", {
                    ...template.checksum,
                    algorithm,
                  })
                }
              />
            </label>
            <label>
              {t("workbench.frameTemplate.order")}
              <OptionsSelect
                label={label("checksum", t("workbench.frameTemplate.order"))}
                options={orders}
                value={template.checksum.order}
                onValueChange={(order) =>
                  changeTemplate("checksum", { ...template.checksum, order })
                }
              />
            </label>
            <label>
              {t("workbench.frameTemplate.coverage")}
              <OptionsSelect
                label={label("checksum", t("workbench.frameTemplate.coverage"))}
                options={frameChecksumCoverage.map((value) => ({
                  value,
                  label: t(coverageLabels[value]),
                }))}
                value={template.checksum.coverage}
                onValueChange={(coverage) =>
                  changeTemplate("checksum", { ...template.checksum, coverage })
                }
              />
            </label>
          </div>
        </fieldset>
        <div className="workbench-frame-template-controls">
          <label>
            {t(partLabels.tail)}
            <Input
              className="font-mono"
              maxLength={inputLimit}
              value={template.tailHex}
              onChange={(event) =>
                changeTemplate("tailHex", event.currentTarget.value)
              }
              {...feedback("tailHex")}
            />
          </label>
        </div>
        <details className="space-y-2">
          <summary className="cursor-pointer">
            {t("workbench.frameTemplate.templateJson")}
          </summary>
          <Textarea
            aria-label={t("workbench.frameTemplate.templateJson")}
            className="font-mono"
            maxLength={16_384}
            spellCheck={false}
            value={json ?? JSON.stringify(template, null, 2)}
            onChange={(event) => {
              setJson(event.currentTarget.value);
              resetResult();
            }}
            {...feedback("json")}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={json === undefined}
            onClick={applyJson}
          >
            {t("workbench.frameTemplate.apply")}
          </Button>
        </details>
        <label className="grid gap-1.5 text-sm">
          {t("workbench.frameTemplate.mode")}
          <OptionsSelect
            label={t("workbench.frameTemplate.mode")}
            value={mode}
            options={[
              {
                value: "assemble",
                label: t("workbench.frameTemplate.assemble"),
              },
              { value: "decode", label: t("workbench.frameTemplate.decode") },
            ]}
            onValueChange={(value) => {
              setMode(value);
              resetResult();
            }}
          />
        </label>
        {mode === "assemble" ? (
          <fieldset>
            <legend>{t("workbench.frameTemplate.variables")}</legend>
            <div className="workbench-frame-template-controls">
              <label>
                {t("workbench.frameTemplate.variableValue", {
                  name: template.sequence.variable,
                })}
                <Input
                  className="font-mono"
                  inputMode="numeric"
                  maxLength={20}
                  value={sequence}
                  onChange={(event) => {
                    setSequence(event.currentTarget.value);
                    resetResult();
                  }}
                  {...feedback("values.sequence")}
                />
              </label>
              <label>
                {t("workbench.frameTemplate.variableValue", {
                  name: template.payload.variable,
                })}
                <Textarea
                  className="font-mono"
                  maxLength={inputLimit}
                  spellCheck={false}
                  value={payload}
                  onChange={(event) => {
                    setPayload(event.currentTarget.value);
                    resetResult();
                  }}
                  {...feedback("values.payload")}
                />
              </label>
            </div>
          </fieldset>
        ) : (
          <label className="grid gap-1.5 text-sm">
            {t("workbench.frameTemplate.source")}
            <Textarea
              className="font-mono"
              maxLength={inputLimit}
              spellCheck={false}
              value={source}
              onChange={(event) => {
                setSource(event.currentTarget.value);
                resetResult();
              }}
              {...feedback("frame")}
            />
          </label>
        )}
        <div>
          <Button size="sm" type="submit">
            {t(
              mode === "assemble"
                ? "workbench.frameTemplate.preview"
                : "workbench.frameTemplate.decode",
            )}
          </Button>
        </div>
        {issue && (
          <p
            id={id + "-issue"}
            role="alert"
            className="break-words text-sm text-destructive"
          >
            {issue === "json"
              ? t("workbench.frameTemplate.invalidJson")
              : issue === "frame"
                ? t("workbench.frameTemplate.invalidFrame")
                : issue === "length"
                  ? t("workbench.frameTemplate.invalidLength")
                  : issue === "checksum"
                    ? t("workbench.frameTemplate.invalidChecksum")
                    : t("workbench.frameTemplate.invalidField", {
                        path: issue,
                      })}
          </p>
        )}
        {result && (
          <>
            <label className="grid gap-1.5 text-sm">
              {t("workbench.frameTemplate.result")}
              <Textarea
                className="font-mono"
                readOnly
                value={formatHex(result.bytes)}
              />
            </label>
            <div
              className="min-w-0 overflow-x-auto"
              role="region"
              tabIndex={0}
              aria-label={t("workbench.frameTemplate.trace")}
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th scope="col">{t("workbench.frameTemplate.range")}</th>
                    <th scope="col">{t("workbench.frameTemplate.field")}</th>
                    <th scope="col">{t("workbench.frameTemplate.bytes")}</th>
                    <th scope="col">{t("workbench.frameTemplate.origin")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.parts.map((part) => (
                    <tr key={part.id} className="border-b align-top">
                      <td className="whitespace-nowrap font-mono">{`[${part.range.start}, ${part.range.end})`}</td>
                      <th scope="row" className="whitespace-nowrap font-normal">
                        {t(partLabels[part.id])}
                      </th>
                      <td className="min-w-20 font-mono break-all">
                        {part.hex}
                      </td>
                      <td className="min-w-32 break-all">
                        {part.variable
                          ? t("workbench.frameTemplate.fromVariable", {
                              name: part.variable,
                              value: part.value,
                            })
                          : part.coverage
                            ? t("workbench.frameTemplate.fromRange", {
                                value: part.value,
                                ...part.coverage,
                              })
                            : t("workbench.frameTemplate.fixed")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </form>
    </details>
  );
}
