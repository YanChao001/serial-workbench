import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { createRepeatSend } from "./repeat-send.ts";
import { builtinRepeatSendAction } from "./repeat-send-settings.ts";

export const register: NodeRegister = (context) => {
  context.actions.register(builtinRepeatSendAction, createRepeatSend());
  return () => {};
};
