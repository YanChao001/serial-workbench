import { useId, useMemo, useState } from "react";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";

const roles = [
  "header",
  "address",
  "length",
  "payload",
  "checksum",
  "plain",
] as const;
type ByteRole = (typeof roles)[number];

function byteRuns(hex: string, fields: readonly FieldReading[]) {
  const bytes = hex.trim().split(/\s+/);
  const boundaries = Array.from(
    new Set([
      0,
      bytes.length,
      ...fields.flatMap(({ bytes }) => [bytes.start, bytes.end]),
    ]),
  ).sort((first, second) => first - second);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    return {
      start,
      end,
      hex: bytes.slice(start, end).join(" "),
      fields: fields.filter(
        ({ bytes }) => bytes.start <= start && bytes.end >= end,
      ),
    };
  });
}

export function ProtocolByteMap({
  hex,
  origin,
  generated = false,
  readings,
}: {
  hex: string;
  origin: bigint;
  generated?: boolean;
  readings?: readonly FieldReading[];
}) {
  const { t } = useI18n();
  const id = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [assigned, setAssigned] = useState<ReadonlyMap<string, ByteRole>>(
    () => new Map(),
  );
  const segments = useMemo(
    () => byteRuns(hex, readings ?? []),
    [hex, readings],
  );
  const selected = readings?.find(({ id }) => id === selectedId);
  const range = (start: number, end: number) =>
    t("workbench.fields.byteRange", {
      start: (origin + BigInt(start)).toString(),
      end: (origin + BigInt(end)).toString(),
    });

  function role(field: FieldReading): ByteRole {
    const explicit = assigned.get(field.id);
    if (explicit) return explicit;
    if (field.kind === "checksum") return "checksum";
    return roles.find((value) => value === field.id) ?? "plain";
  }

  return (
    <section
      aria-labelledby={id + "-title"}
      className="protocol-byte-map grid min-w-0 gap-3"
    >
      <h4 id={id + "-title"} className="text-sm font-medium">
        {t("workbench.fields.byteMap")}
      </h4>
      <div
        role="region"
        aria-label={t(
          generated
            ? "workbench.fields.generatedSource"
            : "workbench.fields.source",
        )}
        tabIndex={0}
        data-surface="reading"
        className="max-h-48 min-w-0 overflow-auto rounded-md border p-2 font-mono text-xs leading-6 wrap-anywhere"
      >
        {segments.map(({ start, end, hex, fields }, index) => {
          const matching =
            fields.find(({ id }) => id === selected?.id) ?? fields[0];
          return (
            <span key={start}>
              {index > 0 ? " " : null}
              {matching ? (
                <button
                  type="button"
                  data-surface="transparent"
                  data-field-role={role(matching)}
                  aria-label={t("workbench.fields.inspectBytes", {
                    field: matching.id,
                  })}
                  aria-pressed={matching.id === selected?.id}
                  aria-describedby={
                    matching.id === selected?.id
                      ? id + "-field-details"
                      : undefined
                  }
                  title={range(start, end)}
                  tabIndex={-1}
                  className="max-w-full rounded-sm px-0.5 text-start font-mono text-xs wrap-anywhere whitespace-normal"
                  onClick={() => setSelectedId(matching.id)}
                >
                  {hex}
                </button>
              ) : (
                <span data-unclassified-bytes="" title={range(start, end)}>
                  {hex}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {readings?.length ? (
        <div
          role="group"
          aria-label={t("workbench.fields.name")}
          className="flex flex-wrap gap-1.5"
        >
          {readings.map((field) => (
            <Button
              key={field.id}
              type="button"
              variant="ghost"
              size="sm"
              data-field-role={role(field)}
              aria-pressed={field.id === selected?.id}
              className="h-auto min-h-7 max-w-full wrap-anywhere whitespace-normal"
              onClick={() => setSelectedId(field.id)}
            >
              {field.id}
            </Button>
          ))}
        </div>
      ) : null}

      <div id={id + "-field-details"} aria-live="polite">
        {selected ? (
          <div className="grid min-w-0 gap-2 border-t pt-2 text-sm">
            <div className="wrap-anywhere">
              <p className="font-medium">{selected.id}</p>
              <p>
                {selected.value}
                {selected.unit ? " " + selected.unit : null}
                {selected.label ? " · " + selected.label : null}
              </p>
              <p className="text-muted-foreground tabular-nums">
                {range(selected.bytes.start, selected.bytes.end)}
                {selected.bits
                  ? " · " + t("workbench.fields.bitRange", selected.bits)
                  : null}
              </p>
              <p className="font-mono text-xs">{selected.rawHex}</p>
            </div>
            <label className="grid max-w-60 gap-1.5">
              <span>{t("workbench.fields.byteRole")}</span>
              <OptionsSelect
                label={t("workbench.fields.byteRole")}
                value={role(selected)}
                options={roles.map((value) => ({
                  value,
                  label: t(`workbench.fields.role.${value}`),
                }))}
                onValueChange={(value) =>
                  setAssigned((current) =>
                    new Map(current).set(selected.id, value),
                  )
                }
              />
            </label>
          </div>
        ) : null}
      </div>
    </section>
  );
}
