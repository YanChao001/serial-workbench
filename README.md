# Serial Workbench

跨平台串口工作台。Tauri 桌面、CLI 和 MCP 共用 Rust Host，支持 Text/HEX 收发、文件发送、录制、只读回放和共享工作区。可信 Node 插件扩展能力。桌面可配对浏览器，Host 可在 LAN 共享串口。 [路线与进度](./docs/plan.md)

[English](./README.en.md) · [工程文档](./docs/README.md) · [贡献](./CONTRIBUTING.md)

## 从源码运行

使用 [.nvmrc](./.nvmrc) 指定的 Node、[package.json](./package.json) 中的 pnpm 和 rustup，先准备[平台依赖](./docs/development.md#环境与启动)，再从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm dev` 仅预览界面。实际设备使用 `pnpm app:dev`，浏览器走[桌面配对](./docs/development.md#浏览器访问)。缺少 `dist`、环境缺项或 Host 不匹配见[启动与排障](./docs/development.md#环境与启动)。

用 `pnpm app:build` 构建安装包，Windows 便携包用 `pnpm app:portable`。产物与签名见[构建与发布](./docs/development.md#构建与发布)。

## 许可与安全

采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。漏洞按 [SECURITY.md](./SECURITY.md) 私密报告；编码智能体从 [AGENTS.md](./AGENTS.md) 开始。
