import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { waitForSettingsCommit } from "./settings-save-evidence.mjs";

function fixture(t) {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, "settings-commit-evidence-"));
  t.after(() => {
    assert.equal(dirname(directory), base);
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "settings-commit-failure.json");
}

const settings = (intensity) => ({
  revision: "41",
  client: { revision: "9", state: { credential: "must-not-be-recorded" } },
  settings: {
    language: "en",
    theme: "dark",
    background: { kind: "preset", value: "sakura" },
    backgroundIntensity: intensity,
    proxy: { password: "must-not-be-recorded" },
  },
  profile: "private-profile-path",
});
const ui = async () => ({
  language: "en",
  theme: "dark",
  backgroundIntensity: 70,
  persistence: { error: true, saving: false, loading: false },
  rawText: "private-message-must-not-be-recorded",
});

test("an actual timed-out wait writes the last observed values without another read or attachment", async (t) => {
  const outputPath = fixture(t);
  const timeout = new Error("The original wait timed out");
  let reads = 0;
  let uiReads = 0;
  const candidatePath = join(dirname(outputPath), "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      source: "1".repeat(64),
      sha256: "2".repeat(64),
      target: "x86_64-apple-darwin",
      executable: "private-executable-path",
    }),
  );
  await assert.rejects(
    waitForSettingsCommit({
      outputPath,
      candidatePath,
      readSettings: async (observed) => {
        reads++;
        observed({ phase: "attachment_observed", generation: String(reads) });
        observed({ phase: "query_replied", generation: String(reads) });
        return settings(reads * 10);
      },
      readUi: async () => {
        uiReads++;
        return ui();
      },
      matches: (value) => value.settings.backgroundIntensity === 70,
      waitUntil: async (condition) => {
        assert.equal(await condition(), false);
        assert.equal(await condition(), false);
        throw timeout;
      },
    }),
    (error) => error === timeout,
  );
  assert.equal(reads, 2);
  assert.equal(uiReads, 2);
  const serialized = readFileSync(outputPath, "utf8");
  const evidence = JSON.parse(serialized);
  assert.deepEqual(evidence.stored, {
    language: "en",
    theme: "dark",
    backgroundKind: "preset",
    backgroundPreset: "sakura",
    backgroundIntensity: 20,
    revision: "41",
    clientRevision: "9",
  });
  assert.deepEqual(evidence.nativeConnection, {
    provesGuiConnectionHealth: false,
    generation: "2",
    phase: "query_replied",
  });
  assert.equal(evidence.gui.persistence.error, true);
  assert.equal(evidence.polls, 2);
  assert.equal(evidence.candidate.target, "x86_64-apple-darwin");
  assert.equal(
    /private|password|credential|profile|rawText/.test(serialized),
    false,
  );
});

test("a failed request records its already observed generation/code and preserves the original failure", async (t) => {
  const outputPath = fixture(t);
  const failure = Object.assign(new Error("private-error-details"), {
    code: "UNAUTHENTICATED",
  });
  let reads = 0;
  await assert.rejects(
    waitForSettingsCommit({
      outputPath,
      readSettings: async (observed) => {
        reads++;
        observed({ phase: "attachment_observed", generation: "3" });
        observed({
          phase: "query_failed",
          generation: "3",
          errorCode: "UNAUTHENTICATED",
          token: "must-not-be-recorded",
        });
        throw failure;
      },
      readUi: ui,
      matches: () => false,
      waitUntil: (condition) => condition(),
    }),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
  const serialized = readFileSync(outputPath, "utf8");
  const evidence = JSON.parse(serialized);
  assert.equal(evidence.nativeConnection.generation, "3");
  assert.equal(evidence.nativeConnection.phase, "query_failed");
  assert.equal(evidence.nativeConnection.errorCode, "UNAUTHENTICATED");
  assert.equal(evidence.nativeConnection.provesGuiConnectionHealth, false);
  assert.equal(evidence.readErrorCode, "UNAUTHENTICATED");
  assert.equal(/private|token|must-not-be-recorded/.test(serialized), false);
});

test("expired transient notifications remain observed after three failed polls without extra Host reads", async (t) => {
  const outputPath = fixture(t);
  const timeout = new Error("The original wait timed out");
  let reads = 0;
  let uiReads = 0;
  const states = [
    { error: true, saving: false, loading: true },
    { error: false, saving: true, loading: false },
    { error: false, saving: false, loading: false },
  ];
  await assert.rejects(
    waitForSettingsCommit({
      outputPath,
      readSettings: async () => {
        reads++;
        return settings(20);
      },
      readUi: async () => ({
        ...(await ui()),
        persistence: states[uiReads++],
      }),
      matches: () => false,
      waitUntil: async (condition) => {
        for (let poll = 0; poll < 3; poll++)
          assert.equal(await condition(), false);
        throw timeout;
      },
    }),
    (error) => error === timeout,
  );
  const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(reads, 3);
  assert.equal(uiReads, 3);
  assert.equal(evidence.polls, 3);
  assert.deepEqual(evidence.gui.persistence, states[2]);
  assert.deepEqual(evidence.seenPersistence, {
    error: true,
    saving: true,
    loading: true,
  });
});

test("unavailable DOM or receipt observations do not change a successful settings assertion", async (t) => {
  const outputPath = fixture(t);
  let reads = 0;
  await waitForSettingsCommit({
    outputPath,
    candidatePath: join(dirname(outputPath), "missing-candidate.json"),
    readSettings: async () => {
      reads++;
      return settings(70);
    },
    readUi: async () => {
      throw new Error("The diagnostic DOM observation is unavailable");
    },
    matches: (value) => value.settings.backgroundIntensity === 70,
    waitUntil: async (condition) => assert.equal(await condition(), true),
  });
  assert.equal(reads, 1);
  assert.equal(existsSync(outputPath), false);
});
