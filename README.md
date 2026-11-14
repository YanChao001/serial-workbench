# Serial Workbench

使用 Tauri、Rust、React 和 TypeScript 开发的跨平台串口工作台。独立 Rust Host 管理串口、会话、录制和共享状态，桌面、CLI 与 MCP 使用同一后端。

当前工作台具备 Text/HEX 收发、文件发送、录制与只读回放、工作区和共享设置；M1b 已完成验收并合入，后续任务及验证范围见[开发进度](./docs/progress.md)。Node 插件、浏览器连接和 LAN 属于后续阶段。

[English](./README.en.md) · [工程文档](./docs/README.md) · [需求](./docs/requirements.md) · [贡献](./CONTRIBUTING.md)

## 从源码运行

工具版本读取 [package.json](./package.json)、[.nvmrc](./.nvmrc) 和 [rust-toolchain.toml](./rust-toolchain.toml)，平台依赖见[环境准备](./docs/development.md#环境与启动)。

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm dev` 提供浏览器预览；系统能力使用桌面环境。无 npm 依赖时也可运行 `node scripts/doctor.mjs`。

更新 Host 源码后若提示旧版本仍在运行，先运行 `pnpm host:stop` 正常退出后台，再运行 `pnpm app:dev`。退出会断开该 Host 的会话，设置与草稿保留；命令不会强杀或在 Host 不存在时启动它。后台已退出时，重复停止会检查 OS 实例锁并以 `alreadyStopped: true` 成功返回；仍持锁或无法核验时保留错误。

## 开发入口

- [架构](./docs/architecture.md)：目录职责、Host/桌面边界、数据与恢复。
- [规范](./docs/conventions.md)及[开发指南](./docs/development.md)：实现约束、功能接线、配置与构建。
- [测试](./docs/testing.md)：定向检查、无头 `pnpm test:ui` 及原生验收。
- [任务规划](./docs/plan.md)及[进度](./docs/progress.md)：当前问题、下一步与阶段出口。

`pnpm app:build` 生成安装包，Windows `pnpm app:portable` 生成便携文件，归档于 `artifacts/<version>/<target-triple>/`。签名、更新和公开发布尚待配置，见[构建与发布](./docs/development.md#构建与发布)。

## 许可与安全

采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。漏洞通过 [SECURITY.md](./SECURITY.md) 的私密渠道报告。编码智能体从 [AGENTS.md](./AGENTS.md) 开始。
