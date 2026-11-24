import { useId, useRef, useState, type FormEvent } from "react";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  nmeaLimits,
  parseNmeaText,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/nmea";

const example = [
  "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47",
  "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A",
].join("\n");

export default function NmeaTool() {
  const { t } = useI18n();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof parseNmeaText>>();
  const [issue, setIssue] = useState(false);
  const [selectedLine, setSelectedLine] = useState("");
  const selected = result?.lines.find(
    (entry) => String(entry.line) === selectedLine,
  );
  useUnsavedWork({
    id,
    label: t("workbench.nmea.title"),
    dirty: text !== "",
    discard: () => changeText(""),
    retainAfterUnmount: false,
  });

  function changeText(value: string) {
    setText(value);
    setResult(undefined);
    setIssue(false);
  }

  function parse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsed = parseNmeaText(text);
      setIssue(false);
      setSelectedLine(String(parsed.lines[0]!.line));
      setResult(parsed);
    } catch (error) {
      if (!(error instanceof ProtocolFieldError)) throw error;
      setResult(undefined);
      setIssue(true);
    }
  }

  function locate(line: number, start: number, end: number) {
    const input = textarea.current;
    if (!input) return;
    const lineStart = input.value
      .split("\n")
      .slice(0, line - 1)
      .reduce((offset, sentence) => offset + sentence.length + 1, 0);
    input.focus();
    input.setSelectionRange(lineStart + start, lineStart + end);
  }

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.nmea.title")}
      </summary>
      <form className="space-y-2" onSubmit={parse}>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-text"}>
          {t("workbench.nmea.input")}
          <Textarea
            ref={textarea}
            id={id + "-text"}
            className="min-h-24 font-mono text-xs"
            aria-describedby={id + (issue ? "-error" : "-help")}
            aria-invalid={issue}
            value={text}
            onChange={(event) => changeText(event.currentTarget.value)}
            maxLength={nmeaLimits.text}
            spellCheck={false}
          />
        </label>
        <p id={id + "-help"} className="text-xs text-muted-foreground">
          {t("workbench.nmea.help", { count: nmeaLimits.sentences })}
        </p>
        {issue ? (
          <p
            id={id + "-error"}
            className="text-sm text-destructive"
            role="alert"
          >
            {t("workbench.nmea.limit", { count: nmeaLimits.sentences })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!text.trim()}>
            {t("workbench.nmea.parse")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeText(example)}
          >
            {t("workbench.nmea.example")}
          </Button>
        </div>
      </form>
      {result && selected ? (
        <section className="space-y-2" aria-label={t("workbench.nmea.results")}>
          <label
            htmlFor={id + "-line"}
            className="grid w-fit max-w-full gap-1.5 text-sm"
          >
            {t("workbench.nmea.resultLine")}
            <OptionsSelect
              id={id + "-line"}
              value={selectedLine}
              onValueChange={setSelectedLine}
              options={result.lines.map((entry) => ({
                value: String(entry.line),
                label: t("workbench.nmea.lineOption", {
                  line: entry.line,
                  detail:
                    entry.status === "invalid"
                      ? t("workbench.nmea.invalidLabel")
                      : entry.talker + entry.type,
                }),
              }))}
            />
          </label>
          {selected.status === "invalid" ? (
            <div className="space-y-2">
              <p role="status" className="text-sm text-destructive">
                {t("workbench.nmea.invalid", {
                  line: selected.line,
                  path: selected.path,
                })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  locate(selected.line, selected.start, selected.end)
                }
              >
                {t("workbench.nmea.locate")}
              </Button>
            </div>
          ) : selected.status === "unsupported" ? (
            <p role="status" className="text-sm">
              {t("workbench.nmea.unsupported", {
                type: selected.talker + selected.type,
              })}
            </p>
          ) : (
            <>
              <p role="status" className="text-sm">
                {t("workbench.nmea.verified", {
                  type: selected.talker + selected.type,
                  checksum: selected.checksum,
                })}
              </p>
              <Table aria-label={t("workbench.nmea.fields")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">
                      {t("workbench.nmea.field")}
                    </TableHead>
                    <TableHead scope="col">
                      {t("workbench.nmea.value")}
                    </TableHead>
                    <TableHead scope="col">{t("workbench.nmea.raw")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.fields.map((field) => (
                    <TableRow key={field.id}>
                      <th
                        scope="row"
                        className="p-2 text-left font-mono text-xs font-normal"
                      >
                        {field.id}
                      </th>
                      <TableCell>
                        {field.value ?? "—"}
                        {"unit" in field && field.value !== null
                          ? " " + field.unit
                          : null}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="font-mono text-xs"
                          onClick={() =>
                            locate(selected.line, field.start, field.end)
                          }
                          aria-label={t("workbench.nmea.locateField", {
                            field: field.id,
                            start: field.start,
                            end: field.end,
                          })}
                        >
                          {field.raw || "—"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </section>
      ) : null}
    </details>
  );
}
