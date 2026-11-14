import type { TextEncoding } from "@serial-workbench/contracts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ENCODING_NAMES,
  isTextEncoding,
  TEXT_ENCODINGS,
} from "@/lib/text-encoding";

export function TextEncodingSelect({
  value,
  onChange,
  label,
  automatic,
  automaticValue,
  hint,
}: {
  value: TextEncoding | null;
  onChange: (encoding: TextEncoding | null) => void;
  label: string;
  automatic?: string;
  automaticValue?: string;
  hint?: string;
}) {
  return (
    <Select
      value={value ?? "auto"}
      onValueChange={(next) => {
        if (next === "auto" && automatic) onChange(null);
        else if (isTextEncoding(next)) onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        className="workbench-encoding-select"
        aria-label={label}
        title={hint}
      >
        <SelectValue>
          {value === null
            ? (automaticValue ?? automatic)
            : ENCODING_NAMES[value]}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {automatic && <SelectItem value="auto">{automatic}</SelectItem>}
        {TEXT_ENCODINGS.map((encoding) => (
          <SelectItem key={encoding} value={encoding}>
            {ENCODING_NAMES[encoding]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
