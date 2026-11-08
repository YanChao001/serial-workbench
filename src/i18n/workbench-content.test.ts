import { expect, it } from "vitest";
import { zhCN } from "./zh-CN";

it("keeps the serial workbench names as actual Chinese text", () => {
  expect(zhCN["nav.overview"]).toBe("串口工作台");
  expect(zhCN["workbench.title"]).toBe("串口工作台");
  expect(zhCN["workbench.tools.parameters"]).toBe("连接参数");
  expect(zhCN["workbench.tools.saveCurrentLayout"]).toBe("保存当前布局");
});

it("contains no consecutive ASCII question mark placeholders in Chinese content", () => {
  const corrupted = Object.entries(zhCN).filter(([, value]) =>
    /\?{2,}/.test(value),
  );
  expect(corrupted).toEqual([]);
});
