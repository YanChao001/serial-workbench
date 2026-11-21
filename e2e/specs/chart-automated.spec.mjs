import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "@wdio/globals";
import { language, navigate, ready } from "../helpers.mjs";
import { nativeValue } from "../settings.mjs";
import {
  button,
  click,
  installPlugin,
  sendHex,
  showPluginDetails,
} from "./reference-plugin.mjs";
import { openVirtual, restartOwnedHost } from "./workbench.mjs";

const directory = process.env.STARTER_E2E_CHART_DIR;
const source = () =>
  readFileSync(join(directory, "chart-automated", "native.log"), "utf8");

async function waitForMatch(find, timeoutMsg) {
  let match;
  await browser.waitUntil(() => Boolean((match = find(source()))), {
    timeoutMsg,
  });
  return match;
}

async function openChart(previous) {
  await showPluginDetails("Serial Workbench Chart");
  await click(button("Open plugin"));
  const [, view] = await waitForMatch(
    (log) =>
      Array.from(
        log.matchAll(/e2e_chart_window view=(node-view-[\w-]+) event=shown/g),
      ).find(([, id]) => id !== previous),
    "The isolated native chart window was not shown",
  );
  await button("Open plugin").waitForEnabled();
  return view;
}

async function acceptedSamples(view, until) {
  return waitForMatch((log) => {
    const pages = Array.from(
      log.matchAll(
        /e2e_chart view=(node-view-[\w-]+) operation=([\w-]+) position=(\d+) values=(\[[^\n]*\])/g,
      ),
    ).filter(([, id]) => id === view);
    if (Number(pages.at(-1)?.[3]) !== until) return undefined;
    const operation = pages[0][2];
    assert.ok(pages.every(([, , id]) => id === operation));
    return {
      operation,
      values: pages.flatMap(([, , , , values]) => JSON.parse(values)),
    };
  }, `The packaged chart did not acknowledge ${until} samples`);
}

describe("Signed chart on the real desktop", () => {
  it("reopens the live chart result and closes the view when its Host exits", async () => {
    const fixture = JSON.parse(
      readFileSync(join(directory, "chart-inputs.json"), "utf8"),
    );
    await ready();
    await language("en");
    await navigate("/");
    await openVirtual();
    await installPlugin(fixture);

    const first = await openChart();
    await sendHex(Buffer.from("1.25\n").toString("hex"));
    const live = await acceptedSamples(first, 1);
    assert.deepEqual(live.values, [1.25]);
    await nativeValue("host_close_node_view", { id: first });
    await waitForMatch(
      (log) => log.includes(`e2e_chart_window view=${first} event=closed`),
      "The native chart window was not destroyed",
    );
    await sendHex(Buffer.from("-2\n").toString("hex"));
    await sendHex(Buffer.from("3.5\n").toString("hex"));

    await showPluginDetails("Serial Workbench Chart");
    await click(button("Save SVG…"));
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          document.body.textContent.includes("Chart saved."),
        ),
      { timeoutMsg: "The desktop did not confirm the chart was saved" },
    );
    const exported = readFileSync(join(directory, "exported-chart.svg"));
    assert.ok(exported.toString("utf8").startsWith("<svg "));
    assert.match(
      exported.toString("utf8"),
      /points="72\.00,154\.25 344\.00,295\.64 616\.00,56\.36"/,
    );
    const exportReceipt = {
      file: "exported-chart.svg",
      bytes: exported.length,
      sha256: createHash("sha256").update(exported).digest("hex"),
    };

    const reopened = await openChart(first);
    const retained = await acceptedSamples(reopened, 3);
    assert.deepEqual(retained, {
      operation: live.operation,
      values: [1.25, -2, 3.5],
    });
    const firstHost = JSON.parse(
      readFileSync(join(directory, "host.json"), "utf8"),
    );
    const restart = await restartOwnedHost();
    assert.equal(restart.previousPid, firstHost.pid);
    assert.notEqual(restart.pid, firstHost.pid);
    assert.equal(restart.hostId, firstHost.hostId);
    assert.ok(BigInt(restart.instanceEpoch) > BigInt(firstHost.instanceEpoch));
    await waitForMatch(
      (log) => log.includes(`e2e_chart_window view=${reopened} event=closed`),
      "The reopened chart was not destroyed when its Host connection ended",
    );
    writeFileSync(
      join(directory, "chart-window.json"),
      JSON.stringify(
        { first, reopened, live, retained, restart, exportReceipt },
        null,
        2,
      ),
      { flag: "wx" },
    );
  });
});
