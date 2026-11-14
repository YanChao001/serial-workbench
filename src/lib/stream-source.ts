import type { RawEvent } from "@serial-workbench/contracts";

/** 同一来源由 Host 实例、会话及会话代次共同定位。 */
export function streamSourceKey(
  source: Pick<
    RawEvent,
    "hostId" | "instanceEpoch" | "sessionId" | "sessionEpoch"
  >,
): string {
  return JSON.stringify([
    source.hostId,
    source.instanceEpoch,
    source.sessionId,
    source.sessionEpoch,
  ]);
}
