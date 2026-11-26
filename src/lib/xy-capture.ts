export const alignXyAction = "swb.reference.statistics.alignXY";
export const maxCapturedXySamples = 128;

export type CapturedXyChannel = {
  field: string;
  host: string;
  instance: string;
  session?: string;
  clock: string;
  clockKey: string;
  omitted: number;
  samples: readonly {
    monoNs: string;
    value: string | null;
    gapBefore?: true;
    origin: {
      frame: number;
      event: string;
      firstByte: string;
      afterByte: string;
      record?: string;
    };
  }[];
};

export type CapturedXyAxes = Partial<Record<"x" | "y", CapturedXyChannel>>;
export type CapturedXyPair = Required<CapturedXyAxes>;

export function capturedXyInput({ x, y }: CapturedXyPair) {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const sameClock = x.clockKey === y.clockKey;
  const distinctLabels = x.clock !== y.clock;
  const xClock =
    identifier.test(x.clock) && (sameClock || distinctLabels)
      ? x.clock
      : "clock-x";
  const yClock = sameClock
    ? xClock
    : identifier.test(y.clock) && distinctLabels && y.clock !== xClock
      ? y.clock
      : xClock === "clock-y"
        ? "clock-other-y"
        : "clock-y";
  const axis = (
    channel: CapturedXyChannel,
    clockId: string,
    fallback: string,
  ) => ({
    sourceId: identifier.test(channel.field) ? channel.field : fallback,
    clockId,
    samples: channel.samples.map(({ monoNs, value, gapBefore }) => ({
      monoNs,
      value,
      ...(gapBefore ? { gapBefore } : {}),
    })),
  });
  let maxGap = 1n;
  let previous: bigint | undefined;
  for (const sample of y.samples) {
    const time = BigInt(sample.monoNs);
    if (previous !== undefined && !sample.gapBefore && time - previous > maxGap)
      maxGap = time - previous;
    previous = time;
  }
  return {
    x: axis(x, xClock, "x-channel"),
    y: axis(y, yClock, "y-channel"),
    method: "exact",
    maxGapNs: String(maxGap),
  };
}
