import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { readVerifiedFile } from "@/lib/host-reader";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";

export const loopbackAction = "swb.builtin.automation.loopback";

const limits = {
  frameBytes: { min: 24, max: 256, initial: "64" },
  count: { min: 1, max: 16, initial: "4" },
  seed: { min: 0, max: 4294967295, initial: "1" },
  timeoutMs: { min: 50, max: 5000, initial: "500" },
} as const;
type Field = keyof typeof limits;
const fields = Object.keys(limits) as Field[];
const initial = {
  frameBytes: limits.frameBytes.initial,
  count: limits.count.initial,
  seed: limits.seed.initial,
  timeoutMs: limits.timeoutMs.initial,
};
type Settings = Record<Field, number>;
type LoopbackSource = "virtual_echo" | "serial_loopback";
type Access = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & {
  target: Target;
  port: string;
  source: LoopbackSource;
  prepare(
    params: Settings & { wired: boolean },
    signal: AbortSignal,
  ): Promise<HostInvocation>;
  cancel?: (operation: Operation, signal: AbortSignal) => Promise<void>;
};

const outcomes = [
  "completed",
  "duration_limit",
  "marker_mismatch",
  "missing_bytes",
  "response_timeout",
  "unexpected_bytes",
  "source_changed",
  "transmit_unconfirmed",
  "timing_unavailable",
] as const;
const frameOutcomes = ["compared", ...outcomes] as const;

function matches(operation: Operation, target: Target) {
  return (
    operation.actionId === loopbackAction &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

function pending(operation: Operation) {
  return ["queued", "running", "cancel_requested"].includes(operation.state);
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

async function readResult(
  access: Access,
  operation: Operation,
  signal: AbortSignal,
) {
  const completed = await access.waitForOperation(operation, signal);
  const reference =
    completed.result?.kind === "reference"
      ? completed.result.value.resultRef
      : undefined;
  if (
    !matches(completed, access.target) ||
    completed.operationId !== operation.operationId ||
    completed.state !== "succeeded" ||
    reference?.kind !== "plugin_result" ||
    reference.hostId !== access.target.hostId ||
    reference.id !== operation.operationId
  )
    throw new ContractValidationError(
      "Loopback result belongs to another operation",
    );
  const payload = await readVerifiedFile(reference, access.readFile, signal);
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(payload),
  );
  signal.throwIfAborted();
  if (!isRecord(value))
    throw new ContractValidationError("Invalid loopback report");
  const outcome = outcomes.find((item) => item === value.outcome);
  const {
    frames,
    sentBytes,
    comparedBits,
    bitErrors,
    bitErrorRate,
    throughputBytesPerSecond,
    latencyNs,
  } = value;
  if (
    !outcome ||
    value.source !== access.source ||
    !nonnegative(sentBytes) ||
    !nonnegative(comparedBits) ||
    !nonnegative(bitErrors) ||
    bitErrors > comparedBits ||
    !(
      bitErrorRate === null ||
      (nonnegative(bitErrorRate) && bitErrorRate <= 1)
    ) ||
    !(
      throughputBytesPerSecond === null || nonnegative(throughputBytesPerSecond)
    ) ||
    !(
      latencyNs === null ||
      (isRecord(latencyNs) && nonnegative(latencyNs.mean))
    ) ||
    !Array.isArray(frames) ||
    frames.length > 16
  )
    throw new ContractValidationError("Invalid loopback report");
  return {
    outcome,
    sentBytes,
    comparedBits,
    bitErrors,
    bitErrorRate,
    throughputBytesPerSecond,
    latencyMs: latencyNs === null ? null : Number(latencyNs.mean) / 1e6,
    frames: frames.map((frame: unknown) => {
      if (!isRecord(frame))
        throw new ContractValidationError("Invalid loopback frame");
      const state = frameOutcomes.find((item) => item === frame.outcome);
      if (
        !state ||
        !nonnegative(frame.sequence) ||
        !nonnegative(frame.receivedBytes) ||
        typeof frame.operationId !== "string"
      )
        throw new ContractValidationError("Invalid loopback frame");
      const source = frame.source;
      return {
        state,
        sequence: frame.sequence,
        receivedBytes: frame.receivedBytes,
        operationId: frame.operationId,
        byteRange:
          isRecord(source) &&
          source.hostId === access.target.hostId &&
          source.sessionId === access.target.sessionId &&
          source.sessionEpoch === access.target.sessionEpoch &&
          typeof source.byteStart === "string" &&
          typeof source.byteEnd === "string"
            ? { start: source.byteStart, end: source.byteEnd }
            : undefined,
      };
    }),
  };
}

type Result = Awaited<ReturnType<typeof readResult>>;

export function LoopbackTool({
  access,
  operations,
}: {
  access?: Access;
  operations: readonly Operation[];
}) {
  const { t, language } = useI18n();
  const [draft, setDraft] = useState<Record<Field, string>>(initial);
  const [wired, setWired] = useState(false);
  const [submitted, setSubmitted] = useState<Operation>();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState<string>();
  const [notice, setNotice] = useState<{
    error: unknown;
    cancelled?: boolean;
  }>();
  const [result, setResult] = useState<{ id: string; report: Result }>();
  const startRequest = useRef<AbortController | null>(null);
  const stopRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      startRequest.current?.abort();
      stopRequest.current?.abort();
    },
    [],
  );

  const projected =
    access &&
    operations.reduce<Operation | undefined>(
      (last, item) =>
        matches(item, access.target) &&
        (!submitted || item.operationId === submitted.operationId)
          ? item
          : last,
      undefined,
    );
  const operation = projected ?? submitted;
  const active = operation && pending(operation);
  const id = operation?.operationId;
  const settle = useEffectEvent(
    async (expectedId: string, signal: AbortSignal) => {
      if (!access || !operation || operation.operationId !== expectedId) return;
      try {
        const report = await readResult(access, operation, signal);
        if (!signal.aborted) setResult({ id: expectedId, report });
      } catch (error) {
        if (!signal.aborted) {
          const code = nativeErrorCode(error);
          setNotice({
            error,
            cancelled: code === "CANCELLED" || operation.state === "cancelled",
          });
        }
      }
    },
  );
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    void settle(id, controller.signal);
    return () => controller.abort();
  }, [id]);

  const settings = {
    frameBytes: Number(draft.frameBytes),
    count: Number(draft.count),
    seed: Number(draft.seed),
    timeoutMs: Number(draft.timeoutMs),
  };
  const invalid = fields.find(
    (field) =>
      !/^[0-9]+$/.test(draft[field]) ||
      !Number.isSafeInteger(settings[field]) ||
      settings[field] < limits[field].min ||
      settings[field] > limits[field].max,
  );
  const durationInvalid = settings.count * settings.timeoutMs > 15000;
  const physical = access?.source === "serial_loopback";
  const busy = starting || active;
  const canStart =
    access && !busy && !invalid && !durationInvalid && (!physical || wired);
  const report = result?.id === id ? result?.report : undefined;
  const formatter = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 5,
  });
  const number = (value: number | null) =>
    value === null ? t("loopback.notMeasured") : formatter.format(value);

  async function start() {
    if (!canStart || !access || startRequest.current) return;
    const request = new AbortController();
    startRequest.current = request;
    setStarting(true);
    setNotice(undefined);
    setResult(undefined);
    try {
      const input = await access.prepare(
        { ...settings, wired: physical && wired },
        request.signal,
      );
      const accepted = await access.invoke(input, request.signal);
      request.signal.throwIfAborted();
      if (!matches(accepted, access.target))
        throw new ContractValidationError(
          "Loopback admission belongs to another session",
        );
      setSubmitted(accepted);
    } catch (error) {
      if (!request.signal.aborted) setNotice({ error });
    } finally {
      if (startRequest.current === request) startRequest.current = null;
      if (!request.signal.aborted) setStarting(false);
    }
  }

  async function stop() {
    if (!access?.cancel || !operation || !active || stopRequest.current) return;
    const request = new AbortController();
    stopRequest.current = request;
    setStopping(operation.operationId);
    setNotice(undefined);
    try {
      await access.cancel(operation, request.signal);
    } catch (error) {
      if (!request.signal.aborted) {
        setStopping(undefined);
        setNotice({ error });
      }
    } finally {
      if (stopRequest.current === request) stopRequest.current = null;
    }
  }

  return (
    <section className="workbench-tool-form workbench-tool-form-fixed text-sm">
      {access ? (
        <p className="wrap-anywhere font-medium">
          {access.port} · {t(`loopback.source.${access.source}`)}
        </p>
      ) : (
        <p role="status">{t("loopback.unavailable")}</p>
      )}
      <div className="workbench-tool-page grid flex-1 content-start gap-3">
        <div className="workbench-form-grid workbench-form-grid-pair">
          {fields.map((field) => (
            <label key={field} className="workbench-form-row">
              <span>{t(`loopback.field.${field}`)}</span>
              <Input
                type="number"
                step={1}
                min={limits[field].min}
                max={limits[field].max}
                value={draft[field]}
                disabled={busy || !access}
                aria-invalid={invalid === field || undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, [field]: value }));
                }}
              />
            </label>
          ))}
        </div>
        {physical && (
          <label className="flex items-start gap-2">
            <Checkbox
              checked={wired}
              onCheckedChange={(value) => setWired(value === true)}
              disabled={busy}
            />
            <span>{t("loopback.wired", { port: access.port })}</span>
          </label>
        )}
        {invalid ? (
          <p role="status">
            {t("loopback.invalid", {
              min: limits[invalid].min,
              max: limits[invalid].max,
            })}
          </p>
        ) : durationInvalid ? (
          <p role="status">{t("loopback.duration")}</p>
        ) : (
          <p>
            {t("loopback.preview", {
              bytes: settings.frameBytes * settings.count,
            })}
          </p>
        )}
        {report && (
          <div className="grid gap-2">
            <dl className="workbench-form-fields tabular-nums">
              <div className="workbench-form-row">
                <dt>{t("loopback.sent")}</dt>
                <dd>{number(report.sentBytes)} B</dd>
              </div>
              <div className="workbench-form-row">
                <dt>{t("loopback.bits")}</dt>
                <dd>
                  {number(report.bitErrors)} / {number(report.comparedBits)}
                </dd>
              </div>
              <div className="workbench-form-row">
                <dt>{t("loopback.ber")}</dt>
                <dd>
                  {report.bitErrorRate === null
                    ? t("loopback.notMeasured")
                    : number(report.bitErrorRate * 100) + "%"}
                </dd>
              </div>
              <div className="workbench-form-row">
                <dt>{t("loopback.throughput")}</dt>
                <dd>
                  {report.throughputBytesPerSecond === null
                    ? t("loopback.notMeasured")
                    : number(report.throughputBytesPerSecond) + " B/s"}
                </dd>
              </div>
              <div className="workbench-form-row">
                <dt>{t("loopback.latency")}</dt>
                <dd>
                  {report.latencyMs === null
                    ? t("loopback.notMeasured")
                    : number(report.latencyMs) + " ms"}
                </dd>
              </div>
            </dl>
            {report.frames.length > 0 && (
              <details>
                <summary>{t("loopback.details")}</summary>
                <ol className="grid gap-2 text-muted-foreground">
                  {report.frames.map((frame) => (
                    <li key={frame.operationId} className="wrap-anywhere">
                      {t("loopback.frame", {
                        number: frame.sequence,
                        bytes: frame.receivedBytes,
                        outcome: t(`loopback.outcome.${frame.state}`),
                      })}
                      {frame.byteRange &&
                        " · " + t("loopback.range", frame.byteRange)}
                      <div className="select-text font-mono">
                        {frame.operationId}
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
      </div>
      {starting && <p role="status">{t("loopback.starting")}</p>}
      {active && (
        <p role="status">
          {t(
            stopping === id || operation.state === "cancel_requested"
              ? "loopback.stopping"
              : "loopback.running",
            {
              completed: operation.progress?.completed ?? "0",
              total: operation.progress?.total ?? draft.count,
            },
          )}
        </p>
      )}
      {notice && (
        <p role="status" className="wrap-anywhere">
          {notice.cancelled
            ? t("loopback.cancelled")
            : nativeErrorText(notice.error, t)}
        </p>
      )}
      {report && <p role="status">{t(`loopback.outcome.${report.outcome}`)}</p>}
      <div className="workbench-tool-footer">
        <Button type="button" onClick={() => void start()} disabled={!canStart}>
          {t("loopback.start")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void stop()}
          disabled={
            !active ||
            !access?.cancel ||
            stopping === id ||
            operation.state === "cancel_requested"
          }
        >
          {t("loopback.stop")}
        </Button>
      </div>
    </section>
  );
}
