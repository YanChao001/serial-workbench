import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { builtinCalendarTaskAction } from "./calendar-settings.ts";
import { createCalendarTask } from "./calendar-task.ts";
import { builtinRuleTriggerAction, createRuleTrigger } from "./rule-trigger.ts";
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
  context.actions.register(builtinRuleTriggerAction, createRuleTrigger());
  context.actions.register(builtinCalendarTaskAction, createCalendarTask());
  return () => {};
};
