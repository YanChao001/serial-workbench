import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import type { MappedReceiveRow } from "./mapped-receive";

function visibleText(text: string) {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
    if (character === "\r" || character === "\n" || character === "\t")
      return character;
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped === character
      ? "\\u{" + character.codePointAt(0)?.toString(16) + "}"
      : escaped;
  });
}

export function MappedReceiveView({
  projection,
  style,
  onReveal,
}: {
  projection: { rows: MappedReceiveRow[]; limited: boolean };
  style: CSSProperties;
  onReveal: (itemIndex: number, start: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="workbench-remap-output">
      {projection.limited && (
        <p className="workbench-remap-status">
          {t("characterRemap.receiveLimited")}
        </p>
      )}
      {projection.rows.length === 0 && (
        <p className="workbench-remap-status">
          {t("characterRemap.receiveEmpty")}
        </p>
      )}
      {projection.rows.map((row) => {
        if (row.kind === "gap")
          return (
            <p
              key={"gap-" + row.key}
              className="workbench-remap-status workbench-gap"
            >
              {t("characterRemap.receiveGap")}
            </p>
          );
        const events =
          row.firstEvent === row.lastEvent
            ? row.firstEvent
            : row.firstEvent + "–" + row.lastEvent;
        const range = t(
          row.firstEvent === row.lastEvent
            ? "characterRemap.receiveRange"
            : "characterRemap.receiveRanges",
          { start: row.start, end: row.end, events },
        );
        return (
          <div
            key={row.reference}
            role="group"
            aria-label={range}
            className="workbench-remap-result"
          >
            <div className="workbench-remap-result-header">
              <span>{range}</span>
              {row.start !== row.end && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReveal(row.firstItem, row.start)}
                >
                  {t("characterRemap.originalBytes")}
                </Button>
              )}
            </div>
            {row.result.ok && row.result.text ? (
              <div
                data-rx-mapped-text=""
                className="workbench-payload"
                style={style}
              >
                {visibleText(row.result.text)}
              </div>
            ) : (
              <p className="workbench-remap-status">
                {t(
                  row.result.ok
                    ? "characterRemap.receiveMappedEmpty"
                    : "characterRemap.receiveOutputLimit",
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
