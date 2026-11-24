import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {
  DerivedReadResult,
  SessionSnapshot,
} from "@serial-workbench/contracts";

const example = "packages/plugin-sdk/examples/reference-chart";
const shellOrigin = "https://chart-shell.example";
const assetOrigin = "https://chart-assets.example";
const identity = "b".repeat(43);

test("chart renders only retained samples and marks expired positions in the isolated view", async ({
  page,
}, info) => {
  const [shell, html, css, fixturesText, bundle] = await Promise.all([
    readFile("src-tauri/src/node_view/shell.js", "utf8"),
    readFile(`${example}/index.html`, "utf8"),
    readFile(`${example}/view.css`, "utf8"),
    readFile("packages/contracts/src/generated/fixtures.json", "utf8"),
    build({
      entryPoints: [`${example}/view.ts`],
      bundle: true,
      write: false,
      format: "iife",
    }),
  ]);
  const fixtures = JSON.parse(fixturesText) as {
    valid: { name: string; value: unknown }[];
  };
  const session = fixtures.valid.find(({ name }) => name === "session-snapshot")
    ?.value as SessionSnapshot;
  const script = bundle.outputFiles[0]?.text;
  if (!session || !script) throw new Error("Missing chart bootstrap data");
  const sample = (
    position: string,
    value: number | string,
  ): DerivedReadResult["samples"][number] => ({
    position,
    value,
    provenance: {
      sources: [
        {
          hostId: "host",
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          eventStart: position,
          eventEnd: String(BigInt(position) + 1n),
          direction: "rx",
          byteStart: "0",
          byteEnd: "2",
        },
      ],
      parserId: "swb.reference.chart.sample",
      parserVersion: "0.1.0",
      configurationDigest: "0".repeat(64),
      quality: ["complete", "transformed"],
      unit: "V",
    },
  });
  const read = (
    previousPosition: string,
    after: string,
    samples: DerivedReadResult["samples"],
  ) => ({
    derived: {
      previousPosition,
      after,
      reply: {
        ok: true,
        result: {
          kind: "stream_derived_read",
          value: {
            operationId: "chart-operation",
            instanceEpoch: "1",
            samples,
            nextPosition: samples.at(-1)!.position,
            hasMore: false,
          },
        },
      },
    },
  });
  const payloads = [
    { snapshot: session },
    read("0", "2", [sample("3", 1.25)]),
    read("3", "4", [sample("5", -2)]),
    read("5", "5", [sample("6", "invalid")]),
  ];
  let pulled = 0;
  await page.route(`${shellOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/shell.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: shell,
      });
    if (path === "/next.js") {
      const payload = payloads.shift() ?? null;
      pulled++;
      return route.fulfill({
        contentType: "application/javascript",
        body: `globalThis.swbViewReceive(${JSON.stringify(payload)});`,
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en">
      <script defer src="shell.js"></script><body data-frame="${identity}"><p role="status"></p><template>
      <iframe sandbox="allow-scripts" title="Plugin view" style="width:760px;height:430px;border:0" data-src="${assetOrigin}/index.html#${identity}.en.light"></iframe>
      </template></body></html>`,
    });
  });
  await page.route(`${assetOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = {
      "content-security-policy": `sandbox allow-scripts; default-src 'none'; script-src ${assetOrigin}; style-src ${assetOrigin}`,
    };
    if (path === "/index.html")
      return route.fulfill({ headers, contentType: "text/html", body: html });
    if (path === "/view.css")
      return route.fulfill({ headers, contentType: "text/css", body: css });
    if (path === "/view.js")
      return route.fulfill({
        headers,
        contentType: "application/javascript",
        body: script,
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${shellOrigin}/index.html`);
  const view = page.frameLocator('iframe[title="Plugin view"]');
  await expect(view.getByRole("status")).toHaveText(
    /2 samples.*Earlier data expired/,
  );
  expect(await view.locator("html").evaluate(() => globalThis.origin)).toBe(
    "null",
  );
  await expect(
    view.getByRole("img", { name: "Voltage by sample position" }),
  ).toBeVisible();
  await view.getByText("Sample values").click();
  await expect(view.locator("tbody tr")).toHaveText(["31.25", "5-2"]);
  await view.getByText("Statistics", { exact: true }).click();
  await expect(view.getByText("4 / 6 (66.67%)", { exact: true })).toBeVisible();
  await expect(view.getByText("1.0875 V", { exact: true })).toBeVisible();
  await expect.poll(() => pulled).toBeGreaterThanOrEqual(5);
  await page.screenshot({ path: info.outputPath("voltage-trace.png") });

  payloads.push(
    read(
      "6",
      "6",
      Array.from({ length: 64 }, (_, index) =>
        sample(String(index + 7), index),
      ),
    ),
    read(
      "70",
      "70",
      Array.from({ length: 63 }, (_, index) =>
        sample(String(index + 71), index + 64),
      ),
    ),
  );
  await expect(view.getByRole("status")).toContainText("128 samples");
  await expect(
    view.getByText("1 / 129 (0.78%)", { exact: true }),
  ).toBeVisible();
  await expect(view.locator("tbody tr").first()).toHaveText("5-2");
});
