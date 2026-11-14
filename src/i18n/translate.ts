import { zhCN, type MessageKey, type Messages } from "./zh-CN";

export type MessageVariables = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: MessageVariables) => string;

/** 运行时也有默认语言兜底，替换一次占位符，保留未知变量。 */
export function createTranslator(messages: Partial<Messages>): Translate {
  return (key, vars) => {
    // 开发热更新可能短暂混用新调用方与旧词典，仍保留可显示的结果。
    const template = messages[key] || zhCN[key] || key;
    return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
      vars && Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
    );
  };
}
