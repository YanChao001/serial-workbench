import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { modbusTransaction } from "../reference-automation/modbus-transaction.ts";

export const register: NodeRegister = (context) => {
  context.actions.register(
    "swb.reference.modbus.transaction",
    modbusTransaction,
  );
  return () => {};
};
