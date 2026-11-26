import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function qualityGateFailures(
  needs,
  { desktopE2E = true, waylandE2E = false } = {},
) {
  if (typeof desktopE2E !== "boolean")
    throw new Error("desktopE2E must be a boolean");
  if (typeof waylandE2E !== "boolean")
    throw new Error("waylandE2E must be a boolean");
  const required = [
    "frontend",
    "browser-smoke",
    "rust",
    "linux-node-backend",
    "bindings",
    "desktop-e2e",
  ];
  if (waylandE2E) required.push("wayland-global-send-preflight");
  return required
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
    const wayland = process.env.CI_WAYLAND_E2E ?? "false";
    if (!["true", "false"].includes(wayland))
      throw new Error("CI_WAYLAND_E2E must be true or false");
    const failures = qualityGateFailures(JSON.parse(process.env.CI_NEEDS), {
      desktopE2E: process.env.CI_DESKTOP_E2E === "true",
      waylandE2E: wayland === "true",
    });
    if (failures.length) {
      failures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else {
      console.log(
        `All required milestone checks passed (desktop E2E=${process.env.CI_DESKTOP_E2E}, Wayland E2E=${wayland}).`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
