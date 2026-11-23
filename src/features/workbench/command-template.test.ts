import { expect, it } from "vitest";
import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";
import {
  expandCommandTemplate,
  parseCommandTemplate,
} from "./command-template";

it("substitutes unique named variables once and preserves literal placeholders", () => {
  const template = parseCommandTemplate("C=${p.id}/${p.id}/${_x}/$${raw}");
  expect(template.variables).toEqual(["p.id", "_x"]);
  expect(
    expandCommandTemplate(template.parts, new Map([["p.id", "中"]])),
  ).toEqual({ kind: "missing" });
  expect(
    expandCommandTemplate(
      template.parts,
      new Map([
        ["p.id", "${_x}"],
        ["_x", ""],
      ]),
    ),
  ).toEqual({ kind: "ready", body: "C=${_x}/${_x}//${raw}" });
});

it("limits both repeated large replacements and the final UTF-8 body", () => {
  const { parts } = parseCommandTemplate("${p}${p}");
  const body = "x".repeat(CLIENT_DRAFT_MAX_BYTES / 2);
  expect(expandCommandTemplate(parts, new Map([["p", body]]))).toEqual({
    kind: "ready",
    body: body + body,
  });
  expect(expandCommandTemplate(parts, new Map([["p", body + "a"]]))).toEqual({
    kind: "limit",
  });
  expect(
    expandCommandTemplate(
      parts,
      new Map([["p", "中".repeat(CLIENT_DRAFT_MAX_BYTES / 4)]]),
    ),
  ).toEqual({ kind: "limit" });
});
