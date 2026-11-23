import type { TextEncoding } from "@serial-workbench/contracts";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ENCODING_NAMES,
  isTextEncoding,
  TEXT_ENCODINGS,
} from "@/lib/text-encoding";
import type { EncodingDetection } from "@/lib/encoding-detection";

type EncodingEvidenceLabels = Record<
  | "encodingCandidates"
  | "encodingSampleBytes"
  | "encodingEvidencePending"
  | "encodingEvidenceBom"
  | "encodingEvidenceUtf8"
  | "encodingEvidenceGuess",
  string
>;

export function TextEncodingSelect({
  value,
  onChange,
  onOpenChange,
  label,
  automatic,
  automaticValue,
  hint,
  evidence,
  disabled,
}: {
  value: TextEncoding | null;
  onChange: (encoding: TextEncoding | null) => void;
  onOpenChange?: (open: boolean) => void;
  label: string;
  automatic?: string;
  automaticValue?: string;
  hint?: string;
  evidence?: { detection: EncodingDetection; labels: EncodingEvidenceLabels };
  disabled?: boolean;
}) {
  const candidates = evidence?.detection.candidates ?? [];
  return (
    <Select
      disabled={disabled}
      value={value ?? "auto"}
      onOpenChange={onOpenChange}
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
        {evidence && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel className="max-w-64">
                {evidence.labels.encodingCandidates}
                <span className="text-muted-foreground block">
                  {evidence.labels.encodingSampleBytes}{" "}
                  {evidence.detection.sampleBytes}
                  {evidence.detection.reason === "pending" &&
                    ` · ${evidence.labels.encodingEvidencePending}`}
                </span>
              </SelectLabel>
              {candidates.map(({ encoding, reason, confidence }) => {
                const name = ENCODING_NAMES[encoding];
                const detail = {
                  bom: evidence.labels.encodingEvidenceBom,
                  utf8: evidence.labels.encodingEvidenceUtf8,
                  guess: `${evidence.labels.encodingEvidenceGuess} ${confidence}/100`,
                }[reason];
                return (
                  <SelectItem
                    key={encoding}
                    value={encoding}
                    textValue={name}
                    aria-label={name}
                    aria-description={detail}
                  >
                    {name}
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground text-xs"
                    >
                      {detail}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectGroup>
            <SelectSeparator />
          </>
        )}
        {TEXT_ENCODINGS.filter(
          (encoding) =>
            !candidates.some((candidate) => candidate.encoding === encoding),
        ).map((encoding) => (
          <SelectItem key={encoding} value={encoding}>
            {ENCODING_NAMES[encoding]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
