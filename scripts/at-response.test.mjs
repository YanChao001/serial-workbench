import assert from "node:assert/strict";
import test from "node:test";
import {
  atLimits,
  parseAtResponse,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/at-response.ts";

const labels = (result) => result.lines.map(({ kind, code }) => [kind, code]);

test("V.250 command results and registration URCs can interleave on one receive stream", () => {
  const report = parseAtResponse(
    'AT+CREG?\r\r\n+CREG: 5\r\n+CMTI: "SM",3\r\n\r\n+CREG: 2,5,"C123","FF05",7\r\n+CREG: 5,"C123","FF05",7\r\nOK\r\n+CREG: 1\r\n',
    "AT+CREG?",
  );
  assert.equal(report.state, "complete");
  assert.deepEqual(labels(report), [
    ["echo", undefined],
    ["urc", "+CREG"],
    ["urc", "+CMTI"],
    ["response", "+CREG"],
    ["urc", "+CREG"],
    ["result", "OK"],
    ["urc", "+CREG"],
  ]);
  assert.deepEqual(
    report.lines.map(({ line }) => line),
    [1, 3, 4, 6, 7, 8, 9],
  );
  assert.equal(report.lines[4].raw, '+CREG: 5,"C123","FF05",7');
  assert.deepEqual(
    labels(parseAtResponse("+CEREG: 2,1\r\n+CREG: 5\r\nNO CARRIER\r\nRING")),
    [
      ["ambiguous", "+CEREG"],
      ["urc", "+CREG"],
      ["urc", "NO CARRIER"],
      ["urc", "RING"],
    ],
  );
  assert.deepEqual(
    labels(parseAtResponse("+C5GREG: (0-5)\nOK", "AT+C5GREG=?")),
    [
      ["response", "+C5GREG"],
      ["result", "OK"],
    ],
  );
});

test("numeric codes are opt-in and data after CONNECT stays in data mode", () => {
  assert.deepEqual(labels(parseAtResponse("0\nOK", "ATI")), [
    ["response", undefined],
    ["result", "OK"],
  ]);
  const numeric = parseAtResponse("2\r5\rconstructor\r8", "ATD123;", "numeric");
  assert.deepEqual(labels(numeric), [
    ["urc", "RING"],
    ["response", undefined],
    ["response", undefined],
    ["result", "NO ANSWER"],
  ]);
  assert.equal(numeric.state, "complete");
  for (const [format, connect] of [
    ["verbose", "CONNECT 115200"],
    ["numeric", "1"],
  ]) {
    const report = parseAtResponse(
      connect + "\nraw data\n\nOK\nNO CARRIER",
      "ATO",
      format,
    );
    assert.equal(report.state, "data-mode");
    assert.deepEqual(labels(report), [
      ["result", "CONNECT"],
      ...Array(4).fill(["data", undefined]),
    ]);
    assert.equal(report.lines[2].raw, "");
  }
  const unrelated = parseAtResponse("NO CARRIER\n+CSQ: 18,99\nOK", "AT+CSQ");
  assert.deepEqual(labels(unrelated), [
    ["ambiguous", "NO CARRIER"],
    ["response", "+CSQ"],
    ["result", "OK"],
  ]);
  assert.equal(parseAtResponse("NO CARRIER", "ATD123;").state, "complete");
});

test("input prompts and extended errors stay distinct from incomplete or ambiguous responses", () => {
  assert.equal(parseAtResponse("\r\n> ", "AT+CMGS=2").state, "waiting");
  assert.deepEqual(
    labels(parseAtResponse("> \r\n+CMS ERROR: 330", "AT+CMGS=2")),
    [
      ["prompt", undefined],
      ["result", "+CMS ERROR"],
    ],
  );
  const cme = parseAtResponse(
    "+VENDOR: example\n+CME ERROR: SIM busy",
    "AT+CPIN?",
  );
  assert.equal(cme.state, "complete");
  assert.deepEqual(labels(cme), [
    ["ambiguous", "+VENDOR"],
    ["result", "+CME ERROR"],
  ]);
  assert.equal(cme.lines[1].raw, "+CME ERROR: SIM busy");
  assert.deepEqual(
    labels(parseAtResponse('+CLIP: "+123",145\n+CLIP: 1,1\nOK', "AT+CLIP?")),
    [
      ["urc", "+CLIP"],
      ["response", "+CLIP"],
      ["result", "OK"],
    ],
  );
});

test("length-checked SMS PDUs cannot swallow or impersonate result lines", () => {
  const sample =
    "+CMT: ,2\r\n01FFABCD\r\n+CBM: 2\r\nAABB\r\n+CMGR: 0,,2\r\n00ABCD\r\nOK";
  const intact = parseAtResponse(sample, "AT+CMGR=1");
  assert.equal(intact.state, "complete");
  assert.deepEqual(labels(intact), [
    ["urc", "+CMT"],
    ["payload", "PDU"],
    ["urc", "+CBM"],
    ["payload", "PDU"],
    ["response", "+CMGR"],
    ["payload", "PDU"],
    ["result", "OK"],
  ]);
  assert.equal(parseAtResponse("+CMT: ,2", "AT+CSQ").state, "uncertain");
  const short = parseAtResponse("+CMT: ,3\n00ABCD\nOK", "AT+CSQ");
  assert.equal(short.state, "uncertain");
  assert.deepEqual(labels(short), [
    ["urc", "+CMT"],
    ["payload", undefined],
    ["payload", undefined],
  ]);
  assert.equal(short.lines[2].raw, "OK");
});

test("text-mode SMS preserves potentially multiline bodies and any earlier final result", () => {
  const sms = '+CMT: "+123",,"26/11/24,08:00:00+32"\nOK\n\n+CMS ERROR: 500';
  const uncertain = parseAtResponse(sms, "AT+CSQ");
  assert.equal(uncertain.state, "uncertain");
  assert.deepEqual(labels(uncertain), [
    ["urc", "+CMT"],
    ...Array(3).fill(["payload", undefined]),
  ]);
  assert.equal(uncertain.lines[2].raw, "");
  const done = parseAtResponse("OK\n" + sms, "AT+CSQ");
  assert.equal(done.state, "complete");
  assert.equal(done.lines.filter((entry) => entry.kind === "result").length, 1);
  const textRead = parseAtResponse(
    '+CMGL: 1,"REC READ","+123",,\nERROR\nOK',
    'AT+CMGL="ALL"',
  );
  assert.equal(textRead.state, "uncertain");
  assert.equal(textRead.lines[0].kind, "response");
  assert.equal(textRead.lines[2].kind, "payload");
});

test("malformed lines and action budgets retain later valid results", () => {
  const bad = parseAtResponse(
    "\u0000\n" + "x".repeat(atLimits.line + 1) + "\nOK",
    "AT",
  );
  assert.deepEqual(labels(bad), [
    ["invalid", undefined],
    ["invalid", undefined],
    ["result", "OK"],
  ]);
  assert.throws(() => parseAtResponse("\n"), { path: "text" });
  assert.throws(() => parseAtResponse("x".repeat(atLimits.text + 1)), {
    path: "text",
  });
  assert.throws(() => parseAtResponse("OK\n".repeat(atLimits.lines + 1)), {
    path: "text",
  });
  assert.throws(() => parseAtResponse("OK", "AT\nAT"), { path: "command" });
  assert.throws(() => parseAtResponse("OK", undefined, "auto"), {
    path: "format",
  });
});
