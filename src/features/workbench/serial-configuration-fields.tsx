import type { SerialConfiguration } from "@serial-workbench/contracts";
import { Input } from "@/components/ui/input";
import {
  BAUD_PRESETS,
  validBaudRate,
  validDuration,
} from "./serial-configuration";

export type SerialConfigurationLabels = Record<
  | keyof SerialConfiguration
  | "baudPresets"
  | "none"
  | "even"
  | "odd"
  | "mark"
  | "space"
  | "one"
  | "onePointFive"
  | "two"
  | "rtsCts"
  | "xonXoff"
  | "dsrDtr",
  string
>;
export type SerialConfigurationFieldsProps = {
  value: SerialConfiguration;
  onChange(value: SerialConfiguration): void;
  labels: SerialConfigurationLabels;
  id: string;
};

export function SerialConfigurationFields({
  value,
  onChange,
  labels,
  id,
}: SerialConfigurationFieldsProps) {
  function update<K extends keyof SerialConfiguration>(
    field: K,
    next: SerialConfiguration[K],
  ) {
    onChange({ ...value, [field]: next });
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <label>
        {labels.baudRate}
        <Input
          inputMode="numeric"
          list={`${id}-baud`}
          value={value.baudRate}
          aria-invalid={!validBaudRate(value.baudRate)}
          onChange={(event) => update("baudRate", event.target.value)}
        />
      </label>
      <datalist id={`${id}-baud`} aria-label={labels.baudPresets}>
        {BAUD_PRESETS.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <label>
        {labels.dataBits}
        <select
          value={value.dataBits}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "5" ||
              value === "6" ||
              value === "7" ||
              value === "8"
            )
              update("dataBits", value);
          }}
        >
          {["5", "6", "7", "8"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        {labels.parity}
        <select
          value={value.parity}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "none" ||
              value === "even" ||
              value === "odd" ||
              value === "mark" ||
              value === "space"
            )
              update("parity", value);
          }}
        >
          {(["none", "even", "odd", "mark", "space"] as const).map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {labels.stopBits}
        <select
          value={value.stopBits}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "one" || value === "onePointFive" || value === "two")
              update("stopBits", value);
          }}
        >
          {(["one", "onePointFive", "two"] as const).map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {labels.flowControl}
        <select
          value={value.flowControl}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "none" ||
              value === "rtsCts" ||
              value === "xonXoff" ||
              value === "dsrDtr"
            )
              update("flowControl", value);
          }}
        >
          {(["none", "rtsCts", "xonXoff", "dsrDtr"] as const).map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
      </label>
      {(["readWaitMs", "writeWaitMs", "reconnectBackoffMs"] as const).map(
        (field) => (
          <label key={field}>
            {labels[field]}
            <Input
              inputMode="numeric"
              value={value[field]}
              aria-invalid={!validDuration(value[field])}
              onChange={(event) => update(field, event.target.value)}
            />
          </label>
        ),
      )}
    </div>
  );
}
