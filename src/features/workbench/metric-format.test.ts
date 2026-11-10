import { expect, it } from "vitest";
import { formatByteSize, formatElapsedTime } from "./metric-format";

it.each([
  ["0", "0 B"],
  ["999", "999 B"],
  ["1000", "1.00 KB"],
  ["169332736", "169.33 MB"],
  ["9007199254740999", "9.01 PB"],
  ["18446744073709551615", "18.45 EB"],
])("formats exact wire bytes %s for display", (bytes, expected) => {
  expect(formatByteSize(bytes)).toBe(expected);
});

it("keeps unavailable observations distinct from a real zero", () => {
  expect(formatByteSize(undefined)).toBe("—");
  expect(formatByteSize(null)).toBe("—");
  expect(formatByteSize("0")).toBe("0 B");
});

it.each([
  ["0", "00:00:00"],
  ["999", "00:00:00"],
  ["90061001", "25:01:01"],
  ["18446744073709551615", "5124095576030:25:51"],
])(
  "formats an elapsed duration %s without a date rollover",
  (milliseconds, expected) => {
    expect(formatElapsedTime(milliseconds)).toBe(expected);
  },
);
