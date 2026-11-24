import { ContractValidationError } from "@serial-workbench/contracts";
import type { MessageKey } from "@/i18n/zh-CN";
import { readVerifiedFile } from "@/lib/host-reader";
import { parseU64 } from "@/lib/u64";
import type { HostContextValue } from "@/providers/host-context";
import {
  maxDefinitionLength,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";

export type ProtocolDefinitionFileAccess = Pick<
  HostContextValue,
  "pickFile" | "fileMetadata" | "readFile"
>;

export class DefinitionFileError extends Error {
  constructor(readonly key: MessageKey) {
    super(key);
  }
}

export async function readProtocolDefinitionFile(
  access: ProtocolDefinitionFileAccess,
  signal: AbortSignal,
): Promise<
  { name: string; text: string; format: FieldDefinitionFormat } | undefined
> {
  const file = await access.pickFile("protocolDefinitionSource", signal);
  signal.throwIfAborted();
  if (!file) return;
  const extension = /\.(json|ya?ml)$/i.exec(file.name)?.[1]?.toLowerCase();
  const format = extension === "yml" ? "yaml" : extension;
  if (format !== "json" && format !== "yaml")
    throw new DefinitionFileError("workbench.fields.fileType");
  const size = parseU64(file.length);
  // UTF-8 can use three bytes for each UTF-16 code unit, plus an optional BOM.
  if (!size || size > BigInt(maxDefinitionLength * 3 + 3))
    throw new DefinitionFileError("workbench.fields.fileSize");
  const metadata = await access.fileMetadata(file.reference, signal);
  if (metadata.purpose !== "read_file" || metadata.length !== file.length)
    throw new DefinitionFileError("workbench.fields.fileChanged");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readVerifiedFile(file.reference, access.readFile, signal, {
      totalBytes: metadata.length,
      fingerprint: metadata.fingerprint,
    });
  } catch (error) {
    if (error instanceof ContractValidationError)
      throw new DefinitionFileError("workbench.fields.fileChanged");
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/\r\n?/g, "\n");
  } catch {
    throw new DefinitionFileError("workbench.fields.fileEncoding");
  }
  if (text.length > maxDefinitionLength || !text.trim())
    throw new DefinitionFileError("workbench.fields.fileSize");
  return { name: file.name, text, format };
}
