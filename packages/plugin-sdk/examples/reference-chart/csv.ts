export function csvCell(value: string | undefined) {
  if (value === undefined) return "";
  return /[,"\r\n]/u.test(value)
    ? '"' + value.replaceAll('"', '""') + '"'
    : value;
}

export function spreadsheetText(value: string | undefined) {
  // 工作表打开 CSV 时可能计算用户填写的文本。测量值单独按数值输出。
  return value && /^(?:[\t\r\n]|\s*[=+@-])/u.test(value) ? "'" + value : value;
}
