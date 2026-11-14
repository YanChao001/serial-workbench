import { expect, it } from "vitest";
import type {
  DeviceDescriptor,
  DeviceFingerprint,
} from "@serial-workbench/contracts";
import { session } from "./test-fixtures";
import { resolveViewDevice } from "./view-device";

function device(
  deviceId: string,
  fingerprint: Partial<DeviceFingerprint> = {},
): DeviceDescriptor {
  return {
    deviceId,
    hostId: "host-a",
    systemName: "COM5",
    fingerprint: {
      transport: "serial",
      evidence: "serialNumber",
      serialNumber: "serial-a",
      vid: 0x1234,
      pid: 0x5678,
      ...fingerprint,
    },
    capabilities: session().capabilities,
  };
}

function binding(
  deviceId: string,
  fingerprint: Partial<DeviceFingerprint> = {},
) {
  const saved = device(deviceId, fingerprint);
  return {
    hostId: saved.hostId,
    deviceId: saved.deviceId,
    fingerprint: saved.fingerprint,
  };
}

it("selects a saved COM5 port that is currently available despite changed opaque ID and weak hardware evidence", () => {
  const saved = {
    ...device("old-device-id", {
      evidence: "unreliable",
      serialNumber: undefined,
    }),
    portName: "COM5",
  };
  const current = device("new-device-id", {
    evidence: "unreliable",
    serialNumber: undefined,
    vid: 0xabcd,
  });
  expect(resolveViewDevice(saved, [current])).toBe(current);
  expect(saved.deviceId).toBe("old-device-id");
});

it("uses the last confirmed source system name when no persistent port name exists", () => {
  const saved = device("old-id", {
    evidence: "unreliable",
    serialNumber: undefined,
  });
  const current = device("new-id", { serialNumber: "replacement-hardware" });
  expect(resolveViewDevice(saved, [current])).toBe(current);
});

it("prioritizes a persistent port name over a source name and old hardware fingerprint", () => {
  const saved = {
    ...device("old-id"),
    systemName: "COM3",
    portName: "COM5",
  };
  const port = device("new-port-id", { serialNumber: "replacement-hardware" });
  const previousHardware = { ...device("old-hardware-id"), systemName: "COM3" };
  expect(
    resolveViewDevice(saved, [previousHardware, port], false, "COM3"),
  ).toBe(port);
});

it("keeps a current exact device ID ahead of an older saved port position", () => {
  const saved = { ...binding("current-id"), portName: "COM5" };
  const current = { ...device("current-id"), systemName: "COM9" };
  expect(resolveViewDevice(saved, [device("other-id"), current])).toBe(current);
});

it("uses a legacy view name as a port hint only when no explicit locator exists", () => {
  const saved = binding("old-id", {
    evidence: "unreliable",
    serialNumber: undefined,
  });
  const current = device("new-id");
  expect(resolveViewDevice(saved, [current], false, "COM5")).toBe(current);
  expect(
    resolveViewDevice({ ...saved, portName: "COM3" }, [current], false, "COM5"),
  ).toBeUndefined();
  expect(
    resolveViewDevice(
      { ...saved, systemName: "COM3" },
      [current],
      false,
      "COM5",
    ),
  ).toBeUndefined();
  expect(
    resolveViewDevice(saved, [current], false, "Controller"),
  ).toBeUndefined();
});

it("keeps a unique strong hardware match ahead of a legacy view-name hint", () => {
  const saved = binding("old-id");
  const current = { ...device("new-id"), systemName: "COM9" };
  const legacyPort = device("legacy-port", {
    serialNumber: "replacement-hardware",
  });
  expect(resolveViewDevice(saved, [legacyPort, current], false, "COM5")).toBe(
    current,
  );
  expect(resolveViewDevice({ ...saved, portName: "COM3" }, [current])).toBe(
    current,
  );
});

it.each(["com5", "CoM5", "COM5"])(
  "matches a Windows port locator case-insensitively: %s",
  (portName) => {
    const saved = binding("old-id", { evidence: "unreliable" });
    const current = device("new-id");
    expect(resolveViewDevice({ ...saved, portName }, [current])).toBe(current);
    expect(resolveViewDevice(saved, [current], false, portName)).toBe(current);
  },
);

it("keeps POSIX port names case-sensitive and does not normalize Windows port numbers", () => {
  const saved = binding("old-id", { evidence: "unreliable" });
  const current = { ...device("new-id"), systemName: "/dev/ttyUSB0" };
  expect(
    resolveViewDevice({ ...saved, portName: "/dev/ttyUSB0" }, [current]),
  ).toBe(current);
  expect(
    resolveViewDevice({ ...saved, portName: "/dev/ttyusb0" }, [current]),
  ).toBeUndefined();
  expect(
    resolveViewDevice({ ...saved, portName: "COM05" }, [device("new-id")]),
  ).toBeUndefined();
});

it("does not resolve a port locator from stale, foreign or different-transport entries", () => {
  const saved = {
    ...binding("old-id", { evidence: "unreliable" }),
    portName: "COM5",
  };
  const current = device("new-id");
  expect(resolveViewDevice(saved, [current], true)).toBeUndefined();
  expect(
    resolveViewDevice(saved, [{ ...current, hostId: "another-host" }]),
  ).toBeUndefined();
  expect(
    resolveViewDevice(saved, [device("new-id", { transport: "pty" })]),
  ).toBeUndefined();
});

it("does not guess among duplicate port names even if an old fingerprint matches one", () => {
  const saved = { ...binding("old-id"), portName: "COM5" };
  const first = device("first-id");
  const second = {
    ...device("second-id", { serialNumber: "other" }),
    systemName: "com5",
  };
  expect(resolveViewDevice(saved, [first, second])).toBeUndefined();
  expect(resolveViewDevice(saved, [second, first])).toBeUndefined();
  expect(
    resolveViewDevice(
      binding("old-id", { evidence: "unreliable" }),
      [first, second],
      false,
      "COM5",
    ),
  ).toBeUndefined();
});

it("ignores another Host's identically named port when the local port is unique", () => {
  const saved = {
    ...binding("old-id", { evidence: "unreliable" }),
    portName: "COM5",
  };
  const current = device("new-id");
  const foreign = { ...device("foreign-id"), hostId: "another-host" };
  expect(resolveViewDevice(saved, [foreign, current])).toBe(current);
});

it("restores a uniquely identified serial device after its directory ID changes without relying on the COM name", () => {
  const saved = binding("old-device-id");
  const current = { ...device("new-device-id"), systemName: "COM9" };
  expect(resolveViewDevice(saved, [current])).toBe(current);
  expect(saved.deviceId).toBe("old-device-id");
});

it("prefers the current exact Host and device ID even when discovery is stale", () => {
  const saved = binding("current-id");
  const exact = device("current-id", {
    evidence: "unreliable",
    serialNumber: undefined,
  });
  const plausible = device("another-id");
  expect(resolveViewDevice(saved, [plausible, exact], true)).toBe(exact);
});

it("does not guess from a missing saved view, absent device or stale discovery", () => {
  const saved = binding("old-id");
  const current = device("new-id");
  expect(resolveViewDevice(undefined, [current])).toBeUndefined();
  expect(resolveViewDevice(saved, [])).toBeUndefined();
  expect(resolveViewDevice(saved, [current], true)).toBeUndefined();
});

it("does not accept an exact device ID or matching fingerprint from another Host", () => {
  const saved = binding("same-id");
  const foreign = { ...device("same-id"), hostId: "another-host" };
  expect(resolveViewDevice(saved, [foreign])).toBeUndefined();
});

it.each([
  { evidence: "serialNumber", serialNumber: undefined },
  { evidence: "serialNumber", vid: undefined },
  { evidence: "serialNumber", pid: undefined },
  { evidence: "topology", serialNumber: undefined },
] satisfies Partial<DeviceFingerprint>[])(
  "keeps a second plausible device with unknown identity fields ambiguous: %j",
  (fingerprint) => {
    const saved = binding("old-id");
    const current = device("new-id");
    const unknown = device("uncertain-id", fingerprint);
    expect(resolveViewDevice(saved, [current, unknown])).toBeUndefined();
    expect(resolveViewDevice(saved, [unknown, current])).toBeUndefined();
  },
);

it("does not use topology to discard another plausible serial-number candidate", () => {
  const saved = binding("old-id", { topologyPath: "usb/1" });
  const current = device("new-id", { topologyPath: "usb/1" });
  const another = device("another-id", { topologyPath: "usb/2" });
  expect(resolveViewDevice(saved, [current, another])).toBeUndefined();
});

it("does not collapse duplicate plausible descriptors before testing uniqueness", () => {
  const saved = binding("old-id");
  const current = device("new-id");
  expect(resolveViewDevice(saved, [current, { ...current }])).toBeUndefined();
});

const insufficientIdentity: {
  name: string;
  saved?: Partial<DeviceFingerprint>;
  found?: Partial<DeviceFingerprint>;
}[] = [
  { name: "different transport", found: { transport: "pty" } },
  { name: "saved topology evidence", saved: { evidence: "topology" } },
  { name: "found topology evidence", found: { evidence: "topology" } },
  { name: "saved unreliable evidence", saved: { evidence: "unreliable" } },
  { name: "found unreliable evidence", found: { evidence: "unreliable" } },
  { name: "different serial", found: { serialNumber: "another-serial" } },
  { name: "absent saved serial", saved: { serialNumber: undefined } },
  { name: "absent found serial", found: { serialNumber: undefined } },
  { name: "blank saved serial", saved: { serialNumber: " \t" } },
  { name: "blank found serial", found: { serialNumber: "" } },
  { name: "serial whitespace differs", saved: { serialNumber: " serial-a " } },
  { name: "different vendor", found: { vid: 0xabcd } },
  { name: "missing known vendor", found: { vid: undefined } },
  { name: "different product", found: { pid: 0xabcd } },
  { name: "missing known product", found: { pid: undefined } },
  {
    name: "missing zero-valued vendor",
    saved: { vid: 0 },
    found: { vid: undefined },
  },
  {
    name: "missing zero-valued product",
    saved: { pid: 0 },
    found: { pid: undefined },
  },
  { name: "only saved topology", saved: { topologyPath: "usb/1" } },
  { name: "only found topology", found: { topologyPath: "usb/1" } },
  {
    name: "different topology",
    saved: { topologyPath: "usb/1" },
    found: { topologyPath: "usb/2" },
  },
];

it.each(insufficientIdentity)(
  "does not infer a port location from $name without a saved locator or legacy hint",
  ({ saved: savedFingerprint, found }) => {
    expect(
      resolveViewDevice(binding("old-id", savedFingerprint), [
        device("new-id", found),
      ]),
    ).toBeUndefined();
  },
);

it("allows stronger current VID and PID evidence when neither was saved", () => {
  const saved = binding("old-id", { vid: undefined, pid: undefined });
  const current = device("new-id");
  expect(resolveViewDevice(saved, [current])).toBe(current);
});

it("uses the Host's Unicode whitespace evidence instead of JavaScript trimming rules", () => {
  const blankSerial = device("new-id", { serialNumber: "\u0085" });
  expect(
    resolveViewDevice(binding("old-id", { serialNumber: "\u0085" }), [
      blankSerial,
    ]),
  ).toBeUndefined();
  const current = device("new-id");
  expect(
    resolveViewDevice(binding("old-id", { topologyPath: "\u0085" }), [current]),
  ).toBe(current);
  expect(
    resolveViewDevice(binding("old-id", { topologyPath: "\uFEFF" }), [current]),
  ).toBeUndefined();
  const nonWhitespaceSerial = device("new-id", { serialNumber: "\uFEFF" });
  expect(
    resolveViewDevice(binding("old-id", { serialNumber: "\uFEFF" }), [
      nonWhitespaceSerial,
    ]),
  ).toBe(nonWhitespaceSerial);
});

it.each([
  { saved: "usb/1", found: "usb/1" },
  { saved: " \t", found: undefined },
  { saved: undefined, found: " " },
])("accepts matching or jointly absent topology: %j", ({ saved, found }) => {
  const current = device("new-id", { topologyPath: found });
  expect(
    resolveViewDevice(binding("old-id", { topologyPath: saved }), [current]),
  ).toBe(current);
});

it("ignores incompatible or foreign candidates without changing the input descriptors", () => {
  const saved = binding("old-id");
  const current = Object.freeze(device("new-id"));
  const devices = Object.freeze([
    device("different-serial", { serialNumber: "another-serial" }),
    device("different-transport", { transport: "pty" }),
    { ...device("foreign-id"), hostId: "another-host" },
    current,
  ]);
  expect(resolveViewDevice(saved, devices)).toBe(current);
  expect(current.deviceId).toBe("new-id");
  expect(saved.deviceId).toBe("old-id");
});
