export function ansiLinkUrl(uri: string): string | undefined {
  if (
    uri.length > 2048 ||
    !/^https?:\/\//i.test(uri) ||
    Array.from(uri).some(
      (character) => character.charCodeAt(0) <= 32 || character === "\\",
    )
  )
    return;
  try {
    const url = new URL(uri);
    if (url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}

export function createAnsiLinkIndex() {
  const listeners = new Set<() => void>();
  let urls: readonly string[] = [];
  function publish(next: readonly string[]) {
    urls = next;
    for (const listener of listeners) listener();
  }
  return {
    snapshot: () => urls,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addOsc(data: string) {
      const separator = data.indexOf(";");
      if (separator === -1) return;
      const href = ansiLinkUrl(data.slice(separator + 1));
      if (href && !urls.includes(href)) publish([...urls.slice(-15), href]);
    },
    clear() {
      if (urls.length) publish([]);
    },
  };
}
