import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { transform } from "esbuild";

test("the draft Provider remains a compatible Fast Refresh boundary on an implementation edit", async (t) => {
  const require = createRequire(import.meta.url);
  const runtimePath = join(
    dirname(require.resolve("@vitejs/plugin-react")),
    "refresh-runtime.js",
  );
  const previousWindow = globalThis.window;
  globalThis.window = {};
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const refresh = await import(pathToFileURL(runtimePath).href);
  const source = readFileSync(
    new URL("../src/providers/client-drafts.tsx", import.meta.url),
    "utf8",
  );
  const compiled = await transform(source, {
    loader: "tsx",
    format: "cjs",
    jsx: "automatic",
  });
  const unused = () => {
    throw new Error("Refresh validation must not execute system work");
  };
  const dependencies = {
    react: React,
    "react/jsx-runtime": jsx,
    "@/features/workbench/client-drafts": { createClientDraftStore: unused },
    "@/lib/client-settings": {
      readClientWindowState: unused,
      saveClientWindowState: unused,
    },
    "./client-drafts-context": {
      ClientDraftsContext: React.createContext(null),
      createWindowDraftStore: unused,
    },
  };
  function evaluate() {
    const module = { exports: {} };
    // 只隔离未执行的系统依赖；导出对象和兼容性判定使用实际源码及锁定的 Vite runtime。
    new Function("require", "module", "exports", compiled.code)(
      (name) => {
        assert.ok(
          Object.hasOwn(dependencies, name),
          `Unexpected dependency ${name}`,
        );
        return dependencies[name];
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  const before = evaluate();
  const after = evaluate();
  assert.equal(
    refresh.validateRefreshBoundaryAndEnqueueUpdate(
      "client-drafts.tsx",
      before,
      after,
    ),
    undefined,
  );
});
