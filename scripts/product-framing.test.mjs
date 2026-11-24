import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const resources = new URL(
  "../crates/host/resources/node-packages/",
  import.meta.url,
);
const example = new URL(
  "../packages/plugin-sdk/examples/reference-framing/",
  import.meta.url,
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the shipped framing archive matches the locked sources", () => {
  const descriptor = JSON.parse(
    readFileSync(new URL("framing.json", resources), "utf8"),
  );
  const manifest = readFileSync(new URL("manifest.json", example));
  assert.equal(descriptor.id, JSON.parse(manifest).id);
  assert.equal(descriptor.version, JSON.parse(manifest).version);
  assert.equal(descriptor.manifestSha256, sha256(manifest));
  assert.equal(
    descriptor.archiveSha256,
    sha256(readFileSync(new URL("framing.zip", resources))),
  );

  const config = new URL(
    "../packages/plugin-sdk/tsconfig.fixture.json",
    import.meta.url,
  );
  const parsedConfig = ts.getParsedCommandLineOfConfigFile(
    fileURLToPath(config),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        assert.fail(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  assert.ok(parsedConfig);
  assert.deepEqual(parsedConfig.errors, []);
  const source = readFileSync(new URL("main.ts", example), "utf8");
  const generated = ts.transpileModule(source, {
    fileName: "main.ts",
    compilerOptions: parsedConfig.options,
  });
  assert.equal(
    descriptor.compiledModuleSha256,
    sha256(generated.outputText.replaceAll("\r\n", "\n")),
  );
});
