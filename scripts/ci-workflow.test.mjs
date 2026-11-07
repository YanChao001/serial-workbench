import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");
const ci = read(".github/workflows/ci.yml");
const job = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  return ci.slice(start + 1).split(/\n {2}[\w-]+:\n/)[0];
};

// These assertions lock repository policy; actionlint and an actual manual run
// validate GitHub syntax, runner availability and the commands themselves.
test("CI and audit run only on manual dispatch and use read-only repository permission", () => {
  for (const name of ["ci", "audit"]) {
    const content = read(`.github/workflows/${name}.yml`);
    const triggers = content.split(/^on:\s*$/m)[1]?.split(/^\S/m)[0];
    assert.ok(triggers, name);
    assert.deepEqual(
      [...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]),
      ["workflow_dispatch"],
    );
    assert.match(content, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(
      content,
      /contents: write|pull_request_target|publish-release/,
    );
  }
  assert.match(ci, /desktop_e2e:[\s\S]*?type: boolean\n {8}default: true/);
  assert.match(job("desktop-e2e"), /^ {4}if: inputs\.desktop_e2e$/m);
});

test("both native matrices cover all four targets without scope or tree reuse", () => {
  const expected = [
    ["windows-2022", "x86_64-pc-windows-msvc"],
    ["ubuntu-22.04", "x86_64-unknown-linux-gnu"],
    ["macos-15", "aarch64-apple-darwin"],
    ["macos-15-intel", "x86_64-apple-darwin"],
  ];
  for (const name of ["rust", "desktop-e2e"]) {
    const body = job(name);
    assert.match(body, /fail-fast: false/);
    assert.deepEqual(
      [...body.matchAll(/- platform: ([\w.-]+)\n {12}target: ([\w-]+)/g)].map(
        (m) => [m[1], m[2]],
      ),
      expected,
    );
    assert.match(body, /MACOSX_DEPLOYMENT_TARGET: "14\.0"/);
    assert.match(body, /libwebkit2gtk-4\.1-dev.*libatomic1/);
    assert.match(body, /key: (?:native|e2e)-\$\{\{ matrix\.target \}\}/);
  }
  assert.doesNotMatch(ci, /docs_only|rust_required|reused_run|needs: changes/);
  for (const name of ["frontend", "browser-smoke", "rust", "bindings"]) {
    assert.doesNotMatch(job(name), /^ {4}if:/m, name);
  }
  assert.match(job("rust"), /cargo clippy --locked --workspace --all-targets/);
  assert.match(job("rust"), /cargo test --locked --workspace/);
  assert.match(job("rust"), /pnpm app:build --no-bundle --target/);
  assert.match(job("bindings"), /pnpm bindings:check/);
});

test("the gate always gathers every job, and all jobs have a time budget", () => {
  assert.match(job("quality-gate"), /if: always\(\)/);
  assert.match(
    job("quality-gate"),
    /needs: \[frontend, browser-smoke, rust, bindings, desktop-e2e\]/,
  );
  assert.match(
    job("quality-gate"),
    /CI_DESKTOP_E2E: \$\{\{ inputs\.desktop_e2e \}\}/,
  );
  for (const [, name] of ci.matchAll(/^ {2}([\w-]+):\n/g)) {
    if (name === "workflow_dispatch") continue;
    assert.match(job(name), /timeout-minutes: \d+/, name);
  }
});

test("unused skip helpers are removed and the release template has no dangling call", () => {
  for (const name of [
    "scripts/ci-scope.mjs",
    "scripts/ci-scope.test.mjs",
    "scripts/hosting/github-ci-scope.mjs",
    "scripts/ci-verified-tree.mjs",
    "scripts/ci-verified-tree.test.mjs",
  ]) {
    assert.equal(existsSync(resolve(root, name)), false, name);
  }
  const release = read(".github/workflows-disabled/release.yml");
  assert.doesNotMatch(release, /ci-verified-tree|steps\.verified|reused_run/);
  assert.match(release, /run: pnpm verify/);
  assert.equal(
    existsSync(resolve(root, ".github/workflows/release.yml")),
    false,
  );
  assert.equal(existsSync(resolve(root, ".github/workflows/pages.yml")), false);
});

test("native jobs resolve root workspace and retain isolated target caches", () => {
  for (const name of ["rust", "bindings"])
    assert.match(job(name), /workspaces: \. -> src-tauri\/target\n/);
  assert.match(
    job("desktop-e2e"),
    /workspaces: \. -> src-tauri\/target\/e2e\n/,
  );
  assert.doesNotMatch(ci, /working-directory: src-tauri/);
  assert.match(
    read(".github/workflows/audit.yml"),
    /cargo audit --file Cargo\.lock/,
  );
  assert.match(
    read(".github/workflows-disabled/release.yml"),
    /workspaces: \. -> src-tauri\/target\n/,
  );
});

test("generated Host contracts and desktop bindings are checked serially in the bindings job", () => {
  assert.match(
    job("bindings"),
    /run: \|\n {10}pnpm contracts:check\n {10}pnpm bindings:check/,
  );
  assert.doesNotMatch(job("bindings"), /pnpm (?:contracts|bindings):check.*&/);
});

test("release package output follows successful configuration and version checks", () => {
  const release = read(".github/workflows-disabled/release.yml");
  assert.match(
    release,
    /id: version\n {8}run: \|\n {10}pnpm config:check\n {10}node scripts\/version.mjs check\n {10}node --input-type=module -e/,
  );
  assert.match(
    release,
    /args:.*-- --package \$\{\{ steps\.version\.outputs\.package \}\}/,
  );
});
