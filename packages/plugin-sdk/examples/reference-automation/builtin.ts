import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { createCommandSequence } from "./command-sequence.ts";
import { builtinCommandSequenceAction } from "./command-sequence-model.ts";
import { createRepeatSend } from "./repeat-send.ts";
import { builtinRepeatSendAction } from "./repeat-send-settings.ts";

export const register: NodeRegister = (context) => {
  context.actions.register(builtinRepeatSendAction, createRepeatSend());
  context.actions.register(
    builtinCommandSequenceAction,
    createCommandSequence(),
  );
  return () => {};
};
