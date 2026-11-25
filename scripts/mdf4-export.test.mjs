import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-mdf4/main.ts";

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../packages/plugin-sdk/examples/reference-mdf4/manifest.json",
      import.meta.url,
    ),
  ),
);
const action = new Map();
register({ actions: { register: (id, handler) => action.set(id, handler) } });
const exportMdf4 = (params, signal = new AbortController().signal) =>
  Buffer.from(
    action.get("swb.pro.mdf4.exportMdf4")({ params }, { signal }),
    "base64",
  );
const channels = [
  { name: "voltage", type: "float64", unit: "V" },
  { name: "source_byte", type: "uint64", unit: "byte" },
  { name: "raw_count", type: "int64" },
  { name: "temperature", type: "float64", unit: "°C" },
];
const example = {
  startTimeNs: "1700000012345678901",
  channels,
  samples: [
    {
      elapsedNs: "0",
      values: ["-1.25", "9007199254740993", "-9223372036854775808", "22.5"],
    },
    { elapsedNs: "33333333", values: [null, "9007199254740995", "-7", null] },
    {
      elapsedNs: "900000007",
      values: ["3.5", "18446744073709551615", "9223372036854775807", "25"],
    },
  ],
};

test("the MDF4 professional action follows its signed package manifest and bounds the artifact", () => {
  assert.ok(validateNodePackageManifest(manifest));
  assert.deepEqual(
    [...action.keys()],
    manifest.contributes.actions.map((item) => item.actionId),
  );
  assert.equal(
    manifest.contributes.actions[0].outputSchema["x-swb-file-result"],
    "application/x-asam-mdf",
  );
  const output = exportMdf4(example);
  assert.deepEqual(output, exportMdf4(example));
  assert.equal(output.subarray(0, 16).toString("ascii"), "MDF     4.10    ");
  assert.equal(output.readUInt16LE(28), 410);
  assert.equal(output.subarray(64, 68).toString("ascii"), "##HD");
  const maximal = Array.from({ length: 16 }, (_, i) => ({
    name: "long_channel_" + String(i).padEnd(51, "_"),
    unit: "温".repeat(32),
    type: "uint64",
  }));
  const large = exportMdf4({
    startTimeNs: "1",
    channels: maximal,
    samples: Array.from({ length: 256 }, (_, i) => ({
      elapsedNs: String(i),
      values: maximal.map((_, column) =>
        (i + column) % 2 ? null : "18446744073709551615",
      ),
    })),
  });
  assert.ok(large.length < 64 * 1024);
});

test("MDF4 rejects ambiguous times, names, unsafe integer coercion, and non-finite values", () => {
  assert.throws(
    () => exportMdf4({ ...example, startTimeNs: "18446744073709551615" }),
    /timestamps exceed/,
  );
  assert.throws(
    () => exportMdf4({ ...example, samples: [...example.samples].reverse() }),
    /backwards/,
  );
  assert.throws(
    () =>
      exportMdf4({ ...example, channels: [{ name: "time", type: "uint64" }] }),
    /channel name/,
  );
  assert.throws(
    () =>
      exportMdf4({
        ...example,
        samples: [{ elapsedNs: "0", values: ["1.5", 2, "-1", "20"] }],
      }),
    /decimal strings/,
  );
  assert.throws(
    () =>
      exportMdf4({
        ...example,
        samples: [{ elapsedNs: "0", values: ["1e999", "2", "-1", "20"] }],
      }),
    /outside/,
  );
  assert.throws(
    () =>
      exportMdf4({
        ...example,
        samples: [
          { elapsedNs: "0", values: ["1.5", "2", "9223372036854775808", "20"] },
        ],
      }),
    /64-bit range/,
  );
  assert.throws(() => exportMdf4(example, AbortSignal.abort()), {
    name: "AbortError",
  });
});

const reader = process.env.SWB_MDF4_READER_ROOT;
test(
  "independent asammdf reads channels, invalidation, exact integers, and times",
  {
    skip: reader
      ? false
      : "Set SWB_MDF4_READER_ROOT to an isolated asammdf installation",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "swb-mdf4-"));
    try {
      const file = join(directory, "measurement.mf4");
      writeFileSync(file, exportMdf4(example));
      const script = `
import math
import sys
sys.path.insert(0, sys.argv[1])
from asammdf import MDF, __version__
with MDF(sys.argv[2]) as measurement:
    assert measurement.version == "4.10"
    assert measurement.header.abs_time == 1700000012345678901
    voltage = measurement.get("voltage", ignore_invalidation_bits=True)
    assert voltage.unit == "V"
    assert voltage.samples.tolist() == [-1.25, 0.0, 3.5]
    assert voltage.invalidation_bits.tolist() == [False, True, False]
    assert measurement.get("voltage").samples.tolist() == [-1.25, 3.5]
    assert all(math.isclose(a, b, rel_tol=0, abs_tol=1e-12) for a, b in zip(voltage.timestamps.tolist(), [0, 0.033333333, 0.900000007], strict=True))
    source = measurement.get("source_byte", ignore_invalidation_bits=True)
    assert source.samples.tolist() == [9007199254740993, 9007199254740995, 18446744073709551615]
    assert measurement.get("raw_count").samples.tolist() == [-9223372036854775808, -7, 9223372036854775807]
    assert measurement.get("elapsed_ns").samples.tolist() == [0, 33333333, 900000007]
    temperature = measurement.get("temperature", ignore_invalidation_bits=True)
    assert temperature.unit == "\\u00b0C"
    assert temperature.invalidation_bits.tolist() == [False, True, False]
    print("asammdf " + __version__ + " read MDF 4.10 independently")
`;
      const result = spawnSync("python", ["-I", "-", reader, file], {
        input: script,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /asammdf .* read MDF 4\.10 independently/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
