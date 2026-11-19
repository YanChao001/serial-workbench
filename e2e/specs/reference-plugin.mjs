import { browser, $ } from "@wdio/globals";
import { navigate } from "../helpers.mjs";

export function byText(tag, text, within = "") {
  return $(`${within}//${tag}[normalize-space()=${JSON.stringify(text)}]`);
}

export async function click(element) {
  await element.waitForDisplayed();
  await element.waitForEnabled();
  await element.click();
}

export const button = (text) => byText("button", text);
export const dialogButton = (text) =>
  byText("button", text, "//*[@role='dialog']");

export async function showPluginDetails(name) {
  await navigate("/plugins");
  const row = $(
    `//button[@aria-expanded and .//*[normalize-space()=${JSON.stringify(name)}]]`,
  );
  await row.waitForDisplayed();
  if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
}

export async function installPlugin(fixture, selectFile = click) {
  const field = (suffix) => $(`main input[id$='-${suffix}']`);
  await navigate("/plugins");
  await click(button("Manage sources"));
  await field("source").setValue(fixture.source);
  await field("key").setValue(fixture.keyId);
  await field("public").setValue(fixture.publicKeyHex);
  await click(button("Add source"));
  await click(dialogButton("Trust this source"));
  await byText("*", fixture.source).waitForDisplayed();
  await click(button("Install plugin"));
  await click($("[role='dialog'] [role='combobox']"));
  await click(byText("*[@role='option']", fixture.source));
  await selectFile(dialogButton("Choose plugin file"), "Open", fixture.archive);
  await byText(
    "*",
    `Signature verified · ${fixture.source}`,
  ).waitForDisplayed();
  await click(button("Trust this plugin"));
  await byText(
    "*",
    "Read serial data",
    "//*[@role='dialog']",
  ).waitForDisplayed();
  await click(dialogButton("Trust this plugin"));
  await click(button("Enable"));
  await button("Open plugin").waitForEnabled();
}

export async function sendHex(hex) {
  await navigate("/");
  const hexMode = byText(
    "*[@role='radio']",
    "HEX",
    "//*[@data-panel-id='send']",
  );
  await hexMode.waitForDisplayed();
  if ((await hexMode.getAttribute("aria-checked")) === "false")
    await hexMode.click();
  const draft = $(".workbench-draft");
  await draft.waitForDisplayed();
  await draft.setValue(hex.match(/../g).join(" "));
  await click($("button[aria-label='Send']"));
  const marker = Buffer.from(hex, "hex").toString("utf8").trim();
  await browser.waitUntil(() =>
    browser.execute(
      (expected) =>
        document
          .querySelector(".workbench-receive-frame")
          ?.innerText.includes(expected),
      marker,
    ),
  );
}
