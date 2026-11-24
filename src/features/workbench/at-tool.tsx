import { useId, useState, type FormEvent } from "react";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  atLimits,
  parseAtResponse,
  type AtResultFormat,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/at-response";

const initial = { command: "", text: "", format: "verbose" as AtResultFormat };
const example = {
  command: "AT+CREG?",
  text: ["AT+CREG?", "+CREG: 5", '+CMTI: "SM",3', "+CREG: 2,5", "OK"].join(
    "\n",
  ),
  format: "verbose" as const,
};

export default function AtTool() {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [result, setResult] = useState<ReturnType<typeof parseAtResponse>>();
  const [issue, setIssue] = useState<string>();
  useUnsavedWork({
    id,
    label: t("workbench.at.title"),
    dirty:
      draft.command !== "" ||
      draft.text !== "" ||
      draft.format !== initial.format,
    discard: () => change(initial),
    retainAfterUnmount: false,
  });

  function change(patch: Partial<typeof initial>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setResult(undefined);
    setIssue(undefined);
  }

  function parse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setResult(
        parseAtResponse(draft.text, draft.command.trim(), draft.format),
      );
      setIssue(undefined);
    } catch (error) {
      if (!(error instanceof ProtocolFieldError)) throw error;
      setResult(undefined);
      setIssue(error.path);
    }
  }

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.at.title")}
      </summary>
      <form className="space-y-3" onSubmit={parse}>
        <div className="grid gap-3 sm:grid-cols-[minmax(10rem,1fr)_auto]">
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-command"}>
            {t("workbench.at.command")}
            <Input
              id={id + "-command"}
              className="font-mono text-xs"
              value={draft.command}
              maxLength={atLimits.command}
              spellCheck={false}
              aria-invalid={issue === "command"}
              aria-describedby={id + (issue === "command" ? "-error" : "-help")}
              onChange={(event) =>
                change({ command: event.currentTarget.value })
              }
            />
          </label>
          <label
            className="grid w-fit gap-1.5 text-sm"
            htmlFor={id + "-format"}
          >
            {t("workbench.at.format")}
            <OptionsSelect<AtResultFormat>
              id={id + "-format"}
              value={draft.format}
              options={[
                { value: "verbose", label: t("workbench.at.verbose") },
                { value: "numeric", label: t("workbench.at.numeric") },
              ]}
              onValueChange={(format) => change({ format })}
            />
          </label>
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={id + "-text"}>
          {t("workbench.at.text")}
          <Textarea
            id={id + "-text"}
            value={draft.text}
            maxLength={atLimits.text}
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
            aria-invalid={issue === "text"}
            aria-describedby={id + (issue === "text" ? "-error" : "-help")}
            onChange={(event) => change({ text: event.currentTarget.value })}
          />
        </label>
        <p id={id + "-help"} className="text-xs text-muted-foreground">
          {t("workbench.at.help", { count: atLimits.lines })}
        </p>
        {issue ? (
          <p
            id={id + "-error"}
            role="alert"
            className="text-sm text-destructive"
          >
            {t(
              issue === "command"
                ? "workbench.at.invalidCommand"
                : "workbench.at.invalidText",
              { count: atLimits.lines },
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!draft.text.trim()}>
            {t("workbench.at.parse")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => change(example)}
          >
            {t("workbench.at.example")}
          </Button>
        </div>
      </form>
      {result ? (
        <section className="space-y-2" aria-label={t("workbench.at.results")}>
          <p role="status" className="text-sm">
            {t(`workbench.at.state.${result.state}`)}
          </p>
          <div className="max-h-72 overflow-auto rounded-md border">
            <Table
              aria-label={t("workbench.at.results")}
              className="table-fixed"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-12">
                    {t("workbench.at.line")}
                  </TableHead>
                  <TableHead scope="col" className="w-28">
                    {t("workbench.at.kind")}
                  </TableHead>
                  <TableHead scope="col">{t("workbench.at.source")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.lines.map((entry) => (
                  <TableRow key={entry.line}>
                    <th
                      scope="row"
                      className="p-2 text-left font-mono text-xs font-normal"
                    >
                      {entry.line}
                    </th>
                    <TableCell className="whitespace-normal">
                      {t(`workbench.at.kind.${entry.kind}`)}
                      {"code" in entry ? (
                        <code className="block wrap-anywhere text-xs">
                          {entry.code}
                        </code>
                      ) : null}
                    </TableCell>
                    <TableCell className="wrap-anywhere font-mono text-xs whitespace-pre-wrap">
                      {entry.raw}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </details>
  );
}
