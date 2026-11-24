import { expandCommandTemplate as expand } from "../../../packages/plugin-sdk/src/command-template";
import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";

export { parseCommandTemplate } from "../../../packages/plugin-sdk/src/command-template";

export function expandCommandTemplate(
  parts: Parameters<typeof expand>[0],
  values: ReadonlyMap<string, string>,
) {
  return expand(parts, values, CLIENT_DRAFT_MAX_BYTES);
}
