import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReceiveHistory } from "@/lib/receive-history";
import type { WorkbenchLabels } from "./labels";

const MIB = 1024 * 1024;
const RECORD_OPTIONS = [1, 10, 100, 500, 1000, 1024, 5000, 10000, 20000];
const BYTE_OPTIONS = [1, 2, 4, 8, 16].map((size) => size * MIB);

export function ReceiveHistoryControls({
  value,
  onChange,
  labels,
}: {
  value: Readonly<ReceiveHistory>;
  onChange: (value: ReceiveHistory) => void;
  labels: WorkbenchLabels;
}) {
  const id = useId();
  const records = [...new Set([...RECORD_OPTIONS, value.maxRecords])].sort(
    (a, b) => a - b,
  );
  const capacities = [...new Set([...BYTE_OPTIONS, value.maxBytes])].sort(
    (a, b) => a - b,
  );
  return (
    <fieldset className="workbench-history-options">
      <legend>{labels.historyRetention}</legend>
      <div className="workbench-history-row">
        <Label htmlFor={`${id}-records`}>{labels.historyRecords}</Label>
        <Select
          value={String(value.maxRecords)}
          onValueChange={(next) =>
            onChange({ ...value, maxRecords: Number(next) })
          }
        >
          <SelectTrigger id={`${id}-records`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {records.map((count) => (
              <SelectItem key={count} value={String(count)}>
                {count.toLocaleString()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="workbench-history-row">
        <Label htmlFor={`${id}-bytes`}>{labels.historyCapacity}</Label>
        <Select
          value={String(value.maxBytes)}
          onValueChange={(next) =>
            onChange({ ...value, maxBytes: Number(next) })
          }
        >
          <SelectTrigger id={`${id}-bytes`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {capacities.map((bytes) => (
              <SelectItem key={bytes} value={String(bytes)}>
                {(bytes / MIB).toLocaleString()} MiB
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground text-xs">{labels.historyHint}</p>
    </fieldset>
  );
}
