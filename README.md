# Serial Workbench

Serial Workbench（`serial-workbench`）是面向嵌入式开发与设备调试的跨平台串口工作台，使用 Tauri 2、Rust、React 19 与 TypeScript 开发。当前版本提供桌面框架、设置和 Wasm 插件宿主，串口监视器（serial monitor）与串口终端（serial terminal）是后续开发目标。

关注 Serial Studio（`serial-studio`）等串口工具的开发者，可从 [产品范围](./docs/product-scope.md) 了解本项目的当前能力与开发阶段，或从 [插件市场](./marketplace/README.md) 开始编写扩展。

[English](./README.en.md) · [文档索引](./docs/README.md) · [贡献指南](./CONTRIBUTING.md) · [安全报告](./SECURITY.md)

## 从源码运行

工具版本以 [`.nvmrc`](./.nvmrc)、[`package.json`](./package.json) 和 [`rust-toolchain.toml`](./rust-toolchain.toml) 为准；平台依赖见 [开发指南](./docs/development.md#环境要求)。

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm doctor
pnpm app:dev
```

`pnpm dev` 在 `http://localhost:1420` 提供浏览器界面预览。浏览器与桌面共用 HashRouter 和界面源码，原生插件执行与系统服务需要桌面环境。未安装依赖时，也可运行 `node scripts/doctor.mjs` 诊断环境。

## 验证与构建

```sh
pnpm verify
pnpm test:ui
pnpm app:build
pnpm app:portable
```

按 [测试规范](./docs/testing.md#日常验证范围) 选择与改动相关的检查。

安装包和 Windows 便携包归档在 `artifacts/<version>/<target-triple>/`，附 SHA-256 清单。便携版仍依赖 WebView2，使用当前用户的数据目录。签名、更新和发布条件见 [构建与发布](./docs/build-release.md)。

## 工程入口

前端从 [main.tsx](./src/main.tsx) 进入 [App.tsx](./src/App.tsx)，路由统一维护在 [routes.tsx](./src/routes.tsx)；原生入口为 [main.rs](./src-tauri/src/main.rs) 与 [lib.rs](./src-tauri/src/lib.rs)。新增页面和 IPC 按 [开发流程](./docs/development.md#新增页面到-ipc-与测试) 接入。

应用身份由 [app.config.json](./app.config.json) 维护；品牌 SVG、版本与仓库链接使用对应脚本更新，见 [产品身份配置](./docs/development.md#产品身份配置)。协作采用 `main` 单主分支、短期分支与 PR squash merge，见 [Git 协作规范](./docs/conventions/git-workflow.md)。

## 开源许可

项目采用 [Apache License 2.0](./LICENSE)，版权说明见 [NOTICE](./NOTICE)。第三方组件沿用各自许可证。

[AGENTS](./AGENTS.md) · [代码签名策略](./docs/code-signing-policy.md)
