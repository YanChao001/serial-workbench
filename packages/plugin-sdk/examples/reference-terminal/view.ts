/// <reference lib="dom" />
import { connectReadOnlyView } from "@serial-workbench/plugin-sdk/web";

const status = document.querySelector<HTMLElement>("#connection");
const receive = document.querySelector<HTMLPreElement>("#receive");
if (!status || !receive) throw new Error("Terminal layout is missing");

const displayLimit = 256 * 1024;
let displayed = 0;
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

const view = connectReadOnlyView({
  onSession(session) {
    status.textContent = zh
      ? `会话 ${session.sessionId}`
      : `Session ${session.sessionId}`;
  },
  onBatch(batch) {
    const terms: string[] = [];
    for (const item of batch.items) {
      if (item.kind === "reader_gap" || item.event.kind === "gap") {
        rx = new TextDecoder();
        const range =
          item.kind === "reader_gap" ? item.gap.missingEventRange : undefined;
        const detail = range ? ` ${range.start}–${range.end}` : "";
        terms.push(zh ? `\n[数据缺口${detail}]\n` : `\n[Data gap${detail}]\n`);
      } else if (item.event.kind === "rx") {
        terms.push(decode(item.event.payload.bytesBase64, rx, true));
      } else if (item.event.kind === "tx") {
        terms.push(
          `\n[TX] ${decode(item.event.payload.bytesBase64, new TextDecoder())}\n`,
        );
      }
    }
    append(terms.join(""));
  },
  onError() {
    status.textContent = zh
      ? "终端视图连接已断开"
      : "Terminal view disconnected";
  },
});
zh = view.locale === "zh-CN";
document.documentElement.lang = view.locale;
document.documentElement.dataset.theme = view.dark ? "dark" : "light";
if (zh) {
  document.title = "串口工作台终端";
  status.textContent = "正在连接 Host 会话…";
  receive.setAttribute("aria-label", "收到的数据");
}
