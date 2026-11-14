import type { SerialConfiguration } from "@serial-workbench/contracts";
import { Input } from "@/components/ui/input";
import { HelpTooltip } from "@/components/help-tooltip";
import { OptionsSelect } from "@/components/options-select";
import { EditableCombobox } from "@/components/editable-combobox";
import type { WriteWaitMode } from "@/lib/generated/bindings";
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
> &
  Partial<Record<"readWaitHint" | "writeWaitHint" | "reconnectHint", string>>;
export type SerialConfigurationFieldsProps = {
  value: SerialConfiguration;
  onChange(value: SerialConfiguration): void;
  labels: SerialConfigurationLabels;
  id: string;
  disabled?: boolean;
  writeWaitMode?: WriteWaitMode;
  onWriteWaitModeChange?: (value: WriteWaitMode) => void;
  writeWaitLabels?: { title: string; automatic: string; fixed: string };
};

export function SerialConfigurationFields({
  value,
  onChange,
  labels,
  id,
  disabled = false,
  writeWaitMode,
  onWriteWaitModeChange,
  writeWaitLabels,
}: SerialConfigurationFieldsProps) {
  const hints = {
    readWaitMs: labels.readWaitHint,
    writeWaitMs: labels.writeWaitHint,
    reconnectBackoffMs: labels.reconnectHint,
  };
  function update<K extends keyof SerialConfiguration>(
    field: K,
    next: SerialConfiguration[K],
  ) {
    if (value[field] === next) return;
    onChange({ ...value, [field]: next });
  }
  return (
    <div className="workbench-configuration-fields">
      <div className="workbench-form-row">
        <label htmlFor={id + "-baud"}>{labels.baudRate}</label>
        <EditableCombobox
          id={id + "-baud"}
          inputMode="numeric"
          label={labels.baudRate}
          optionsLabel={labels.baudPresets}
          options={BAUD_PRESETS}
          value={value.baudRate}
          disabled={disabled}
          aria-invalid={!validBaudRate(value.baudRate)}
          onValueChange={(next) => update("baudRate", next)}
        />
      </div>
      <div className="workbench-form-row">
        <label htmlFor={id + "-data-bits"}>{labels.dataBits}</label>
        <OptionsSelect
          id={id + "-data-bits"}
          label={labels.dataBits}
          value={value.dataBits}
          disabled={disabled}
          onValueChange={(next) => update("dataBits", next)}
          options={(["5", "6", "7", "8"] as const).map((option) => ({
            value: option,
            label: option,
          }))}
        />
      </div>
      <div className="workbench-form-row">
        <label htmlFor={id + "-parity"}>{labels.parity}</label>
        <OptionsSelect
          id={id + "-parity"}
          label={labels.parity}
          value={value.parity}
          disabled={disabled}
          onValueChange={(next) => update("parity", next)}
          options={(["none", "even", "odd", "mark", "space"] as const).map(
            (option) => ({
              value: option,
              label: labels[option],
            }),
          )}
        />
      </div>
      <div className="workbench-form-row">
        <label htmlFor={id + "-stop-bits"}>{labels.stopBits}</label>
        <OptionsSelect
          id={id + "-stop-bits"}
          label={labels.stopBits}
          value={value.stopBits}
          disabled={disabled}
          onValueChange={(next) => update("stopBits", next)}
          options={(["one", "onePointFive", "two"] as const).map((option) => ({
            value: option,
            label: labels[option],
          }))}
        />
      </div>
      <div className="workbench-form-row">
        <label htmlFor={id + "-flow-control"}>{labels.flowControl}</label>
        <OptionsSelect
          id={id + "-flow-control"}
          label={labels.flowControl}
          value={value.flowControl}
          disabled={disabled}
          onValueChange={(next) => update("flowControl", next)}
          options={(["none", "rtsCts", "xonXoff", "dsrDtr"] as const).map(
            (option) => ({
              value: option,
              label: labels[option],
            }),
          )}
        />
      </div>
      {writeWaitMode !== undefined && writeWaitLabels && (
        <div className="workbench-form-row">
          <label htmlFor={id + "-write-wait-mode"}>
            {writeWaitLabels.title}
          </label>
          <OptionsSelect
            id={id + "-write-wait-mode"}
            label={writeWaitLabels.title}
            value={writeWaitMode}
            disabled={disabled}
            onValueChange={(mode) => onWriteWaitModeChange?.(mode)}
            options={[
              { value: "automatic", label: writeWaitLabels.automatic },
              { value: "fixed", label: writeWaitLabels.fixed },
            ]}
          />
        </div>
      )}
      {(["readWaitMs", "writeWaitMs", "reconnectBackoffMs"] as const)
        .filter(
          (field) =>
            field !== "writeWaitMs" ||
            writeWaitMode !== "automatic" ||
            !validDuration(value.writeWaitMs),
        )
        .map((field) => (
          <div className="workbench-form-row" key={field}>
            <div className="flex items-center gap-1">
              <label htmlFor={id + "-" + field}>{labels[field]}</label>
              {hints[field] && (
                <HelpTooltip label={`${labels[field]}?`}>
                  {hints[field]}
                </HelpTooltip>
              )}
            </div>
            <Input
              id={id + "-" + field}
              inputMode="numeric"
              value={value[field]}
              disabled={disabled}
              aria-invalid={!validDuration(value[field])}
              onChange={(event) => update(field, event.target.value)}
            />
          </div>
        ))}
    </div>
  );
}
