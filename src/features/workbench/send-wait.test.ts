import { expect, it } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import { sendWaitMs } from "./send-wait";

it("budgets 3576 and 10000 bytes at 9600 baud instead of timing out after one second", () => {
  const configuration = { ...defaults.serialConfiguration, baudRate: "9600" };
  expect(sendWaitMs(configuration, 3576)).toBe("4725");
  expect(sendWaitMs(configuration, 10000)).toBe("13022");
});

it("includes data, parity and stop bits and retains explicit fixed timeouts", () => {
  const configuration = {
    ...defaults.serialConfiguration,
    baudRate: "1200",
    dataBits: "7",
    parity: "even",
    stopBits: "two",
    writeWaitMs: "7",
  } as const;
  expect(sendWaitMs(configuration, 1200)).toBe("13750");
  expect(sendWaitMs(configuration, 1200, "fixed")).toBe("7");
  expect(sendWaitMs({ ...configuration, stopBits: "onePointFive" }, 1200)).toBe(
    "13125",
  );
});

it("bounds the budget without converting U64 baud rates to imprecise JS numbers", () => {
  expect(
    sendWaitMs(
      { ...defaults.serialConfiguration, baudRate: "18446744073709551615" },
      16384,
    ),
  ).toBe("1001");
  expect(
    sendWaitMs({ ...defaults.serialConfiguration, baudRate: "1" }, 16384),
  ).toBe("204800000");
});
