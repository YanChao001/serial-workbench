/* global Blob, URL, document, location, parent, window */
// 在 opaque iframe 内，用已经校验的字节加载签名包。页面 URL 保留 SDK 的帧标识。
const assets = [];
function objectUrl(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  assets.push(url);
  return url;
}

function load(event) {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.kind !== "signed-view-assets"
  )
    return;
  window.removeEventListener("message", load);
  const { html, scripts, styles } = event.data;
  const markup = document.createElement("template");
  markup.innerHTML = html;
  for (const element of markup.content.querySelectorAll(
    "script,link,meta,base,title",
  ))
    element.remove();
  document.body.replaceChildren(markup.content);
  for (const bytes of styles) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = objectUrl(bytes, "text/css");
    document.head.append(link);
  }
  for (const bytes of scripts) {
    const script = document.createElement("script");
    script.async = false;
    script.src = objectUrl(bytes, "text/javascript");
    document.head.append(script);
  }
}
window.addEventListener("message", load);
window.addEventListener(
  "pagehide",
  () => {
    for (const url of assets) URL.revokeObjectURL(url);
  },
  { once: true },
);
