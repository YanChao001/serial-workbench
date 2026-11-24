function dialogField(tag: "button" | "input", label: string) {
  return `//*[@role='dialog']//${tag}[@id = ancestor::*[@role='dialog'][1]//label[normalize-space(.)=${JSON.stringify(label)}]/@for]`;
}

export const pairingMode = dialogField("button", "Access level");
export const pairingCode = dialogField("input", "Pairing code");

export function takeoverNotice(port: string, currentClient: string) {
  const field = (label: string, value: string) =>
    `.//dt[normalize-space(.)=${JSON.stringify(label)}]/following-sibling::*[1][self::dd and normalize-space(.)=${JSON.stringify(value)}]`;
  return `//*[@role='group' and @aria-label='Browser requests write access'][${field("Port", port)} and ${field("Current client", currentClient)}]`;
}
