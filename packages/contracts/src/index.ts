import type { RpcReply } from "./generated/types.ts";
import { validateRpcReply } from "./generated/validators.mjs";

export type * from "./generated/types.ts";

export class ContractValidationError extends Error {
  constructor() {
    super("Invalid Host RPC reply");
    this.name = "ContractValidationError";
  }
}

export function parseReply(value: unknown): RpcReply {
  if (!validateRpcReply(value)) throw new ContractValidationError();
  return value;
}
