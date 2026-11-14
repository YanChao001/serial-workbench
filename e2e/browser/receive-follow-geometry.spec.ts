/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

for (const sample of [
  {
    scale: 1,
    fontSize: 18,
    lineHeight: 165,
    motion: "reduced",
    systemMotion: "no-preference",
  },
  {
    scale: 1.25,
    fontSize: 18,
    lineHeight: 165,
    motion: "reduced",
    systemMotion: "no-preference",
  },
  {
    scale: 1.5,
    fontSize: 18,
    lineHeight: 165,
    motion: "full",
    systemMotion: "no-preference",
  },
  {
    scale: 2,
    fontSize: 14,
    lineHeight: 150,
    motion: "full",
    systemMotion: "reduce",
  },
] as const) {
  test.describe(`receive alignment ${sample.scale}x ${sample.motion}/${sample.systemMotion}`, () => {
    test.use({
      deviceScaleFactor: sample.scale,
      reducedMotion: sample.systemMotion,
    });
    test("continuous receive keeps the message divider and timestamp on stable pixels", async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1400, height: 925 });
      await seedWorkbenchFixture(page, {
        language: "zh",
        theme: "dark",
        sidebarCollapsed: true,
        motion: sample.motion,
        sharedSettings: {
          terminal: {
            receiveMode: "text",
            sendMode: "text",
            receiveEncoding: "utf-8",
            sendEncoding: "utf-8",
            lineEnding: { kind: "none" },
            typography: {
              ...defaults.terminalTypography,
              fontSize: sample.fontSize,
              lineHeightPercent: sample.lineHeight,
            },
          },
        },
      });
      await page.goto("./#/");
      await page
        .getByRole("button", { name: "打开 Virtual serial", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
        )
        .toBe(1);
      await page.evaluate(() => document.fonts.ready);
      const source = workbenchStreamItems().find(
        (item) => item.kind === "source" && item.event.kind === "rx",
      );
      if (source?.kind !== "source") throw new Error("Missing source");
      const frames = await page.evaluate(
        async (event) => {
          const log = document.querySelector<HTMLElement>("[role='log']")!;
          const frames: {
            divider: number;
            timestamp: number;
            remaining: number;
            top: number;
            height: number;
            rowHeight: number;
            bodyHeight: number;
            bodyBottom: number;
            padding: string;
            following: string | undefined;
            computedPadding: string;
            transition: string;
            bytesShown: number;
          }[] = [];
          let bytes = 0;
          let sequence = 10;
          const append = (length: number) => {
            window.workbenchFixture.emitRaw([
              {
                kind: "source",
                event: {
                  ...event,
                  kind: "rx",
                  eventSeq: String(++sequence),
                  time: {
                    ...event.time,
                    sourceMonoNs: String(sequence * 20_000_000),
                    receivedWallTime: new Date(
                      Date.parse(
                        event.time.receivedWallTime ?? "2026-11-13T00:00:00Z",
                      ) +
                        sequence * 20,
                    ).toISOString(),
                  },
                  payload: {
                    bytesBase64: btoa(
                      "0123456789"
                        .repeat(Math.ceil(length / 10))
                        .slice(0, length),
                    ),
                    byteStart: String(bytes),
                    byteEnd: String(bytes + length),
                  },
                },
              },
            ]);
            bytes += length;
          };
          const frame = () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          append(8192);
          for (let warmup = 0; warmup < 60; warmup++) {
            await frame();
            if (
              log.scrollTop > 0 &&
              log.scrollHeight - log.scrollTop - log.clientHeight <= 1
            )
              break;
          }
          let running = true;
          const record = () => {
            const row = log.querySelector<HTMLElement>(
              ".workbench-stream-row:last-child",
            );
            const time = row?.querySelector("time");
            if (row && time && log.scrollHeight > log.clientHeight) {
              frames.push({
                divider: row.getBoundingClientRect().bottom,
                timestamp: time.getBoundingClientRect().top,
                remaining: log.scrollHeight - log.scrollTop - log.clientHeight,
                top: log.scrollTop,
                height: log.scrollHeight,
                rowHeight: row.getBoundingClientRect().height,
                bodyHeight:
                  log.firstElementChild!.getBoundingClientRect().height,
                bodyBottom:
                  log.firstElementChild!.getBoundingClientRect().bottom,
                padding: (log.firstElementChild as HTMLElement).style
                  .paddingBlockStart,
                following: log.dataset.following,
                computedPadding: getComputedStyle(log.firstElementChild!)
                  .paddingBlockStart,
                transition: getComputedStyle(log.firstElementChild!).transition,
                bytesShown:
                  row.querySelector(".workbench-payload")?.textContent
                    ?.length ?? 0,
              });
            }
            if (running) requestAnimationFrame(record);
          };
          requestAnimationFrame(record);
          for (let index = 0; index < 100; index++) {
            append(257);
            await frame();
            await frame();
          }
          running = false;
          await frame();
          return frames;
        },
        {
          hostId: source.event.hostId,
          instanceEpoch: source.event.instanceEpoch,
          sessionId: source.event.sessionId,
          sessionEpoch: source.event.sessionEpoch,
          configurationRevision: source.event.configurationRevision,
          time: source.event.time,
        },
      );
      await writeFile(
        info.outputPath("receive-frame-geometry.json"),
        JSON.stringify(frames),
      );
      expect(frames.length).toBeGreaterThan(100);
      expect(
        frames.at(-1)?.bytesShown,
        "the actual receive display must keep growing throughout the sample",
      ).toBe(8192 + 100 * 257);
      expect(frames.every((frame) => frame.following === "true")).toBe(true);
      await info.attach("receive-frame-geometry", {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });
      await page.screenshot({
        path: info.outputPath("continuous-receive.png"),
      });
      const span = (values: number[]) =>
        Math.max(...values) - Math.min(...values);
      const summary = {
        frames: frames.length,
        dividerRange: span(frames.map((frame) => frame.divider)),
        timestampRange: span(frames.map((frame) => frame.timestamp)),
        remainingRange: span(frames.map((frame) => frame.remaining)),
        scrollFractions: [...new Set(frames.map((frame) => frame.top % 1))],
      };
      await info.attach("receive-geometry-summary", {
        body: JSON.stringify(summary),
        contentType: "application/json",
      });
      console.log(JSON.stringify(summary));
      expect(
        summary.dividerRange,
        "message divider must not oscillate while following",
      ).toBeLessThanOrEqual(0.25);
      expect(
        summary.timestampRange,
        "timestamp must share the stable bottom alignment",
      ).toBeLessThanOrEqual(0.25);
      expect(errors).toEqual([]);
    });
  });
}
