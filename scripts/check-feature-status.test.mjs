import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readMatrixIds,
  validateFeatureStatus,
} from "./check-feature-status.mjs";

const MATRIX_PATH = "docs/requirements.md";
const LEDGER_PATH = "docs/feature-status.json";
const matrixFixture = `# Fixture
Mention CONN-09 outside the table.
| ID | Requirement |
| --- | --- |
| CONN-01 | Includes a reference to CONN-02. |
| CONN-02 | Shared implementation with CONN-01. |
| T01 bytes | CONN-03 |
`;

function feature(id = "CONN-01") {
  return {
    id,
    scope: "included",
    scopeNote: "",
    software: { status: "not-started", evidence: [] },
    hardware: { status: "not-started", evidence: [] },
    release: { status: "not-started", evidence: [] },
  };
}

function ledger(...features) {
  return { schemaVersion: 1, features };
}

test("reads only first-column feature IDs and preserves alias rows", () => {
  assert.deepEqual(readMatrixIds(matrixFixture), ["CONN-01", "CONN-02"]);
});

test("keeps duplicate matrix rows visible to validation", () => {
  assert.deepEqual(readMatrixIds("| CONN-01 | One |\n| CONN-01 | Two |"), [
    "CONN-01",
    "CONN-01",
  ]);
  assert.match(
    validateFeatureStatus(["CONN-01", "CONN-01"], ledger(feature())).join("\n"),
    /matrix.*duplicate.*CONN-01/i,
  );
});

test("accepts a small complete mapping without requiring 247 IDs", () => {
  assert.deepEqual(
    validateFeatureStatus(
      ["CONN-01", "CONN-02"],
      ledger(feature(), feature("CONN-02")),
    ),
    [],
  );
});

test("reports duplicate, missing and extra ledger IDs together", () => {
  const errors = validateFeatureStatus(
    ["CONN-01", "CONN-02"],
    ledger(feature(), feature(), feature("CONN-03")),
  );
  assert.match(errors.join("\n"), /duplicate.*CONN-01/i);
  assert.match(errors.join("\n"), /missing.*CONN-02/i);
  assert.match(errors.join("\n"), /extra.*CONN-03/i);
});

for (const schemaVersion of [0, 2, "1", undefined]) {
  test(`rejects unsupported schema ${String(schemaVersion)} without changing it`, () => {
    const document = { ...ledger(feature()), schemaVersion };
    const snapshot = structuredClone(document);
    assert.match(
      validateFeatureStatus(["CONN-01"], document).join("\n"),
      /schemaVersion/,
    );
    assert.deepEqual(document, snapshot);
  });
}

for (const document of [null, [], "ledger", 1]) {
  test(`rejects a non-object ledger ${JSON.stringify(document)}`, () => {
    assert.match(
      validateFeatureStatus(["CONN-01"], document).join("\n"),
      /document.*object/i,
    );
  });
}

test("rejects malformed features and reports their locations", () => {
  assert.match(
    validateFeatureStatus(["CONN-01"], { schemaVersion: 1, features: {} }).join(
      "\n",
    ),
    /features.*array/i,
  );
  assert.match(
    validateFeatureStatus(["CONN-01"], ledger(null)).join("\n"),
    /features\[0\].*object/i,
  );
  assert.match(
    validateFeatureStatus(["CONN-01"], ledger({ ...feature(), id: 1 })).join(
      "\n",
    ),
    /features\[0\]\.id/,
  );
});

test("rejects fields outside the ledger contract at every level", () => {
  const item = { ...feature(), requirement: "Duplicated requirement" };
  item.software.detail = "Copied evidence log";
  const document = { ...ledger(item), title: "Duplicate matrix" };
  const errors = validateFeatureStatus(["CONN-01"], document).join("\n");
  assert.match(errors, /document.*title/);
  assert.match(errors, /CONN-01.*requirement/);
  assert.match(errors, /CONN-01\.software.*detail/);
});

test("rejects unknown scope and non-string scope notes", () => {
  const item = { ...feature(), scope: "optional", scopeNote: null };
  const errors = validateFeatureStatus(["CONN-01"], ledger(item)).join("\n");
  assert.match(errors, /CONN-01\.scope/);
  assert.match(errors, /CONN-01\.scopeNote/);
});

for (const scope of ["excluded", "deferred"]) {
  test(`${scope} requires a nonempty scope note`, () => {
    assert.match(
      validateFeatureStatus(
        ["CONN-01"],
        ledger({ ...feature(), scope, scopeNote: "  " }),
      ).join("\n"),
      /CONN-01\.scopeNote/,
    );
    const item = {
      ...feature(),
      scope,
      scopeNote: "Matrix: ./requirements.md#本轮范围决定",
    };
    for (const phase of ["software", "hardware", "release"])
      item[phase].status = "not-applicable";
    assert.deepEqual(validateFeatureStatus(["CONN-01"], ledger(item)), []);
  });
}

test("included software cannot be not-applicable while hardware may be", () => {
  const item = feature();
  item.hardware.status = "not-applicable";
  item.release.status = "not-applicable";
  assert.deepEqual(validateFeatureStatus(["CONN-01"], ledger(item)), []);
  item.software.status = "not-applicable";
  assert.match(
    validateFeatureStatus(["CONN-01"], ledger(item)).join("\n"),
    /CONN-01\.software.*not-applicable/,
  );
});

for (const phase of ["software", "hardware", "release"]) {
  test(`${phase} rejects malformed objects, statuses and evidence`, () => {
    for (const [value, pattern] of [
      [null, /object/],
      [{ status: "complete", evidence: [] }, /status/],
      [{ status: "not-started", evidence: "PR" }, /evidence.*array/],
      [{ status: "not-started", evidence: [3] }, /evidence\[0\]/],
    ]) {
      const item = feature();
      item[phase] = value;
      const errors = validateFeatureStatus(["CONN-01"], ledger(item)).join(
        "\n",
      );
      assert.match(errors, new RegExp(`CONN-01\\.${phase}`));
      assert.match(errors, pattern);
    }
  });

  test(`${phase} passed requires a PR or Release link`, () => {
    const item = feature();
    item[phase].status = "passed";
    assert.match(
      validateFeatureStatus(["CONN-01"], ledger(item)).join("\n"),
      /passed.*evidence/i,
    );
    for (const evidence of [
      "https://github.com/team/workbench/pull/123",
      "https://github.com/team/workbench/releases/tag/v1.0.0",
    ]) {
      item[phase].evidence = [evidence];
      assert.deepEqual(validateFeatureStatus(["CONN-01"], ledger(item)), []);
    }
  });
}

test("rejects evidence that is not a PR or Release URL", () => {
  for (const evidence of [
    "PR #1",
    "https://github.com/team/workbench/issues/1",
    "http://github.com/team/workbench/pull/1",
    "https://github.com/team/workbench/releases/tag/",
  ]) {
    const item = feature();
    item.software.evidence = [evidence];
    assert.match(
      validateFeatureStatus(["CONN-01"], ledger(item)).join("\n"),
      /CONN-01\.software\.evidence\[0\]/,
    );
  }
});

test("accepts every defined active status without inventing evidence", () => {
  for (const status of ["not-started", "in-progress", "failed", "blocked"]) {
    const item = feature();
    item.software.status = status;
    assert.deepEqual(validateFeatureStatus(["CONN-01"], ledger(item)), []);
  }
});

test("the real ledger covers exactly 247 unique matrix IDs and preserves current scope", async () => {
  const matrix = await readFile(path.resolve(MATRIX_PATH), "utf8");
  const document = JSON.parse(
    await readFile(new URL(`../${LEDGER_PATH}`, import.meta.url), "utf8"),
  );
  const ids = readMatrixIds(matrix);
  assert.equal(ids.length, 247);
  assert.equal(new Set(ids).size, 247);
  assert.deepEqual(
    new Set(document.features.map(({ id }) => id)),
    new Set(ids),
  );
  assert.deepEqual(validateFeatureStatus(ids, document), []);
  assert.equal(
    document.features.find(({ id }) => id === "FUT-10").scope,
    "excluded",
  );
  assert.equal(
    document.features.find(({ id }) => id === "CONN-19").scope,
    "excluded",
  );
  assert.equal(
    document.features.find(({ id }) => id === "NET-13").scope,
    "deferred",
  );
  const browser = document.features.find(({ id }) => id === "FUT-08");
  assert.equal(browser.scope, "included");
  assert.match(browser.scopeNote, /Host/);
  assert.match(browser.scopeNote, /Web Serial/);
  assert.equal(
    document.features.filter(({ scope }) => scope === "included").length,
    244,
  );
});

test("CLI resolves fixed repository paths from its location and signals invalid ledgers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "feature-status-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    return rm(root, { recursive: true });
  });
  for (const directory of [
    "scripts",
    path.dirname(MATRIX_PATH),
    path.dirname(LEDGER_PATH),
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const script = path.join(root, "scripts/check-feature-status.mjs");
  await copyFile(
    fileURLToPath(new URL("./check-feature-status.mjs", import.meta.url)),
    script,
  );
  await copyFile(path.resolve(MATRIX_PATH), path.join(root, MATRIX_PATH));
  const ledgerText = await readFile(
    new URL(`../${LEDGER_PATH}`, import.meta.url),
    "utf8",
  );
  await writeFile(path.join(root, LEDGER_PATH), ledgerText);
  const run = () =>
    spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: "utf8" });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /247/);
  const document = JSON.parse(ledgerText);
  document.features.pop();
  await writeFile(path.join(root, LEDGER_PATH), JSON.stringify(document));
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /missing.*LAN-01/i);
});
