import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { builtinLoopbackTestAction, loopbackTest } from "./loopback-test.ts";
import { builtinCalendarTaskAction } from "./calendar-settings.ts";
import { createCalendarTask } from "./calendar-task.ts";
import { builtinRuleTriggerAction, createRuleTrigger } from "./rule-trigger.ts";
import { createCommandSequence } from "./command-sequence.ts";
import { builtinConnectionSequenceAction } from "./connection-sequence-model.ts";
import { createConnectionSequence } from "./connection-sequence.ts";
import { builtinCommandSequenceAction } from "./command-sequence-model.ts";
import { createRepeatSend } from "./repeat-send.ts";
import {
  builtinTrustedScriptAction,
  createTrustedScriptRun,
} from "./script-run.ts";
import { builtinRepeatSendAction } from "./repeat-send-settings.ts";

export const register: NodeRegister = (context) => {
  context.actions.register(builtinRepeatSendAction, createRepeatSend());
  context.actions.register(
    builtinCommandSequenceAction,
    createCommandSequence(),
  );
  context.actions.register(builtinRuleTriggerAction, createRuleTrigger());
  context.actions.register(builtinCalendarTaskAction, createCalendarTask());
  context.actions.register(builtinLoopbackTestAction, loopbackTest);
  context.actions.register(
    builtinConnectionSequenceAction,
    createConnectionSequence(),
  );
  context.actions.register(
    builtinTrustedScriptAction,
    createTrustedScriptRun(context.workers),
  );
  return () => {};
};
