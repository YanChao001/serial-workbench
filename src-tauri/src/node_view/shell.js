// 可信壳交付只读数据与订阅的语言变更，插件仅确认当前批。
const frame = document
  .querySelector("template")
  .content.querySelector("iframe");
const status = document.querySelector("[role=status]");
let locale = document.documentElement.lang;
const frameId = document.body.dataset.frame;
let port;
let awaiting;
let script;
let timer;
let watchdog;
let retired = false;
let retirementCode;
let initialLoad = true;
let localeUpdates = false;
let snapshotSent = false;

globalThis.swbViewSetLocale = (value) => {
  if (value !== "en" && value !== "zh-CN") return;
  locale = value;
  document.documentElement.lang = locale;
  if (retirementCode !== undefined) {
    status.textContent =
      locale === "zh-CN"
        ? `视图已停止（${retirementCode}）\n请关闭此窗口，再从工作台重新打开视图。`
        : `View stopped (${retirementCode})\nClose this window and reopen the view from the workbench.`;
  } else if (!port && !retired) {
    status.textContent =
      locale === "zh-CN" ? "正在打开插件视图…" : "Opening plugin view…";
  }
  if (localeUpdates && snapshotSent && !retired)
    port.postMessage({ kind: "viewLocale", locale });
};

function retire(code) {
  if (retired) return;
  retired = true;
  retirementCode = code;
  clearTimeout(timer);
  clearTimeout(watchdog);
  script?.remove();
  port?.close();
  frame.remove();
  const stop = document.createElement("script");
  stop.src = `stop.js?${encodeURIComponent(code)}`;
  document.head.append(stop);
  status.hidden = false;
  globalThis.swbViewSetLocale(locale);
}
function pull() {
  if (retired || !port || script || awaiting !== undefined || document.hidden)
    return;
  script = document.createElement("script");
  script.src = "next.js";
  script.onerror = () => retire("CONNECTION");
  document.head.append(script);
}
globalThis.swbViewReceive = (message) => {
  script?.remove();
  script = undefined;
  if (retired) return;
  if (!message) {
    timer = setTimeout(pull, 100);
    return;
  }
  if (message.error) {
    retire(message.error);
    return;
  }
  if (message.snapshot) {
    port.postMessage({
      ok: true,
      result: { kind: "session", value: message.snapshot },
    });
    snapshotSent = true;
    if (localeUpdates) port.postMessage({ kind: "viewLocale", locale });
    pull();
    return;
  }
  if (message.derived) {
    awaiting = message.derived.reply.result.value.nextPosition;
    watchdog = setTimeout(() => retire("UNACKNOWLEDGED"), 10000);
    port.postMessage(message.derived);
    return;
  }
  const wire = message.frame;
  if (!wire) {
    timer = setTimeout(pull, 100);
    return;
  }
  if (wire.body.type === "rawBatch") {
    awaiting = wire.body.batch.cursor.position;
    watchdog = setTimeout(() => retire("UNACKNOWLEDGED"), 10000);
    port.postMessage(wire);
  } else {
    retire(wire.body.error?.code ?? "STREAM_ENDED");
  }
};
window.addEventListener("message", (event) => {
  const wantsLocale =
    event.data?.frameId === frameId && event.data.localeUpdates === true;
  if (
    retired ||
    port ||
    event.source !== frame.contentWindow ||
    event.origin !== "null" ||
    (event.data !== frameId && !wantsLocale) ||
    event.ports.length !== 1
  )
    return;
  port = event.ports[0];
  localeUpdates = wantsLocale;
  clearTimeout(watchdog);
  port.onmessage = ({ data }) => {
    if (awaiting === undefined || data !== awaiting) return;
    awaiting = undefined;
    clearTimeout(watchdog);
    pull();
  };
  port.onmessageerror = () => retire("INVALID_MESSAGE");
  status.hidden = true;
  pull();
});
frame.addEventListener("load", () => {
  if (!initialLoad) retire("FRAME_CHANGED");
  initialLoad = false;
});
document.addEventListener("visibilitychange", pull);
window.addEventListener(
  "pagehide",
  () => {
    retired = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    port?.close();
  },
  { once: true },
);
globalThis.swbViewSetLocale(locale);
const source = new URL(frame.dataset.src);
const [identifier, , scheme, capability] = source.hash.slice(1).split(".");
source.hash = [identifier, locale, scheme, capability].join(".");
frame.src = source.href;
document.body.append(frame);
watchdog = setTimeout(() => retire("FRAME_UNAVAILABLE"), 10000);
