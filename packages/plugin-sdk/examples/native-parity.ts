import type { NodeRegister, Query } from "@serial-workbench/plugin-sdk/node";

// 原生验收以实际manifest贡献ID替换此标记；业务只使用公开SDK上下文。
const actionId = "__SWB_TEST_ACTION_ID__";

function createHandler() {
  let calls = 0;
  return (request: Readonly<Pick<Query, "params">>) => {
    const value = request.params.value;
    if (typeof value !== "number") throw new Error("Expected numeric value");
    return { value: value + 0.25, calls: ++calls };
  };
}

export const registerAction: NodeRegister = (context) => {
  context.actions.register(actionId, createHandler());
  return () => {};
};

export const registerQuery: NodeRegister = (context) => {
  context.queries.register(actionId, createHandler());
  return () => {};
};
