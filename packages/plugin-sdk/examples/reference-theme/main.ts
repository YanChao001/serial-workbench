import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";

export const register: NodeRegister = (context) => {
  context.configuration.registerQuery(
    "swb.reference.theme.configuration",
    () => ({}),
  );
  context.contributions.register({
    actions: [],
    queries: [],
    transports: [],
    parsers: [],
    views: [],
    themes: ["swb.reference.theme.bench-teal"],
    configuration: [],
  });
  return () => {};
};
