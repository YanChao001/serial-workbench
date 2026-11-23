import { useId, useState } from "react";
import { formatHex } from "@serial-workbench/host-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorkbenchLabels } from "./labels";
import {
  interpretStreamNumber,
  NUMBER_WIDTHS,
  type NumberWidth,
  type StreamNumberSample,
} from "./stream-number";

export function StreamNumberInspector({
  sample,
  labels,
}: {
  sample: StreamNumberSample;
  labels: WorkbenchLabels;
}) {
  const id = useId();
  const widths = NUMBER_WIDTHS.filter((width) => width <= sample.bytes.length);
  const [width, setWidth] = useState<NumberWidth>(widths.at(-1) ?? 1);
  const [order, setOrder] = useState("big");
  const values = interpretStreamNumber(sample.bytes, width, order === "little");
  return (
    <>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id + "-width"}>{labels.numberWidth}</label>
          <Select
            value={String(width * 8)}
            onValueChange={(value) => {
              const next = widths.find(
                (option) => String(option * 8) === value,
              );
              if (next) setWidth(next);
            }}
          >
            <SelectTrigger id={id + "-width"} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {widths.map((option) => (
                <SelectItem key={option} value={String(option * 8)}>
                  {option * 8}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id + "-order"}>{labels.checksumOrder}</label>
          <Select value={order} onValueChange={setOrder}>
            <SelectTrigger id={id + "-order"} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="big">{labels.checksumBigEndian}</SelectItem>
              <SelectItem value="little">
                {labels.checksumLittleEndian}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {labels.offset} <code>{sample.offset.toString()}</code>
      </p>
      <dl className="workbench-number-values">
        <dt>{labels.numberSourceBytes}</dt>
        <dd>{formatHex(sample.bytes.subarray(0, width))}</dd>
        <dt>{labels.numberUnsigned}</dt>
        <dd>{values.unsigned}</dd>
        <dt>{labels.numberSigned}</dt>
        <dd>{values.signed}</dd>
        <dt>HEX</dt>
        <dd>{values.hex}</dd>
        <dt>BIN</dt>
        <dd>{values.binary}</dd>
        <dt>OCT</dt>
        <dd>{values.octal}</dd>
        {values.float !== undefined && (
          <>
            <dt>
              {labels.numberFloat} {width * 8}
            </dt>
            <dd>{values.float}</dd>
          </>
        )}
      </dl>
    </>
  );
}
