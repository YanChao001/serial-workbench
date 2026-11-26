# global-hotkey 0.10.0

源码和许可证来自 crates.io 的 `global-hotkey 0.10.0` 发布归档，对应上游提交 `41b011d42b90498e507754b96ec5909d7bcd6f67`。归档 SHA‑256 为 `96daa86bdc1413406daee362a835e52c430c2193e5a5c328d1e522be140d1764`。保留库源码及原许可，移除上游示例和开发依赖。 [上游发布](https://github.com/tauri-apps/global-hotkey/releases/tag/global-hotkey-v0.10.0)

X11 注销通过 `VoidCookie::check` 等待服务端处理各锁定修饰键组合的 `UngrabKey`，之后才移除本地登记。项目沿用现有库和锁定依赖，源码补丁随仓库分发以便离线构建。IO-08 的 X11 验收由第二个 X11 客户端在停用后接管原键验证。上游发布相同修复后替换为正式版本，并复跑该验收。 [上游修复](https://github.com/tauri-apps/global-hotkey/pull/197) · [停用后系统仍占键的收据](https://github.com/YanChao001/serial-workbench/actions/runs/45893732856/artifacts/15152792583)
