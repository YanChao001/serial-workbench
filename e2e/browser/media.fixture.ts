/// <reference lib="dom" />
import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

export async function seedMediaFixture(
  page: Page,
  options: {
    theme?: "light" | "dark";
    motion?: "full" | "reduced";
    backgroundIntensity?: number;
  } = {},
) {
  await seedWorkbenchFixture(page, {
    currentPage: "settings",
    backgroundIntensity: 50,
    ...options,
  });
}
export async function chooseFixtureMedia(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const reference = await page.evaluate(
    ({ name, mime, length }) => {
      const fixture = window.workbenchFixture;
      const id = `media-${fixture.nextMediaId++}`;
      const reference = {
        hostId: "workbench-gui-host",
        kind: "file",
        id,
        revision: "1",
      };
      fixture.mediaQueue.push({
        reference,
        name,
        mime,
        length,
        url: new URL(`./__fixture-media/${id}`, location.href).href,
      });
      return reference;
    },
    {
      name: file.name,
      mime: file.mimeType,
      length: String(file.buffer.length),
    },
  );
  await page.route(`**/__fixture-media/${reference.id}`, (route) =>
    route.fulfill({ body: file.buffer, contentType: file.mimeType }),
  );
  await page
    .getByRole("button", { name: "Add wallpapers", exact: true })
    .click();
  return reference;
}
export async function colorMedia(page: Page, name: string, color: string) {
  const encoded = await page.evaluate((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 320, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, color);
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encoded, "base64"),
  };
}
