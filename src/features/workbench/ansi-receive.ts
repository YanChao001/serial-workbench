import type { StreamItem } from "@serial-workbench/contracts";
import { streamSourceKey } from "./stream-model";

type SourceEvent = Extract<StreamItem, { kind: "source" }>["event"];
export type AnsiReceive = Extract<SourceEvent, { kind: "rx" }>;

/** Work with the latest continuous receive segment of this retained snapshot. */
export function ansiReceiveTail(items: readonly StreamItem[]): AnsiReceive[] {
  const packets: AnsiReceive[] = [];
  let next: AnsiReceive | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || item.kind !== "source") break;
    const event = item.event;
    if (
      event.kind === "gap" ||
      event.kind === "lifecycle" ||
      event.kind === "configuration_boundary"
    )
      break;
    if (event.kind !== "rx") continue;
    if (
      next &&
      (event.payload.byteEnd !== next.payload.byteStart ||
        event.configurationRevision !== next.configurationRevision ||
        streamSourceKey(event) !== streamSourceKey(next))
    )
      break;
    packets.push(event);
    next = event;
  }
  return packets.reverse();
}
