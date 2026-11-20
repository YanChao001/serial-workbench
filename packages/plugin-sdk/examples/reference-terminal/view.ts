/// <reference lib="dom" />
import { connectReadOnlyView } from "@serial-workbench/plugin-sdk/web";

const status = document.querySelector<HTMLElement>("#connection");
const title = document.querySelector<HTMLElement>("#title");
const receive = document.querySelector<HTMLPreElement>("#receive");
if (!status || !title || !receive) throw new Error("Monitor layout is missing");

const displayLimit = 256 * 1024;
let displayed = 0;
let lineStart = true;
let zh = false;
let rx = new TextDecoder();
const deviceText = (value: string) =>
  value.replace(
    // eslint-disable-next-line no-control-regex -- Display literal serial control bytes safely.
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    (character) =>
      "\\x" + character.charCodeAt(0).toString(16).padStart(2, "0"),
  );

// 设备字节只进入文本节点。显示树有独立预算，Host 的录制不受裁剪影响。
function append(text: string) {
  if (!(receive instanceof HTMLPreElement) || !text) return;
  const atEnd =
    receive.scrollHeight - receive.clientHeight - receive.scrollTop < 4;
  const node = document.createTextNode(text.slice(-displayLimit));
  receive.appendChild(node);
  displayed += node.length;
  while (
    (displayed > displayLimit || receive.childNodes.length > 1024) &&
    receive.firstChild instanceof Text
  ) {
    displayed -= receive.firstChild.length;
    receive.firstChild.remove();
  }
  if (atEnd) receive.scrollTop = receive.scrollHeight;
}

function decode(base64: string, decoder: TextDecoder, stream = false) {
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0),
  );
  return deviceText(decoder.decode(bytes, { stream }));
}

function addDisplayLine(parts: string[], text: string) {
  if (!lineStart) parts.push("\n");
  parts.push(text);
  if (!text.endsWith("\n")) parts.push("\n");
  lineStart = true;
}

const view = connectReadOnlyView({
  onSession() {
    status.textContent = zh ? "正在监听" : "Listening";
  },
  onBatch(batch) {
    const terms: string[] = [];
    for (const item of batch.items) {
      if (item.kind === "reader_gap" || item.event.kind === "gap") {
        rx = new TextDecoder();
        addDisplayLine(
          terms,
          zh ? "[部分串口数据缺失]" : "[Some serial data is missing]",
        );
      } else if (item.event.kind === "rx") {
        const text = decode(item.event.payload.bytesBase64, rx, true);
        terms.push(text);
        if (text) lineStart = text.endsWith("\n");
      } else if (item.event.kind === "tx") {
        addDisplayLine(
          terms,
          `[TX] ${decode(item.event.payload.bytesBase64, new TextDecoder())}`,
        );
      }
    }
    append(terms.join(""));
  },
  onError() {
    status.textContent = zh ? "监听已断开" : "Monitor disconnected";
  },
});
zh = view.locale === "zh-CN";
document.documentElement.lang = view.locale;
document.documentElement.dataset.theme = view.dark ? "dark" : "light";
if (zh) {
  document.title = "串口监听";
  title.textContent = document.title;
  status.textContent = "正在连接…";
  receive.setAttribute("aria-label", "串口数据");
}
