import { useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorText } from "@/lib/native-error";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  decodeModbusFrame,
  encodeModbusFrame,
  type ModbusTransport,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import {
  parseModbusTimeline,
  timelineAxis,
  timingMilliseconds,
  type TimelineAttempt,
} from "./modbus-timeline-model";
import {
  runModbusTransaction,
  type ModbusTransactionAccess,
} from "./modbus-transaction";
import { useToolAction } from "./transfer-capture-actions";

const transports = [
  { value: "rtu", label: "RTU" },
  { value: "ascii", label: "ASCII" },
  { value: "tcp", label: "TCP" },
] as const;

function AttemptTiming({
  attempt,
  timeout,
  lateWindow,
  axis,
}: {
  attempt: TimelineAttempt;
  timeout: number;
  lateWindow: number;
  axis: ReturnType<typeof timelineAxis>;
}) {
  const { t } = useI18n();
  const { tx, response } = attempt;
  if (!tx) return <p>{t("workbench.timeline.noSource")}</p>;
  const first = response ? response.first.ns - tx.ns : 0n;
  const last = response ? response.last.ns - tx.ns : 0n;
  const deadline = BigInt(timeout) * 1_000_000n;
  const window = BigInt(timeout + lateWindow) * 1_000_000n;
  const sharedAxis = axis?.clockId === tx.clockId ? axis : undefined;
  const left = sharedAxis ? sharedAxis.start - tx.ns : first < 0n ? first : 0n;
  const right = sharedAxis
    ? sharedAxis.end - tx.ns
    : last > window
      ? last
      : window;
  const offset = sharedAxis ? tx.ns - sharedAxis.baseline : 0n;
  const percent = (value: bigint) =>
    (Number(value - left) / Number(right - left)) * 100;
  return (
    <>
      <div
        className="relative mx-1 my-2 h-4 rounded-sm bg-muted"
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 border-l-2 border-foreground"
          style={{ left: `${percent(0n)}%` }}
        />
        <span
          className="absolute inset-y-0 border-l border-dashed border-muted-foreground"
          style={{ left: `${percent(deadline)}%` }}
        />
        {response ? (
          <span
            className="absolute top-1/2 h-2 min-w-1 -translate-y-1/2 rounded-sm bg-primary"
            style={{
              left: `${percent(first)}%`,
              width: `${percent(last) - percent(first)}%`,
            }}
          />
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt>{t("workbench.timeline.clock")}</dt>
        <dd className="break-all font-mono">{tx.clockId}</dd>
        <dt>TX</dt>
        <dd>
          <code>
            {timingMilliseconds(offset)} ms · #{String(tx.event)}
          </code>{" "}
          {t(`workbench.timeline.precision.${tx.source}`)} /{" "}
          {String(tx.resolution)} ns
        </dd>
        <dt>{t("workbench.timeline.deadline")}</dt>
        <dd>
          <code>{timeout} ms</code>
        </dd>
        {response ? (
          <>
            <dt>{response.late ? t("workbench.timeline.late") : "RX"}</dt>
            <dd>
              <code>
                {timingMilliseconds(first)}–{timingMilliseconds(last)} ms
              </code>{" "}
              {t(`workbench.timeline.precision.${response.first.source}`)} /{" "}
              {String(response.first.resolution)} ns
              {response.last.event !== response.first.event ? (
                <>
                  {" "}
                  → {t(
                    `workbench.timeline.precision.${response.last.source}`,
                  )}{" "}
                  / {String(response.last.resolution)} ns
                </>
              ) : null}
            </dd>
            <dt>{t("workbench.timeline.elapsed")}</dt>
            <dd>
              {response.attributionKnown ? (
                <code>{timingMilliseconds(last)} ms</code>
              ) : (
                t("workbench.timeline.indeterminate")
              )}
            </dd>
            <dt>{t("workbench.timeline.span")}</dt>
            <dd>
              <code>{timingMilliseconds(last - first)} ms</code>
            </dd>
            <dt>{t("workbench.timeline.bytes")}</dt>
            <dd>
              <code>
                #{String(response.first.event)}–#{String(response.last.event)} ·
                [{String(response.byteStart)}, {String(response.byteEnd)})
              </code>
            </dd>
            {response.exceptionCode !== undefined ? (
              <>
                <dt>{t("workbench.timeline.exception")}</dt>
                <dd>
                  <code>{response.exceptionCode}</code>
                </dd>
              </>
            ) : null}
          </>
        ) : null}
        {attempt.ignoredFrames ? (
          <>
            <dt>{t("workbench.timeline.ignored")}</dt>
            <dd>
              <code>{attempt.ignoredFrames}</code>
            </dd>
          </>
        ) : null}
      </dl>
    </>
  );
}

export default function ModbusTimelineTool({
  access,
}: {
  access: ModbusTransactionAccess;
}) {
  const { t } = useI18n();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [transport, setTransport] = useState<ModbusTransport>("rtu");
  const [routing, setRouting] = useState<"gateway" | "direct">("gateway");
  const [request, setRequest] = useState("");
  const [timeout, setTimeoutMs] = useState("1000");
  const [late, setLate] = useState("100");
  const [retry, setRetry] = useState<"0" | "1" | "2">("0");
  const [issue, setIssue] = useState(false);
  const [report, setReport] = useState<
    ReturnType<typeof parseModbusTimeline> & {
      timeout: number;
      late: number;
      jitter?: bigint;
      samples: number;
    }
  >();
  const previousSamples = useRef<{ key: string; values: bigint[] }>(undefined);
  const action = useToolAction((reason) => nativeErrorText(reason, t));
  useUnsavedWork({
    id,
    label: t("workbench.timeline.title"),
    dirty: request.trim().length > 0,
    retainAfterUnmount: false,
    discard: () => setRequest(""),
  });

  function useExample() {
    setIssue(false);
    setRequest(
      formatHex(
        encodeModbusFrame(transport, "request", {
          unitId: 1,
          ...(transport === "tcp" ? { transactionId: 1 } : {}),
          pdu: { functionCode: 3, address: 0, quantity: 1 },
        }),
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!access.available || action.busy) return;
    let requestBase64: string;
    try {
      const bytes = parseHex(request);
      decodeModbusFrame(transport, "request", bytes);
      requestBase64 = bytesToBase64(bytes);
    } catch {
      setIssue(true);
      input.current?.focus();
      return;
    }
    setIssue(false);
    const timeoutMs = Number(timeout);
    const lateMs = Number(late);
    void action.run(async (signal) => {
      setReport(undefined);
      const timeline = await runModbusTransaction(
        access,
        {
          transport,
          requestBase64,
          ...(transport === "tcp" && { unitRouting: routing }),
          responseTimeoutMs: timeoutMs,
          lateResponseWaitMs: lateMs,
          retryLimit: Number(retry),
        },
        signal,
      );
      const first = timeline.attempts[0];
      let jitter: bigint | undefined;
      let samples = 0;
      if (
        timeline.attempts.length === 1 &&
        first?.tx &&
        first.outcome === "matched" &&
        first.response?.attributionKnown
      ) {
        const key = JSON.stringify([
          transport,
          routing,
          requestBase64,
          timeoutMs,
          lateMs,
          first.tx.clockId,
          first.tx.source,
          String(first.tx.resolution),
          first.response.last.source,
          String(first.response.last.resolution),
        ]);
        const previous = previousSamples.current;
        const values = [
          ...(previous?.key === key ? previous.values.slice(-7) : []),
          first.response.last.ns - first.tx.ns,
        ];
        previousSamples.current = { key, values };
        samples = values.length;
        const ordered = [...values].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        if (samples > 1) jitter = ordered[samples - 1]! - ordered[0]!;
      }
      setReport({
        ...timeline,
        timeout: timeoutMs,
        late: lateMs,
        jitter,
        samples,
      });
    });
  }

  const axis = report
    ? timelineAxis(
        report.attempts,
        BigInt(report.timeout + report.late) * 1_000_000n,
      )
    : undefined;
  return (
    <details className="rounded-md border border-border bg-card px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.timeline.title")}
      </summary>
      {!access.available ? (
        <p className="mt-2 text-sm">
          {t("workbench.timeline.unavailable")}{" "}
          <Link className="underline underline-offset-4" to="/plugins">
            {t("workbench.framing.openPlugins")}
          </Link>
        </p>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          <fieldset disabled={action.busy} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor={`${id}-transport`}>
                  {t("workbench.modbus.transport")}
                </label>
                <OptionsSelect<ModbusTransport>
                  id={`${id}-transport`}
                  value={transport}
                  onValueChange={setTransport}
                  options={transports}
                />
              </div>
              {transport === "tcp" ? (
                <div className="space-y-1">
                  <label htmlFor={`${id}-routing`}>
                    {t("workbench.modbus.routing")}
                  </label>
                  <OptionsSelect<"gateway" | "direct">
                    id={`${id}-routing`}
                    value={routing}
                    onValueChange={setRouting}
                    options={[
                      {
                        value: "gateway",
                        label: t("workbench.modbus.gateway"),
                      },
                      { value: "direct", label: t("workbench.modbus.direct") },
                    ]}
                  />
                </div>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-request`}>
                {t("workbench.modbus.requestFrame")}
              </label>
              <Textarea
                ref={input}
                id={`${id}-request`}
                className="font-mono"
                required
                rows={2}
                maxLength={2048}
                value={request}
                aria-invalid={issue || undefined}
                aria-describedby={issue ? `${id}-invalid` : undefined}
                onChange={(event) => {
                  setRequest(event.target.value);
                  setIssue(false);
                }}
              />
              {issue ? (
                <p
                  id={`${id}-invalid`}
                  role="alert"
                  className="text-destructive"
                >
                  {t("workbench.timeline.invalidRequest")}
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <label htmlFor={`${id}-timeout`}>
                  {t("workbench.timeline.timeout")}
                </label>
                <Input
                  id={`${id}-timeout`}
                  type="number"
                  required
                  min={50}
                  max={5000}
                  value={timeout}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-late`}>
                  {t("workbench.timeline.lateWindow")}
                </label>
                <Input
                  id={`${id}-late`}
                  type="number"
                  required
                  min={transport !== "tcp" && retry !== "0" ? 50 : 0}
                  max={3000}
                  value={late}
                  onChange={(event) => setLate(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-retry`}>
                  {t("workbench.timeline.retry")}
                </label>
                <OptionsSelect<"0" | "1" | "2">
                  id={`${id}-retry`}
                  value={retry}
                  onValueChange={setRetry}
                  options={[
                    { value: "0", label: "0" },
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                  ]}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">{t("workbench.timeline.send")}</Button>
              <Button type="button" variant="outline" onClick={useExample}>
                {t("workbench.modbus.example")}
              </Button>
            </div>
          </fieldset>
          {action.busy ? (
            <p role="status">{t("workbench.timeline.pending")}</p>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-destructive">
              {action.error}
            </p>
          ) : null}
        </form>
      )}
      {report ? (
        <section
          className="mt-3 space-y-2"
          aria-label={t("workbench.timeline.result")}
        >
          {report.turnaroundMs !== undefined ? (
            <p role="status">
              {t("workbench.timeline.broadcast")}{" "}
              <code>{report.turnaroundMs} ms</code>
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {report.attempts.map((attempt, index) => (
                <li key={attempt.operationId} className="space-y-1 py-2">
                  <h3 className="text-sm font-medium">
                    {t("workbench.timeline.attempt")} {index + 1} ·{" "}
                    {t(`workbench.timeline.outcome.${attempt.outcome}`)}
                    {attempt.transactionId !== undefined ? (
                      <>
                        {" "}
                        · <code>ID {attempt.transactionId}</code>
                      </>
                    ) : null}
                  </h3>
                  <AttemptTiming
                    attempt={attempt}
                    timeout={report.timeout}
                    lateWindow={report.late}
                    axis={axis}
                  />
                </li>
              ))}
            </ol>
          )}
          {report.jitter !== undefined ? (
            <p className="text-xs">
              {t("workbench.timeline.jitter")}{" "}
              <code>{timingMilliseconds(report.jitter)} ms</code> (
              {report.samples})
            </p>
          ) : null}
        </section>
      ) : null}
    </details>
  );
}
