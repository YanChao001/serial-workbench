import { HostRequestError } from "@serial-workbench/host-client";
import type { Translate } from "@/i18n/translate";
import type { MessageKey } from "@/i18n/zh-CN";

const fields = {
  options: "rfc2217Connection.options",
  binary: "rfc2217Connection.binary",
  comPort: "rfc2217Connection.comPort",
  baudRate: "workbench.tools.baudRate",
  dataBits: "workbench.tools.dataBits",
  parity: "workbench.tools.parity",
  stopBits: "workbench.tools.stopBits",
  flowControl: "workbench.tools.flowControl",
  dtr: "rfc2217Connection.dtr",
  rts: "rfc2217Connection.rts",
} as const satisfies Record<string, MessageKey>;

type Field = keyof typeof fields;
type Setting = Exclude<Field, "options" | "binary" | "comPort">;

export type Rfc2217OpenDiagnostic =
  | { reason: "refused"; field: "binary" | "comPort" }
  | { reason: "timeout" | "disconnected"; field: Field }
  | { reason: "invalid_reply"; field: Setting; requested: number }
  | {
      reason: "different_value";
      field: Setting;
      requested: number;
      reported: number;
    };

function setting(field: Field): field is Setting {
  return field !== "options" && field !== "binary" && field !== "comPort";
}

function value(field: Setting, input: unknown): number | undefined {
  return typeof input === "number" &&
    Number.isInteger(input) &&
    input >= 0 &&
    input <= (field === "baudRate" ? 0xffff_ffff : 0xff)
    ? input
    : undefined;
}

export function rfc2217OpenDiagnostic(
  error: unknown,
): Rfc2217OpenDiagnostic | undefined {
  if (
    !(error instanceof HostRequestError) ||
    error.code !== "PLUGIN_TRANSPORT_OPEN_FAILED"
  )
    return undefined;
  const detail = error.details.details;
  if (
    detail?.protocol !== "rfc2217" ||
    typeof detail.field !== "string" ||
    !Object.hasOwn(fields, detail.field)
  )
    return undefined;
  const field = detail.field as Field;
  const { reason } = detail;
  if (reason === "refused")
    return field === "binary" || field === "comPort"
      ? { reason, field }
      : undefined;
  if (reason === "timeout" || reason === "disconnected")
    return { reason, field };
  if (!setting(field)) return undefined;
  const requested = value(field, detail.requestedValue);
  if (requested === undefined) return undefined;
  if (reason === "invalid_reply") return { reason, field, requested };
  const reported = value(field, detail.reportedValue);
  if (
    reason === "different_value" &&
    reported !== undefined &&
    requested !== reported
  )
    return { reason, field, requested, reported };
  return undefined;
}

const settingValues: Partial<Record<Setting, Record<number, MessageKey>>> = {
  parity: {
    1: "workbench.tools.none",
    2: "workbench.tools.odd",
    3: "workbench.tools.even",
    4: "workbench.tools.mark",
    5: "workbench.tools.space",
  },
  stopBits: {
    1: "workbench.tools.one",
    2: "workbench.tools.two",
    3: "workbench.tools.onePointFive",
  },
  flowControl: {
    1: "rfc2217Connection.noFlowControl",
    2: "workbench.tools.xonXoff",
    3: "workbench.tools.rtsCts",
  },
  dtr: { 8: "rfc2217Connection.set", 9: "rfc2217Connection.clear" },
  rts: { 11: "rfc2217Connection.set", 12: "rfc2217Connection.clear" },
};

function settingText(field: Setting, value: number, t: Translate): string {
  if (field === "baudRate")
    return t("rfc2217Connection.baudReading", { value });
  if (field === "dataBits") return String(value);
  const label = settingValues[field]?.[value];
  return label
    ? t(label)
    : "0x" + value.toString(16).toUpperCase().padStart(2, "0");
}

export function rfc2217OpenDiagnosticText(
  diagnostic: Rfc2217OpenDiagnostic,
  t: Translate,
): string {
  const field = t(fields[diagnostic.field]);
  switch (diagnostic.reason) {
    case "refused":
      return t("rfc2217Connection.refused", { field });
    case "timeout":
      return t("rfc2217Connection.timeout", { field });
    case "disconnected":
      return t("rfc2217Connection.disconnected", { field });
    case "invalid_reply":
      return t("rfc2217Connection.invalidReply", {
        field,
        requested: settingText(diagnostic.field, diagnostic.requested, t),
      });
    case "different_value":
      return t("rfc2217Connection.differentValue", {
        field,
        requested: settingText(diagnostic.field, diagnostic.requested, t),
        reported: settingText(diagnostic.field, diagnostic.reported, t),
      });
  }
}
