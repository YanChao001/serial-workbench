import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  runtimeResourceMap,
  runtimeBundleConfig,
} from "./node-runtime-build.mjs";

test("keeps Tauri resource list file, directory and glob destinations while adding fixed runtime resources", (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtime-resource-map-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src-tauri"));
  mkdirSync(join(root, "extras", "nested"), { recursive: true });
  writeFileSync(join(root, "LICENSE"), "license");
  writeFileSync(join(root, "extras", "top.txt"), "top");
  writeFileSync(join(root, "extras", "nested", "deep.txt"), "deep");
  const runtime = { resources: join(root, "staged runtime") };
  const plan = {
    root,
    config: {
      bundle: { resources: ["../LICENSE", "../extras", "../extras/**/*.txt"] },
    },
  };
  const mapping = runtimeResourceMap(plan, runtime);
  assert.equal(mapping["../LICENSE"], "_up_/LICENSE");
  assert.equal(mapping["../extras"], "_up_/extras/");
  assert.equal(
    mapping["../extras/nested/deep.txt"],
    "_up_/extras/nested/deep.txt",
  );
  assert.equal(mapping[runtime.resources.replaceAll("\\", "/") + "/"], "");
  plan.config.bundle.resources = ["../missing/**/*.txt"];
  assert.throws(() => runtimeResourceMap(plan, runtime), /no files/);
});

test("Linux runtime uses directory copies for deb, RPM and AppImage staging", () => {
  const runtime = { resources: resolve("prepared-runtime") };
  const plan = {
    platform: "linux",
    config: {
      productName: "Custom Product",
      bundle: {
        resources: { "../LICENSE": "LICENSE" },
        linux: {
          deb: { files: { "/etc/example.conf": "/source/example.conf" } },
        },
      },
    },
  };
  const bundle = runtimeBundleConfig(plan, runtime);
  assert.deepEqual(bundle.resources, { "../LICENSE": "LICENSE" });
  for (const type of ["deb", "rpm", "appimage"])
    assert.equal(
      bundle.linux[type].files["/usr/lib/Custom Product/runtime"],
      join(runtime.resources, "runtime"),
    );
  assert.equal(
    bundle.linux.deb.files["/etc/example.conf"],
    "/source/example.conf",
  );
  plan.config.productName = "../outside";
  assert.throws(() => runtimeBundleConfig(plan, runtime), /product|directory/i);
});
