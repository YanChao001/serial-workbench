import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build, loadConfigFromFile } from "vite";

const root = resolve(import.meta.dirname, "..");

for (const mode of ["production", "web-preview"]) {
  test(`Vite ${mode} output carries the project license and third-party notices`, async (t) => {
    const temporary = mkdtempSync(
      join(tmpdir(), "serial-workbench-vite-license-"),
    );
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const entry = join(temporary, "entry.js");
    writeFileSync(entry, 'console.log("license distribution fixture");\n');
    const loaded = await loadConfigFromFile(
      { command: "build", mode },
      join(root, "vite.config.ts"),
    );
    assert.ok(loaded);
    const output = join(
      temporary,
      mode === "web-preview" ? "dist-web" : "dist",
    );
    await build({
      root: temporary,
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      plugins: loaded.config.plugins.filter(
        (plugin) => plugin?.name === "project-license-files",
      ),
      build: {
        outDir: output,
        emptyOutDir: true,
        minify: false,
        rolldownOptions: { input: entry },
      },
    });
    for (const [fileName, source] of [
      ["LICENSE", "LICENSE"],
      ["NOTICE", "NOTICE"],
      [
        "third-party/tauri-desktop-starter.LICENSE",
        "resources/third-party/tauri-desktop-starter.LICENSE",
      ],
    ]) {
      assert.ok(existsSync(join(output, fileName)), `Vite omitted ${fileName}`);
      assert.deepEqual(
        readFileSync(join(output, fileName)),
        readFileSync(join(root, source)),
      );
    }
    assert.equal(existsSync(join(output, "LICENSES")), false);
  });
}
