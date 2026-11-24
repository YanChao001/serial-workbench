import { useId, useMemo, useState } from "react";
import { OptionsSelect } from "@/components/options-select";
import { useI18n } from "@/providers/i18n";
import {
  compileProtocolFieldDocument,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { busIntervals, busLoad, type BusInterval } from "./bus-load-model";
import type { FramingInspection } from "./framing-anomalies-model";

export function BusLoad({
  inspection,
  definition,
  format,
}: {
  inspection: FramingInspection;
  definition: string;
  format: FieldDefinitionFormat;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [interval, setInterval] = useState<BusInterval>(100);
  const model = useMemo(() => {
    if (!open) return;
    let codec;
    if (definition.trim()) {
      try {
        codec = compileProtocolFieldDocument(definition, format).codec;
      } catch (error) {
        if (!(error instanceof ProtocolFieldError)) throw error;
      }
    }
    return busLoad(inspection, interval, codec);
  }, [open, definition, format, inspection, interval]);
  const number = new Intl.NumberFormat(language);
  const percent = new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const factor = BigInt(1000 / interval);
  const observedBytes = (bytes: bigint) =>
    bytes
      ? t("workbench.busLoad.observedBytes", { bytes: number.format(bytes) })
      : "—";
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-md border px-3 py-2"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.busLoad.title")}
      </summary>
      {open ? (
        <section
          aria-label={t("workbench.busLoad.title")}
          className="mt-3 grid gap-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={id}>{t("workbench.busLoad.interval")}</label>
            <OptionsSelect
              id={id}
              value={String(interval)}
              onValueChange={(value) => {
                const match = busIntervals.find((ms) => String(ms) === value);
                if (match) setInterval(match);
              }}
              options={busIntervals.map((ms) => ({
                value: String(ms),
                label: t("workbench.busLoad.milliseconds", { ms }),
              }))}
            />
          </div>
          {model ? (
            <>
              <p className="wrap-anywhere text-muted-foreground">
                {t("workbench.busLoad.clock", {
                  clock: model.clock,
                  resolution: model.resolution,
                  origin: model.origin,
                  observedThrough: model.observedThrough,
                })}
              </p>
              <p className="text-muted-foreground">
                {t("workbench.busLoad.scope")}
              </p>
              {model.unresolved ? (
                <p role="status">
                  {t("workbench.busLoad.unresolved", {
                    count: model.unresolved,
                  })}
                </p>
              ) : null}
              {!model.hasCodec ? (
                <p className="text-muted-foreground">
                  {t("workbench.busLoad.noDefinition")}
                </p>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full text-start tabular-nums">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      {(
                        [
                          "offset",
                          "received",
                          "accepted",
                          "unknown",
                          "frames",
                          "errors",
                          "coverage",
                        ] as const
                      ).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          className="px-2 py-1.5 text-start font-medium"
                        >
                          {t(`workbench.busLoad.${key}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.buckets.map((bucket) => (
                      <tr key={String(bucket.offsetMs)} className="border-t">
                        <th
                          scope="row"
                          className="px-2 py-1.5 text-start font-medium"
                        >
                          {number.format(bucket.offsetMs)}–
                          {number.format(bucket.offsetMs + BigInt(interval))}
                        </th>
                        <td className="px-2 py-1.5">
                          {bucket.complete
                            ? number.format(bucket.receivedBytes * factor)
                            : observedBytes(bucket.receivedBytes)}
                        </td>
                        <td className="px-2 py-1.5">
                          {bucket.complete
                            ? number.format(bucket.acceptedBytes * factor)
                            : observedBytes(bucket.acceptedBytes)}
                        </td>
                        <td className="px-2 py-1.5">
                          {number.format(bucket.unknownBytes)}
                        </td>
                        <td className="px-2 py-1.5">
                          {bucket.framesComplete
                            ? number.format(
                                BigInt(bucket.parsedFrames) * factor,
                              )
                            : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {model.hasCodec &&
                          bucket.framesComplete &&
                          bucket.parsedFrames
                            ? percent.format(
                                bucket.failedFrames / bucket.parsedFrames,
                              )
                            : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {t(
                            bucket.gap
                              ? "workbench.busLoad.gap"
                              : bucket.framesComplete
                                ? "workbench.busLoad.complete"
                                : bucket.complete
                                  ? "workbench.busLoad.rawOnly"
                                  : "workbench.busLoad.partial",
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p role="status">{t("workbench.busLoad.unavailable")}</p>
          )}
        </section>
      ) : null}
    </details>
  );
}
