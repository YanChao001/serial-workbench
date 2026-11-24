import { createRequire } from "node:module";

// Load JSON outside the Playwright TypeScript transform.
const requireFixture = createRequire(import.meta.url);

export const appConfig = requireFixture(
  "../../app.config.json",
) as typeof import("../../app.config.json");
export const defaults = requireFixture(
  "../../packages/contracts/src/generated/defaults.json",
) as typeof import("../../packages/contracts/src/generated/defaults.json");
export const clientDefaults = requireFixture(
  "../../src/lib/generated/client-defaults.json",
) as typeof import("../../src/lib/generated/client-defaults.json");
export const catalog = requireFixture(
  "../../packages/contracts/src/generated/catalog.json",
) as typeof import("../../packages/contracts/src/generated/catalog.json");

export const builtinAutomation = requireFixture(
  "../../packages/plugin-sdk/examples/reference-automation/builtin-manifest.json",
) as typeof import("../../packages/plugin-sdk/examples/reference-automation/builtin-manifest.json");

export const referenceAutomation = requireFixture(
  "../../packages/plugin-sdk/examples/reference-automation/manifest.json",
) as typeof import("../../packages/plugin-sdk/examples/reference-automation/manifest.json");
