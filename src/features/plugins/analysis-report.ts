import {
  ContractValidationError,
  validateJsonValue,
  type Target,
} from "@serial-workbench/contracts";
import { readVerifiedFile } from "@/lib/host-reader";
export const statisticsPackage = "swb.reference.statistics";
import type { HostContextValue } from "@/providers/host-context";

export function parseAnalysisInput(text: string, limit: number) {
  if (text.length > limit) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      validateJsonValue(value) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      return value;
  } catch {
    // Syntax or excessive nesting is reported beside the editor.
  }
  return undefined;
}

export async function readAnalysisReport(
  host: Pick<HostContextValue, "invoke" | "waitForOperation" | "readFile">,
  target: Target,
  archiveSha256: string,
  actionId: string,
  params: NonNullable<ReturnType<typeof parseAnalysisInput>>,
  signal: AbortSignal,
): Promise<unknown> {
  const accepted = await host.invoke(
    { actionId, target, params, executionMode: "independent" },
    signal,
  );
  const finished = await host.waitForOperation(accepted, signal);
  signal.throwIfAborted();
  const file =
    finished.result?.kind === "reference"
      ? finished.result.value.resultRef
      : undefined;
  if (
    finished.state !== "succeeded" ||
    finished.actionId !== actionId ||
    finished.operationId !== accepted.operationId ||
    finished.target.kind !== "host" ||
    finished.target.hostId !== target.hostId ||
    finished.target.id !== target.id ||
    !finished.dependencies?.some(
      ({ id, digest }) => id === statisticsPackage && digest === archiveSha256,
    ) ||
    file?.hostId !== target.hostId ||
    file.kind !== "plugin_result" ||
    file.id !== finished.operationId
  )
    throw new ContractValidationError(
      "Analysis report belongs to another operation or package",
    );
  const bytes = await readVerifiedFile(file, host.readFile, signal);
  const contents: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  signal.throwIfAborted();
  return contents;
}
