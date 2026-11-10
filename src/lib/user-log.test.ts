import { afterEach, expect, it, vi } from "vitest";
import {
  clearUserLog,
  getUserLog,
  recordUserLog,
  subscribeUserLog,
} from "./user-log";
afterEach(clearUserLog);

it("counts new failures without counting the same delivery twice", () => {
  const fault = {
    module: "serial",
    level: "error",
    message: "Cannot open port",
    code: "ACCESS_DENIED",
    context: "COM14",
  } as const;
  recordUserLog(fault, "attempt-1");
  recordUserLog(fault, "attempt-1");
  recordUserLog(fault, "attempt-2");
  expect(getUserLog()).toHaveLength(1);
  expect(getUserLog()[0]).toMatchObject({
    count: 2,
    code: "ACCESS_DENIED",
    context: "COM14",
  });
  recordUserLog({ ...fault, context: "COM15" }, "attempt-3");
  expect(getUserLog()).toHaveLength(2);
});

it("bounds retained faults and puts the latest occurrence first", () => {
  for (let index = 0; index < 270; index++)
    recordUserLog({
      module: "application",
      level: "warning",
      message: `Fault ${index}`,
    });
  expect(getUserLog()).toHaveLength(256);
  expect(getUserLog()[0]?.message).toBe("Fault 269");
  expect(getUserLog().some((entry) => entry.message === "Fault 0")).toBe(false);
  recordUserLog({
    module: "application",
    level: "warning",
    message: "Fault 15",
  });
  expect(getUserLog()[0]).toMatchObject({ message: "Fault 15", count: 2 });
});

it("keeps snapshots stable between events and releases subscriptions", () => {
  const listener = vi.fn();
  const stop = subscribeUserLog(listener);
  const previous = getUserLog();
  expect(getUserLog()).toBe(previous);
  recordUserLog({
    module: "workspace",
    level: "info",
    message: "Configuration saved",
  });
  expect(getUserLog()).not.toBe(previous);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  clearUserLog();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(getUserLog()).toHaveLength(0);
});
