import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { linkedPackagesDevConfig } from "./vite-linked-packages.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "vite-linked-test-"));
  for (const name of ["contracts", "host-client"]) {
    mkdirSync(join(root, "packages", name, "src"), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), "{}");
    writeFileSync(
      join(root, "packages", name, "src", "index.ts"),
      "export const version = 1;",
    );
  }
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true });
  });
  return root;
}
test("linked runtime cache changes for actual package source, not unrelated tests", (t) => {
  const root = fixture(t);
  const initial = linkedPackagesDevConfig(root);
  assert.deepEqual(initial.optimizeDeps.include, [
    "@serial-workbench/contracts",
    "@serial-workbench/host-client",
  ]);
  writeFileSync(join(root, "packages/contracts/src/index.test.ts"), "ignored");
  assert.equal(linkedPackagesDevConfig(root).cacheDir, initial.cacheDir);
  writeFileSync(
    join(root, "packages/contracts/src/index.ts"),
    "export const version = 2;",
  );
  assert.notEqual(linkedPackagesDevConfig(root).cacheDir, initial.cacheDir);
});
test("linked changes restart once after a burst and release the watcher on close", async (t) => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watcher = new EventEmitter();
  watcher.add = t.mock.fn();
  const httpServer = new EventEmitter();
  const restart = t.mock.fn(async () => {});
  linkedPackagesDevConfig(root).plugin.configureServer({
    watcher,
    httpServer,
    restart,
    config: { logger: { error: t.mock.fn() } },
  });
  const source = join(root, "packages/contracts/src/index.ts");
  watcher.emit("all", "change", join(root, "src/overview.tsx"));
  watcher.emit("all", "change", source.replace("index.ts", "index.test.ts"));
  t.mock.timers.tick(100);
  assert.equal(restart.mock.callCount(), 0);
  watcher.emit("all", "change", source);
  t.mock.timers.tick(50);
  watcher.emit("all", "change", source);
  t.mock.timers.tick(74);
  assert.equal(restart.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(restart.mock.callCount(), 1);
  watcher.emit("all", "change", source);
  httpServer.emit("close");
  t.mock.timers.tick(100);
  assert.equal(restart.mock.callCount(), 1);
  assert.equal(watcher.listenerCount("all"), 0);
});
