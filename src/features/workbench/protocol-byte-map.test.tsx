import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { ProtocolByteMap } from "./protocol-byte-map";

vi.mock("@/providers/i18n", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const { en } = await import("@/i18n/en");
  return { useI18n: () => ({ t: createTranslator(en), language: "en" }) };
});

afterEach(cleanup);

it("keeps the role and exact original byte location for fields sharing a byte", async () => {
  const readings = [
    {
      id: "header",
      kind: "bytes",
      bytes: { start: 0, end: 1 },
      rawHex: "A5",
      value: "A5",
    },
    {
      id: "address",
      kind: "bits",
      bytes: { start: 1, end: 2 },
      bits: { start: 8, end: 12 },
      rawHex: "12",
      value: "1",
    },
    {
      id: "length",
      kind: "bits",
      bytes: { start: 1, end: 2 },
      bits: { start: 12, end: 16 },
      rawHex: "12",
      value: "2",
    },
    {
      id: "payload",
      kind: "bytes",
      bytes: { start: 2, end: 3 },
      rawHex: "AB",
      value: "AB",
    },
    {
      id: "crc",
      kind: "checksum",
      bytes: { start: 4, end: 5 },
      rawHex: "FF",
      value: "FF",
    },
  ] satisfies FieldReading[];
  const user = userEvent.setup();
  render(
    <ProtocolByteMap
      hex="A5 12 AB 00 FF"
      origin={9007199254740995n}
      readings={readings}
    />,
  );
  const source = within(
    screen.getByRole("region", { name: en["workbench.fields.source"] }),
  );
  const fields = within(
    screen.getByRole("group", { name: en["workbench.fields.name"] }),
  );
  for (const [name, role] of [
    ["header", "header"],
    ["address", "address"],
    ["length", "length"],
    ["payload", "payload"],
    ["crc", "checksum"],
  ]) {
    expect(
      fields.getByRole("button", { name }).getAttribute("data-field-role"),
    ).toBe(role);
  }
  expect(source.getByText("00").textContent).toBe("00");
  expect(
    source.getByRole("button", { name: "Inspect address bytes" }).textContent,
  ).toBe("12");

  await user.click(fields.getByRole("button", { name: "length" }));

  expect(
    source.queryByRole("button", { name: "Inspect address bytes" }),
  ).toBeNull();
  expect(
    source.getByRole("button", { name: "Inspect length bytes" }).textContent,
  ).toBe("12");
  expect(
    screen.getByText(
      "Bytes [9007199254740996, 9007199254740997) · Field bits [12, 16)",
    ),
  ).toBeTruthy();
});
