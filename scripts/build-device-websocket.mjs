import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

export function buildDeviceWebsocket(write = true) {
  return build({
    absWorkingDir: root,
    entryPoints: [
      "packages/plugin-sdk/examples/reference-websocket/builtin.ts",
    ],
    outfile: ".cache/plugin-sdk/examples/reference-websocket/builtin.js",
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    charset: "utf8",
    legalComments: "none",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    // The fixed Node runtime implements UTF-8 validation in node:buffer.
    define: { "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1") },
    write,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildDeviceWebsocket();
