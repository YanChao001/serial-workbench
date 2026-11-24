import assert from "node:assert/strict";
import test from "node:test";
import {
  nmeaLimits,
  parseNmeaText,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/nmea.ts";

// Fixed wire vectors are also checked independently of the parser's XOR function.
const gga = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";
const rmc =
  "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A";
const gsa = "$GPGSA,A,3,23,29,07,08,09,18,26,28,,,,,1.94,1.18,1.54,1*10";
const gsv = "$GPGSV,3,1,09,09,,,17,10,,,40,12,,,49,13,,,35,1*6F";
const vtg = "$GPVTG,77.52,T,,M,0.004,N,0.008,K,A*06";

function wire(body) {
  let xor = 0;
  for (const character of body) xor ^= character.charCodeAt(0);
  return "$" + body + "*" + xor.toString(16).padStart(2, "0");
}

const field = (line, id) => line.fields.find((entry) => entry.id === id);
const value = (line, id) => field(line, id)?.value;

test("fixed vectors for all five NMEA sentence types retain independently checked wire byte spans", () => {
  const vectors = [gga, rmc, gsa, gsv, vtg];
  const report = parseNmeaText(vectors.join("\r\n") + "\r\n");
  assert.equal(report.status, "parsed");
  assert.deepEqual(
    report.lines.map(({ status, talker, type }) => [status, talker, type]),
    ["GGA", "RMC", "GSA", "GSV", "VTG"].map((type) => ["decoded", "GP", type]),
  );
  for (const [lineIndex, line] of report.lines.entries()) {
    assert.equal(line.line, lineIndex + 1);
    for (const entry of line.fields)
      assert.equal(vectors[lineIndex].slice(entry.start, entry.end), entry.raw);
  }
  const [fix, position, dop, visibility, speed] = report.lines;
  assert.deepEqual(field(fix, "latitude"), {
    id: "latitude",
    value: 48 + 7.038 / 60,
    raw: "4807.038,N",
    start: 14,
    end: 24,
    unit: "deg",
  });
  assert.equal(value(fix, "altitude"), 545.4);
  assert.equal(value(fix, "differentialStationId"), null);
  assert.equal(value(position, "utcDate"), "23-03-94");
  assert.equal(value(position, "magneticVariationDirection"), "W");
  assert.equal(value(dop, "satelliteId[3]"), 7);
  assert.equal(value(dop, "satelliteId[9]"), null);
  assert.equal(value(dop, "systemId"), 1);
  assert.equal(value(visibility, "totalMessages"), 3);
  assert.equal(value(visibility, "satellitesInView"), 9);
  assert.equal(value(visibility, "elevation[1]"), null);
  assert.equal(value(visibility, "signalStrength[4]"), 35);
  assert.equal(value(speed, "magneticCourse"), null);
  assert.equal(value(speed, "speedKilometers"), 0.008);
  // The u-blox GSA example prints 0D, but the XOR of that exact body is 10.
  assert.equal(
    parseNmeaText(gsa.slice(0, -2) + "0D").lines[0].path,
    "checksum",
  );
});

test("legacy and current tails, signed coordinates and invalid fixes keep receiver semantics", () => {
  const samples = [
    wire("GNRMC,235960.123,A,9000.0,S,18000.0,W,0.0,359.99,290200,,,R,V"),
    wire("GNGGA,,,,,,0,00,,,M,,M,,"),
    wire("GNRMC,082100,V,,,,,,,060426,,,N,V"),
    wire("GLGSV,1,1,02,65,-3,150,,69,50,66,22"),
    wire("GBGSV,1,1,00,A"),
    wire("GNVTG,,T,,M,,N,,K"),
    wire("GNGSA,A,1" + ",".repeat(15)),
    wire(
      "GNGGA,235959.999999,2717.1234567,S,15307.1234567,E,4,21,0.987,12345.678,M,-51.123,M,1.1,0001",
    ),
  ];
  const report = parseNmeaText(samples.join("\n"));
  assert.ok(report.lines.every((entry) => entry.status === "decoded"));
  const [
    modern,
    noFix,
    invalid,
    legacyGsv,
    emptyGsv,
    legacyVtg,
    legacyGsa,
    precise,
  ] = report.lines;
  assert.equal(value(modern, "utcTime"), "23:59:60.123");
  assert.equal(value(modern, "latitude"), -90);
  assert.equal(value(modern, "longitude"), -180);
  assert.equal(value(modern, "positionMode"), "R");
  assert.equal(value(modern, "navigationStatus"), "V");
  assert.equal(value(noFix, "fixQuality"), 0);
  assert.equal(value(noFix, "latitude"), null);
  assert.equal(value(invalid, "dataStatus"), "V");
  assert.equal(value(invalid, "utcDate"), "06-04-26");
  assert.equal(value(legacyGsv, "signalId"), undefined);
  assert.equal(value(legacyGsv, "elevation[1]"), -3);
  assert.equal(value(emptyGsv, "signalId"), 10);
  assert.equal(value(legacyVtg, "positionMode"), undefined);
  assert.equal(value(legacyGsa, "hdop"), null);
  assert.equal(value(precise, "differentialStationId"), "0001");
  assert.equal(value(precise, "geoidSeparation"), -51.123);
});

test("invalid and unsupported lines are independent of following supported sentences", () => {
  const damaged = gga.slice(0, -2) + "00";
  const badCoordinate = wire(gga.slice(1, -3).replace("4807.038", "4860.000"));
  const samples = [
    damaged,
    "",
    wire("GPZDA,081946,30,09,2002,00,00"),
    badCoordinate,
    wire("GPGSV,2,3,09,01,31,12,42"),
    wire("GPGSV,1,1,04,22,24"),
    wire("GPVTG,0,M,,M,1,N,2,K"),
    wire("GNRMC,225960,V,,,,,,,310426,,,N,V"),
    wire("GNRMC,225959,V,,,,,,,310426,,,N,V"),
    "NMEA\t",
    "$" + "x".repeat(nmeaLimits.sentence),
    gga,
  ];
  const report = parseNmeaText(samples.join("\n")).lines;
  assert.deepEqual(
    report.map(({ line, status, path }) => [line, status, path]),
    [
      [1, "invalid", "checksum"],
      [3, "unsupported", undefined],
      [4, "invalid", "latitude"],
      [5, "invalid", "messageNumber"],
      [6, "invalid", "satellites"],
      [7, "invalid", "trueCourseUnit"],
      [8, "invalid", "utcTime"],
      [9, "invalid", "utcDate"],
      [10, "invalid", "ascii"],
      [11, "invalid", "length"],
      [12, "decoded", undefined],
    ],
  );
  assert.equal(damaged.slice(report[0].start, report[0].end), "00");
  assert.equal(
    badCoordinate.slice(report[2].start, report[2].end),
    "4860.000,N",
  );
});

test("text, sentence count and ASCII envelope are bounded before interpreting fields", () => {
  for (const text of [
    null,
    "",
    "\r\n",
    "x".repeat(nmeaLimits.text + 1),
    (gga + "\n").repeat(nmeaLimits.sentences + 1),
  ]) {
    assert.throws(() => parseNmeaText(text), { path: "text" });
  }
  const report = parseNmeaText("unknown\r" + gga.slice(0, -3) + "\r\n" + gga);
  assert.deepEqual(
    report.lines.map(({ line, status, path }) => [line, status, path]),
    [
      [1, "invalid", "header"],
      [2, "invalid", "checksum"],
      [3, "decoded", undefined],
    ],
  );
});
