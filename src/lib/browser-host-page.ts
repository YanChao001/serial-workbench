export function browserHostClientId(): string | undefined {
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1")
    return;
  if (
    document.querySelector<HTMLMetaElement>(
      'meta[name="serial-workbench-host"]',
    )?.content !== "browser"
  )
    return;
  return document.querySelector<HTMLMetaElement>(
    'meta[name="serial-workbench-browser-id"]',
  )?.content;
}
