import type { RecoveryMessages } from "./zh-recovery";

export const enRecovery = {
  "recovery.title": "Startup recovery",
  "recovery.description":
    "Inspect startup problems in an isolated workspace, then schedule a reset to default settings.",
  "recovery.isolated": "Working in an isolated recovery workspace",
  "recovery.healthy": "Storage is healthy",
  "recovery.noAction":
    "Startup recovery is not needed. You can adjust or reset preferences in Settings.",
  "recovery.preserved":
    "The original settings are preserved. Current actions affect only the isolated recovery workspace. Do not manually delete application data or related files.",
  "recovery.archive": "Original files from the last recovery: {id}",
  "recovery.diagnostics": "Copy problem report",
  "recovery.copied":
    "Report copied. Check for sensitive information before sharing.",
  "recovery.schedule": "Schedule default settings recovery",
  "recovery.scheduleHint":
    "On the next startup, archive the original settings before replacing them with defaults. Interrupted or failed replacement restores the originals. Settings from a newer version will not be overwritten.",
  "recovery.pending":
    "Recovery is scheduled. The originals remain unchanged until validation and safe replacement on restart.",
  "recovery.restart": "Restart and apply recovery",
  "recovery.confirmTitle": "Schedule default settings recovery?",
  "recovery.confirmWithSettings":
    "On the next startup, archive the original settings before replacing them with defaults. The originals remain unchanged for now. Settings from a newer version will not be overwritten.",
  "recovery.confirm": "Schedule without restarting",
} satisfies RecoveryMessages;
