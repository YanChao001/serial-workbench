export function queryArgs(action, targetFile, paramsFile) {
  return [
    "query",
    action,
    "--target-json",
    targetFile,
    "--params-json",
    paramsFile,
  ];
}
