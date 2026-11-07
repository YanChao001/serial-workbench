import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function qualityGateFailures(needs, { desktopE2E = true } = {}) {
  if (typeof desktopE2E !== "boolean")
    throw new Error("desktopE2E must be a boolean");
  return ["frontend", "browser-smoke", "rust", "bindings", "desktop-e2e"]
    .filter((job) => {
      const result = needs[job]?.result;
      return (
        result !== "success" &&
        !(job === "desktop-e2e" && !desktopE2E && result === "skipped")
      );
    })
    .map(
      (job) =>
        `Required check ${job} did not pass: ${needs[job]?.result ?? "missing"}`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!["true", "false"].includes(process.env.CI_DESKTOP_E2E))
      throw new Error("CI_DESKTOP_E2E must be true or false");
    const failures = qualityGateFailures(JSON.parse(process.env.CI_NEEDS), {
      desktopE2E: process.env.CI_DESKTOP_E2E === "true",
    });
    if (failures.length) {
      failures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else {
      console.log(
        `All required milestone checks passed; desktop E2E requested: ${process.env.CI_DESKTOP_E2E}.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
