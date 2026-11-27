import { useId, useState, type FormEvent } from "react";
import {
  ContractValidationError,
  type Call,
  type StreamItem,
  type Target,
} from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MessageKey } from "@/i18n/zh-CN";
import { readVerifiedFile } from "@/lib/host-reader";
import { nativeErrorText } from "@/lib/native-error";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  framingAction,
  framingParams,
  framingSourceItems,
  initialFramingDraft,
  parseFramingPage,
  receivedFramingRange,
  selectedFramingRange,
  type FramingDraft,
  type FramingMode,
  type FramingPage,
} from "./framing-model";
import { useToolAction } from "./transfer-capture-actions";
import type { ProtocolDefinitionFileAccess } from "./protocol-definition-file";
import type { ModbusTransactionAccess } from "./modbus-transaction";
import type { ModbusSlaveAccess } from "./modbus-server-tool";
import { ProtocolFieldsTool } from "./protocol-fields-tool";
import { fixedFramingRules } from "./live-fixed-framing";
import type { FramingInspection } from "./framing-anomalies-model";
import { WorkbenchNotice } from "./workbench-notice";
import type { ChartSourceSelection } from "./stream-chart-selection";

const modes: readonly [FramingMode, MessageKey][] = [
  ["fixed", "workbench.framing.fixed"],
  ["delimiter", "workbench.framing.delimiter"],
  ["length", "workbench.framing.length"],
  ["markers", "workbench.framing.markers"],
  ["silence", "workbench.framing.silence"],
];

export function FramingTool({
  items,
  rawSourceKey,
  target,
  sourceName,
  invoke,
  readFile,
  waitForOperation,
  definitionFileAccess,
  modbusTimeline,
  modbusSlave,
  sourceSelection,
  onRevealSource,
}: {
  items: readonly StreamItem[];
  rawSourceKey?: string;
  target: Target;
  sourceName?: string;
  invoke: HostContextValue["invoke"];
  readFile: HostContextValue["readFile"];
  waitForOperation: HostContextValue["waitForOperation"];
  definitionFileAccess?: ProtocolDefinitionFileAccess;
  modbusTimeline?: ModbusTransactionAccess;
  modbusSlave?: ModbusSlaveAccess;
  sourceSelection?: ChartSourceSelection;
  onRevealSource?: (source: ChartSourceSelection) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(() =>
    initialFramingDraft(selectedFramingRange(items, target, sourceSelection)),
  );
  const [applied, setApplied] = useState(draft);
  const [result, setResult] = useState<{
    params: Call["params"];
    sourceKey?: string;
    page: FramingPage;
    inspection: FramingInspection;
  }>();
  const action = useToolAction((reason) => nativeErrorText(reason, t));
  const params = framingParams(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const liveFraming =
    !dirty && rawSourceKey !== undefined && result?.sourceKey === rawSourceKey
      ? fixedFramingRules(result.params)
      : undefined;
  const liveAnchor = liveFraming && result?.page.frames.at(-1);
  useUnsavedWork({
    id,
    label: t("workbench.tools.framing"),
    dirty,
    retainAfterUnmount: false,
    discard: () => setDraft(applied),
  });

  function update<K extends keyof FramingDraft>(
    field: K,
    value: FramingDraft[K],
  ) {
    setDraft((current) =>
      current[field] === value ? current : { ...current, [field]: value },
    );
  }

  async function readPage(
    query: Call["params"],
    snapshot: FramingDraft,
    clear: boolean,
  ) {
    await action.run(async (signal) => {
      if (clear) setResult(undefined);
      const accepted = await invoke(
        {
          actionId: framingAction,
          target,
          params: query,
          executionMode: "independent",
        },
        signal,
      );
      const completed = await waitForOperation(accepted, signal);
      if (
        completed.actionId !== framingAction ||
        completed.operationId !== accepted.operationId ||
        completed.target.hostId !== target.hostId ||
        completed.target.kind !== target.kind ||
        completed.target.id !== target.id ||
        completed.target.sessionId !== target.sessionId ||
        completed.target.sessionEpoch !== target.sessionEpoch ||
        completed.result?.kind !== "reference" ||
        completed.result.value.resultRef.hostId !== target.hostId ||
        completed.result.value.resultRef.kind !== "plugin_result" ||
        completed.result.value.resultRef.id !== completed.operationId
      )
        throw new ContractValidationError(
          "Framing result belongs to another operation",
        );
      const bytes = await readVerifiedFile(
        completed.result.value.resultRef,
        readFile,
        signal,
      );
      const content: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      const page = parseFramingPage(content, target, query);
      signal.throwIfAborted();
      setApplied(snapshot);
      setResult((previous) => ({
        params: query,
        sourceKey: rawSourceKey,
        page,
        inspection: {
          target,
          items: framingSourceItems(items, target, snapshot),
          frames: page.frames,
          frameStart:
            typeof query.startEventSeq === "string"
              ? {
                  eventSeq: query.startEventSeq,
                  byteStart:
                    typeof query.startByte === "string"
                      ? query.startByte
                      : undefined,
                }
              : undefined,
          previous: clear
            ? undefined
            : (previous?.page.frames.at(-1) ?? previous?.inspection.previous),
          endEventSeq:
            !page.nextCursor && typeof query.endEventSeq === "string"
              ? query.endEventSeq
              : undefined,
        },
      }));
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (params) void readPage(params, draft, true);
  }

  function showNext() {
    const next = result?.page.nextCursor;
    if (!result || !next || dirty) return;
    void readPage(
      {
        ...result.params,
        startEventSeq: next.eventSeq,
        startByte: next.byteStart,
      },
      applied,
      false,
    );
  }

  function field(
    key: Exclude<keyof FramingDraft, "mode" | "width" | "order">,
    label: MessageKey,
    options: { hex?: boolean; signed?: boolean } = {},
  ) {
    return (
      <label className="grid min-w-0 gap-1.5">
        <span>{t(label)}</span>
        <Input
          className="min-w-0 font-mono"
          value={draft[key]}
          autoComplete="off"
          spellCheck={false}
          inputMode={options.hex || options.signed ? "text" : "numeric"}
          maxLength={
            options.hex
              ? 128
              : key === "startEventSeq" || key === "endEventSeq"
                ? 20
                : 6
          }
          onChange={(event) => update(key, event.currentTarget.value)}
        />
      </label>
    );
  }
  return (
    <div className="workbench-framing space-y-4">
      <form
        className="space-y-3"
        aria-describedby={params ? undefined : id + "-help"}
        onSubmit={submit}
      >
        <fieldset disabled={action.busy}>
          <legend>{t("workbench.framing.source")}</legend>
          {sourceName ? (
            <p className="text-sm font-medium">{sourceName}</p>
          ) : null}
          <div className="workbench-framing-fields">
            {field("startEventSeq", "workbench.framing.start")}
            {field("endEventSeq", "workbench.framing.end")}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setDraft({ ...draft, ...receivedFramingRange(items, target) })
            }
          >
            {t("workbench.framing.useReceived")}
          </Button>
        </fieldset>
        <fieldset disabled={action.busy}>
          <legend>{t("workbench.framing.boundaries")}</legend>
          <label className="grid gap-1.5" htmlFor={id + "-mode"}>
            <span>{t("workbench.framing.mode")}</span>
          </label>
          <OptionsSelect
            id={id + "-mode"}
            value={draft.mode}
            onValueChange={(mode) => update("mode", mode)}
            options={modes.map(([value, label]) => ({
              value,
              label: t(label),
            }))}
          />
          <div className="workbench-framing-fields">
            {draft.mode === "fixed"
              ? field("fixedLength", "workbench.framing.fixedLength")
              : null}
            {draft.mode === "delimiter"
              ? field("delimiter", "workbench.framing.delimiterHex", {
                  hex: true,
                })
              : null}
            {draft.mode === "length" ? (
              <>
                {field("offset", "workbench.framing.offset")}
                <div className="grid min-w-0 gap-1.5">
                  <label htmlFor={id + "-width"}>
                    {t("workbench.framing.width")}
                  </label>
                  <OptionsSelect
                    id={id + "-width"}
                    value={draft.width}
                    onValueChange={(value) => update("width", value)}
                    options={(["1", "2", "4"] as const).map((label) => ({
                      value: label,
                      label,
                    }))}
                  />
                </div>
                <div className="grid min-w-0 gap-1.5">
                  <label htmlFor={id + "-endian"}>
                    {t("workbench.framing.order")}
                  </label>
                  <OptionsSelect<FramingDraft["order"]>
                    id={id + "-endian"}
                    value={draft.order}
                    onValueChange={(value) => update("order", value)}
                    options={[
                      { value: "be", label: t("workbench.framing.be") },
                      { value: "le", label: t("workbench.framing.le") },
                    ]}
                  />
                </div>
                {field("adjustment", "workbench.framing.adjustment", {
                  signed: true,
                })}
              </>
            ) : null}
            {field("header", "workbench.framing.header", { hex: true })}
            {draft.mode !== "silence"
              ? field("footer", "workbench.framing.footer", { hex: true })
              : null}
            {field("escape", "workbench.framing.escape", { hex: true })}
            {field("idle", "workbench.framing.idle")}
            {field("limit", "workbench.framing.limit")}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!params || action.busy}>
            {t(
              action.busy
                ? "workbench.framing.scanning"
                : "workbench.framing.scan",
            )}
          </Button>
          {!params ? (
            <p
              id={id + "-help"}
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {t("workbench.framing.invalid")}
            </p>
          ) : null}
        </div>
      </form>
      {action.error ? (
        <WorkbenchNotice
          noticeKey={String(action.failureIndex)}
          eventKey={action.eventKey}
        >
          {action.error}
        </WorkbenchNotice>
      ) : null}
      {result ? (
        <section aria-label={t("workbench.framing.results")}>
          <p role="status" className="mb-2 text-sm">
            {t("workbench.framing.summary", {
              frames: result.page.frames.length,
              bytes: result.page.incompleteBytes,
            })}
          </p>
          <ol className="workbench-framing-results">
            {result.page.frames.map((frame) => (
              <li key={frame.eventStart + ":" + frame.byteStart}>
                <code>{frame.hex}</code>
                <span>{t("workbench.framing.range", { ...frame })}</span>
              </li>
            ))}
          </ol>
          {result.page.nextCursor ? (
            <Button
              className="mt-2"
              variant="outline"
              disabled={dirty || action.busy}
              onClick={showNext}
            >
              {t("workbench.framing.next")}
            </Button>
          ) : null}
        </section>
      ) : null}
      <ProtocolFieldsTool
        frames={result?.page.frames ?? []}
        inspection={result?.inspection}
        liveFields={{
          items,
          target,
          subscription: rawSourceKey,
          anchor:
            liveAnchor && liveFraming
              ? { frame: liveAnchor, framing: liveFraming }
              : undefined,
        }}
        fileAccess={definitionFileAccess}
        modbusTimeline={modbusTimeline}
        modbusSlave={modbusSlave}
        sourceSelection={sourceSelection}
        onRevealSource={onRevealSource}
      />
    </div>
  );
}
