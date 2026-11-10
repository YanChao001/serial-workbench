import type { StreamItem } from "@serial-workbench/contracts";

/** 仅为浏览器呈现提供契约有效的样本，不代表真实串口回环。 */
export function workbenchStreamItems(): StreamItem[] {
  const source = {
    hostId: "workbench-gui-host",
    instanceEpoch: "1",
    sessionId: "session",
    sessionEpoch: "1",
    configurationRevision: "1",
    time: {
      clockId: "fixture-clock",
      sourceMonoNs: "1000000",
      receivedWallTime: "2026-11-10T11:22:33.456Z",
      precision: {
        source: "host_read" as const,
        resolutionNs: "1000",
        syncMethod: "none" as const,
      },
    },
  };
  const tx = {
    operationId: "ui-send",
    bytesBase64: "U1RBVFVTPw==",
    byteStart: "0",
    byteEnd: "7",
  };
  return [
    {
      kind: "source",
      event: { ...source, eventSeq: "1", kind: "tx_intent", payload: tx },
    },
    {
      kind: "source",
      event: {
        ...source,
        eventSeq: "2",
        kind: "tx",
        payload: {
          ...tx,
          sessionId: "session",
          sessionEpoch: "1",
          outcome: "accepted",
          acceptedRanges: [{ start: "0", end: "7" }],
          unknownRanges: [],
          peerAcknowledged: false,
        },
      },
    },
    {
      kind: "source",
      event: {
        ...source,
        eventSeq: "3",
        kind: "rx",
        payload: { bytesBase64: "T0sNCg==", byteStart: "0", byteEnd: "4" },
      },
    },
  ];
}
