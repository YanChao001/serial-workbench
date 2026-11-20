import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";

const actionId = "swb.reference.terminal.open";
const viewId = "swb.reference.terminal.view";

export const register: NodeRegister = (context) => {
  context.actions.register(actionId, (call) => {
    const { sessionId, sessionEpoch } = call.target;
    if (!sessionId || !sessionEpoch)
      throw new Error("Session identity required");
    return { sessionId, sessionEpoch };
  });
  context.contributions.register({
    actions: [],
    queries: [],
    transports: [],
    parsers: [],
    views: [viewId],
    themes: [],
    configuration: [],
  });
  return () => {};
};
