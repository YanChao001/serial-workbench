import {
  ContractValidationError,
  type Target,
} from "@serial-workbench/contracts";
import { readVerifiedFile } from "@/lib/host-reader";
import type { HostContextValue } from "@/providers/host-context";
import type { ModbusUnitRouting } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange";
import type { ModbusTransport } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import {
  modbusTimelineAction,
  parseModbusTimeline,
} from "./modbus-timeline-model";

export type ModbusTransactionAccess = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & { target: Target; startEventSeq: string; available: boolean };

type Request = {
  transport: ModbusTransport;
  requestBase64: string;
  unitRouting?: ModbusUnitRouting;
  responseTimeoutMs: number;
  lateResponseWaitMs: number;
  retryLimit: number;
};

export async function runModbusTransaction(
  access: ModbusTransactionAccess,
  request: Request,
  signal: AbortSignal,
) {
  const { target } = access;
  const accepted = await access.invoke(
    {
      actionId: modbusTimelineAction,
      target,
      params: {
        ...request,
        includeTrace: true,
        startEventSeq: access.startEventSeq,
      },
      executionMode: "independent",
    },
    signal,
  );
  const completed = await access.waitForOperation(accepted, signal);
  const ref =
    completed.result?.kind === "reference"
      ? completed.result.value.resultRef
      : undefined;
  if (
    completed.actionId !== modbusTimelineAction ||
    completed.operationId !== accepted.operationId ||
    completed.target.hostId !== target.hostId ||
    completed.target.kind !== "session" ||
    completed.target.id !== target.id ||
    completed.target.sessionId !== target.sessionId ||
    completed.target.sessionEpoch !== target.sessionEpoch ||
    ref?.hostId !== target.hostId ||
    ref.kind !== "plugin_result" ||
    ref.id !== completed.operationId
  )
    throw new ContractValidationError(
      "Modbus result belongs to another operation",
    );
  const bytes = await readVerifiedFile(ref, access.readFile, signal);
  const content: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  signal.throwIfAborted();
  return parseModbusTimeline(content, target);
}
