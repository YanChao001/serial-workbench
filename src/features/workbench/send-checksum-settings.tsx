import { useId } from "react";
import { Hash } from "lucide-react";
import { OptionsSelect } from "@/components/options-select";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { WorkbenchLabels } from "./labels";
import {
  CHECKSUM_ALGORITHMS,
  type ChecksumOrder,
  type SendChecksum,
} from "./send-checksum";
import { WorkbenchIconButton } from "./workbench-icon-button";

export function SendChecksumSettings({
  value,
  disabled,
  checksumHex,
  invalid,
  labels,
  onChange,
}: {
  value: SendChecksum;
  disabled: boolean;
  checksumHex?: string;
  invalid: boolean;
  labels: WorkbenchLabels;
  onChange: (value: SendChecksum) => void;
}) {
  const hintId = useId();
  const active = value.algorithm !== "none";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={labels.sendChecksum}
          tooltip={
            checksumHex ? `${labels.sendChecksum} · ${checksumHex}` : undefined
          }
          variant={active ? "secondary" : "ghost"}
          disabled={disabled}
        >
          <Hash aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label={labels.sendChecksum}
        className="workbench-detail-popover"
        side="top"
        align="start"
      >
        <fieldset disabled={disabled} className="workbench-form-fields">
          <legend className="sr-only">{labels.sendChecksum}</legend>
          <div className="workbench-form-row">
            <span>{labels.checksumAlgorithm}</span>
            <OptionsSelect<SendChecksum["algorithm"]>
              label={labels.checksumAlgorithm}
              value={value.algorithm}
              disabled={disabled}
              onValueChange={(algorithm) =>
                onChange({
                  ...value,
                  algorithm,
                  order: algorithm === "modbus" ? "little" : "big",
                })
              }
              options={[
                { value: "none", label: labels.none },
                ...CHECKSUM_ALGORITHMS,
              ]}
            />
          </div>
          {active && (
            <>
              {value.algorithm !== "sum" && value.algorithm !== "xor" && (
                <div className="workbench-form-row">
                  <span>{labels.checksumOrder}</span>
                  <OptionsSelect<ChecksumOrder>
                    label={labels.checksumOrder}
                    value={value.order}
                    disabled={disabled}
                    onValueChange={(order) => onChange({ ...value, order })}
                    options={[
                      { value: "little", label: labels.checksumLittleEndian },
                      { value: "big", label: labels.checksumBigEndian },
                    ]}
                  />
                </div>
              )}
              <label>
                <span>{labels.checksumStart}</span>
                <Input
                  inputMode="numeric"
                  value={value.start}
                  placeholder="0"
                  maxLength={16}
                  aria-describedby={hintId}
                  aria-invalid={invalid}
                  onChange={(event) =>
                    onChange({ ...value, start: event.target.value })
                  }
                />
              </label>
              <label>
                <span>{labels.checksumEnd}</span>
                <Input
                  inputMode="numeric"
                  value={value.end}
                  maxLength={16}
                  aria-describedby={hintId}
                  aria-invalid={invalid}
                  onChange={(event) =>
                    onChange({ ...value, end: event.target.value })
                  }
                />
              </label>
              <div>
                <label className="workbench-inline-check">
                  <input
                    type="checkbox"
                    checked={value.includeEnding}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        includeEnding: event.target.checked,
                      })
                    }
                  />
                  {labels.checksumIncludeEnding}
                </label>
              </div>
              <p className="text-xs text-muted-foreground" id={hintId}>
                {invalid
                  ? labels.checksumInvalidRange
                  : labels.checksumRangeHint}
              </p>
              {checksumHex && (
                <div className="workbench-form-row">
                  <span>{labels.checksumBytes}</span>
                  <output
                    className="font-mono"
                    aria-label={labels.checksumBytes}
                  >
                    {checksumHex}
                  </output>
                </div>
              )}
            </>
          )}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
