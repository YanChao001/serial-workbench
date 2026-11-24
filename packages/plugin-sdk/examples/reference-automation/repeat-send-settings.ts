export const builtinRepeatSendAction = "swb.builtin.automation.repeat";
export const repeatSendAction = "swb.reference.automation.repeat";
export const repeatSendFrameBytes = 256;

export const repeatSendLimits = {
  periodMs: [10, 60_000],
  count: [1, 64],
  startDelayMs: [0, 60_000],
  startTimeoutMs: [50, 60_000],
  responseTimeoutMs: [50, 5000],
} as const;

export function repeatJitterLimit(periodMs: number) {
  return Math.floor((periodMs - 1) / 2);
}
