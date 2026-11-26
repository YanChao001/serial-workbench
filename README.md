# Serial Workbench

跨平台串口工作台。独立 Rust Host 管理串口、会话与录制，Tauri 桌面、CLI 和 MCP 共用同一后端。支持 Text/HEX 收发、文件发送、录制与只读回放、工作区及共享设置。通过可信 Node 插件扩展能力，配对后可从浏览器访问或在局域网共享串口。 [路线与进度](./docs/plan.md)

[English](./README.en.md) · [工程文档](./docs/README.md) · [贡献](./CONTRIBUTING.md)

## 从源码运行

使用 [.nvmrc](./.nvmrc) 指定的 Node、[package.json](./package.json) 中的 pnpm 和 rustup，先准备[平台依赖](./docs/development.md#环境与启动)，再从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm app:dev` 启动可操作本机设备的桌面开发环境。仅查看界面可运行 `pnpm dev`，此入口不附着本机 Host。[配对浏览器](./docs/development.md#浏览器访问)从桌面设置进入，由 Host 提供生产资源。遇到缺少 `dist`、环境缺项或 Host 版本不一致，按[启动与排障](./docs/development.md#环境与启动)处理。

`pnpm app:build` 构建安装包。Windows 还可用 `pnpm app:portable` 构建便携包。输出位置、运行时依赖、签名及更新前提见[构建与发布](./docs/development.md#构建与发布)。

## 许可与安全

采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。漏洞按 [SECURITY.md](./SECURITY.md) 私密报告；编码智能体从 [AGENTS.md](./AGENTS.md) 开始。
