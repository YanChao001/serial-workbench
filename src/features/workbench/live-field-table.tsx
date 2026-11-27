import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StreamItem, Target } from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import {
  compileProtocolFieldDocument,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { FramingFrame } from "./framing-model";
import { beginLiveFieldSource } from "./live-field-source";
import type { ChartSourceSelection } from "./stream-chart-selection";
import { StructuredFieldTable } from "./structured-field-table";

type Reader = NonNullable<ReturnType<typeof beginLiveFieldSource>>;
type Snapshot = ReturnType<Reader["update"]>;
type Active = {
  reader: Reader;
  codec: ReturnType<typeof compileProtocolFieldDocument>["codec"];
};

export type LiveFieldInput = {
  subscription?: string;
  anchor?: FramingFrame;
  items: readonly StreamItem[];
  target: Target;
};

export function LiveFieldTable({
  source,
  definition,
  format,
  onRevealSource,
}: {
  source: LiveFieldInput;
  definition: string;
  format: FieldDefinitionFormat;
  onRevealSource?: (source: ChartSourceSelection) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const latestItems = useRef(source.items);
  latestItems.current = source.items;
  const [active, setActive] = useState<Active>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [issue, setIssue] = useState<string>();
  const [retentionIssue, setRetentionIssue] = useState<FramingFrame>();
  const current = snapshot?.kind === "frame" ? snapshot : undefined;
  const displayed = current?.frame;
  const codec = active?.codec;
  const rows = useMemo(() => {
    if (!displayed || !codec) return;
    try {
      const readings = codec.decode(parseHex(displayed.hex));
      const checksumFailed = readings.some(
        (reading) => reading.checksum?.valid === false,
      );
      return readings.map((reading) => ({
        id: reading.id,
        name: reading.id,
        value: reading.label
          ? reading.value + " (" + reading.label + ")"
          : reading.value,
        unit: reading.unit,
        quality: t(
          checksumFailed
            ? "workbench.fieldTable.checksumFailed"
            : reading.calibration?.status === "unmapped"
              ? "workbench.fieldTable.unmapped"
              : "workbench.fieldTable.complete",
        ),
      }));
    } catch (error) {
      if (!(error instanceof ProtocolFieldError)) throw error;
    }
  }, [codec, displayed, t]);
  const reader = active?.reader;
  const running = reader !== undefined && snapshot?.kind !== "source_changed";

  useEffect(() => {
    if (!reader) return;
    let previous: readonly StreamItem[] | undefined;
    const timer = window.setInterval(() => {
      const items = latestItems.current;
      if (previous === items) return;
      previous = items;
      const next = reader.update(items);
      setSnapshot(next);
      if (next.kind === "source_changed") window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [reader]);

  function follow() {
    if (running) {
      setActive(undefined);
      setSnapshot(undefined);
      return;
    }
    const { anchor, items, target, subscription } = source;
    if (!anchor || !subscription) return;
    setIssue(undefined);
    setRetentionIssue(undefined);
    try {
      const { codec } = compileProtocolFieldDocument(definition, format);
      if (
        BigInt(anchor.byteEnd) - BigInt(anchor.byteStart) !==
        BigInt(codec.byteLength)
      ) {
        setIssue(t("workbench.fieldTable.widthMismatch"));
        return;
      }
      const reader = beginLiveFieldSource(items, target, anchor);
      if (!reader) {
        setIssue(t("workbench.fieldTable.sourceChanged"));
        return;
      }
      setActive({ reader, codec });
      setSnapshot(reader.update(items));
    } catch (error) {
      if (!(error instanceof ProtocolFieldError)) throw error;
      setIssue(t("workbench.fields.invalidDefinition", { path: error.path }));
    }
  }

  return (
    <section aria-labelledby={id} className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id} className="text-sm font-medium">
          {t("workbench.fieldTable.title")}
        </h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !running &&
            (!source.anchor || !source.subscription || !definition.trim())
          }
          onClick={follow}
        >
          {t(
            running
              ? "workbench.fieldTable.stop"
              : "workbench.fieldTable.follow",
          )}
        </Button>
      </div>
      {!source.anchor || !source.subscription ? (
        <p className="text-sm text-muted-foreground">
          {t("workbench.fieldTable.anchor")}
        </p>
      ) : null}
      {issue && (
        <p role="alert" className="text-sm text-destructive">
          {issue}
        </p>
      )}
      {snapshot?.kind === "source_changed" && (
        <p role="status" className="text-sm">
          {t("workbench.fieldTable.sourceChanged")}
        </p>
      )}
      {displayed && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <code>
            RX{" "}
            {t("workbench.fields.byteRange", {
              start: displayed.byteStart,
              end: displayed.byteEnd,
            })}
          </code>
          {onRevealSource && reader && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const selection = reader.selection(
                  latestItems.current,
                  displayed,
                );
                if (selection) onRevealSource(selection);
                else setRetentionIssue(displayed);
              }}
            >
              {t("workbench.fieldTable.reveal")}
            </Button>
          )}
        </div>
      )}
      {retentionIssue && retentionIssue === displayed && (
        <p role="status" className="text-sm">
          {t("workbench.fieldTable.notRetained")}
        </p>
      )}
      {current?.pending ? (
        <p className="text-sm text-muted-foreground">
          {t("workbench.fieldTable.waiting")}
        </p>
      ) : null}
      {rows ? (
        <StructuredFieldTable
          caption={t("workbench.fieldTable.title")}
          rows={rows}
        />
      ) : displayed ? (
        <p role="status" className="text-sm">
          {t("workbench.fieldTable.decodeFailed")}
        </p>
      ) : null}
    </section>
  );
}
