// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
/* global window */

// 序列化沿用 Tauri 2.12.4 process-ipc-message-fn.js 的 postMessage 路径。
// 固定单一投递通道，页面导航取消回复时不再重放已经接纳的原生调用。
(() => {
  // Builder 全文替换占位符；只放在表达式中，Z85 密钥可能含注释终止符。
  // 放在闭包中，函数源码不能读出密钥值。
  const invokeKey = __INVOKE_KEY__;
  Object.defineProperty(window.__TAURI_INTERNALS__, "postMessage", {
    value: ({ cmd, callback, error, payload, options }) => {
      const data = JSON.stringify(
        {
          cmd,
          callback,
          error,
          options: { ...options, customProtocolIpcBlocked: true },
          payload,
          __TAURI_INVOKE_KEY__: invokeKey,
        },
        (_key, value) => {
          const serialize = "__TAURI_TO_IPC_KEY__";
          if (value instanceof Map) return Object.fromEntries(value.entries());
          if (value instanceof Uint8Array) return Array.from(value);
          if (value instanceof ArrayBuffer)
            return Array.from(new Uint8Array(value));
          if (typeof value === "object" && value !== null && serialize in value)
            return value[serialize]();
          return value;
        },
      );
      window.ipc.postMessage(data);
    },
  });
})();
