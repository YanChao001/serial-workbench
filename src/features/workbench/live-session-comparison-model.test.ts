import { expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import {
  liveReceiveRows,
  matchLiveReceiveRow,
} from "./live-session-comparison-model";

const first = {
  hostId: "host",
  instanceEpoch: "1",
  sessionId: "left",
  sessionEpoch: "1",
};
const second = { ...first, sessionId: "right" };
function rx(
  source: typeof first,
  eventSeq: string,
  byteStart: string,
  byteEnd: string,
  ns: string,
  clockId = "source-clock",
): StreamItem {
  return {
    kind: "source",
    event: {
      ...source,
      kind: "rx",
      eventSeq,
      configurationRevision: "1",
      time: {
        clockId,
        sourceMonoNs: ns,
        receivedWallTime: "2026-11-10T11:22:33Z",
        precision: {
          source: "host_read",
          resolutionNs: "1000",
          syncMethod: "none",
        },
      },
      payload: { byteStart, byteEnd, bytesBase64: "AA==" },
    },
  };
}

it("matches only the exact event number or a containing half-open offset with 64-bit precision", () => {
  const [anchor] = liveReceiveRows(
    [rx(first, "41", "9007199254740999", "9007199254741000", "10")],
    first,
  );
  const rows = liveReceiveRows(
    [
      rx(
        { ...second, sessionEpoch: "0" },
        "41",
        "9007199254740999",
        "9007199254741000",
        "10",
      ),
      rx(second, "42", "9007199254740998", "9007199254740999", "20"),
      rx(second, "43", "9007199254740999", "9007199254741000", "30"),
    ],
    second,
  );
  expect(rows).toHaveLength(2);
  expect(matchLiveReceiveRow(anchor!, rows, "event")).toBeUndefined();
  expect(matchLiveReceiveRow(anchor!, rows, "offset")).toEqual({
    key: "43:9007199254740999",
  });
});

it("matches nearby time only within a continuous same-clock bracket and reports the signed difference", () => {
  const [anchor] = liveReceiveRows(
    [rx(first, "2", "1", "2", "110000000")],
    first,
  );
  const earlier = rx(second, "4", "2", "3", "90000000");
  const later = rx(second, "5", "3", "4", "111000000");
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      ...second,
      reason: "network_loss",
      missingEventRange: { start: "4", end: "5" },
    },
  };
  expect(
    matchLiveReceiveRow(
      anchor!,
      liveReceiveRows([earlier, later], second),
      "time",
    ),
  ).toEqual({
    key: "5:3",
    timeDeltaNs: 1000000n,
  });
  expect(
    matchLiveReceiveRow(
      anchor!,
      liveReceiveRows([earlier, gap, later], second),
      "time",
    ),
  ).toBeUndefined();
  expect(
    matchLiveReceiveRow(anchor!, liveReceiveRows([later], second), "time"),
  ).toBeUndefined();
  expect(
    matchLiveReceiveRow(
      anchor!,
      liveReceiveRows(
        [earlier, rx(second, "5", "3", "4", "111000000", "different-clock")],
        second,
      ),
      "time",
    ),
  ).toBeUndefined();
});

it("rejects out-of-tolerance records but accepts exact observed time at a boundary", () => {
  const [anchor] = liveReceiveRows(
    [rx(first, "2", "1", "2", "200000000")],
    first,
  );
  expect(
    matchLiveReceiveRow(
      anchor!,
      liveReceiveRows(
        [
          rx(second, "1", "0", "1", "1000000"),
          rx(second, "2", "1", "2", "500000000"),
        ],
        second,
      ),
      "time",
    ),
  ).toBeUndefined();
  expect(
    matchLiveReceiveRow(
      anchor!,
      liveReceiveRows([rx(second, "41", "0", "1", "200000000")], second),
      "time",
    ),
  ).toEqual({
    key: "41:0",
    timeDeltaNs: 0n,
  });
});
