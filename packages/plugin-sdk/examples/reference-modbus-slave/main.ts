import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { serveModbus } from "./serve.ts";

export const register: NodeRegister = (context) => {
  context.actions.register("swb.reference.modbus.slave.serve", serveModbus);
  return () => {};
};
