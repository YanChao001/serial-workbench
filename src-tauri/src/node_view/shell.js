// 可信壳与插件之间只有单向流数据和当前批的确认序号。
const frame = document
  .querySelector("template")
  .content.querySelector("iframe");
const status = document.querySelector("[role=status]");
const zh = document.documentElement.lang === "zh-CN";
const frameId = document.body.dataset.frame;
let port;
let awaiting;
let script;
let timer;
let watchdog;
let retired = false;
let initialLoad = true;

function retire(code) {
  if (retired) return;
  retired = true;
  clearTimeout(timer);
  clearTimeout(watchdog);
  script?.remove();
  port?.close();
  frame.remove();
  const stop = document.createElement("script");
  stop.src = "stop.js";
  document.head.append(stop);
  status.hidden = false;
  status.textContent = zh ? `视图已停止（${code}）` : `View stopped (${code})`;
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
  if (
    retired ||
    port ||
    event.source !== frame.contentWindow ||
    event.origin !== "null" ||
    event.data !== frameId ||
    event.ports.length !== 1
  )
    return;
  port = event.ports[0];
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
frame.src = frame.dataset.src;
document.body.append(frame);
watchdog = setTimeout(() => retire("FRAME_UNAVAILABLE"), 10000);
