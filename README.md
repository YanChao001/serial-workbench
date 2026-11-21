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

`pnpm dev` 仅启动界面预览，不会连接本机串口。Host 源码变更后若提示版本不符，先在同一 profile 下运行 `pnpm host:stop`，再运行 `pnpm app:dev`。停止 Host 会断开其会话，设置与草稿保留。

`pnpm app:build` 构建安装包；Windows 支持 `pnpm app:portable`。输出位置、签名及更新前提见[构建与发布](./docs/development.md#构建与发布)。

## 许可与安全

采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。漏洞按 [SECURITY.md](./SECURITY.md) 私密报告；编码智能体从 [AGENTS.md](./AGENTS.md) 开始。
