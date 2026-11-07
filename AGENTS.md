# AGENTS.md

本文件适用于整个仓库。先读 [README](./README.md) 和 [文档索引](./docs/README.md)，再按任务读取相关指南与源码；日常流程见 [贡献指南](./CONTRIBUTING.md)。

## 产品与入口

- 当前功能见 [产品范围](./docs/product-scope.md)，架构边界见 [ADR 0026](./docs/adr/0026-independent-shell-boundary.md)。
- 路由、懒加载、预载和导航统一在 `src/routes.tsx`；菜单、命令面板和快捷键复用 `src/commands/`。诊断恢复归入设置，故障隔离保留受保护入口。
- 新增页面或原生能力按 [页面到 IPC 流程](./docs/development.md#新增页面到-ipc-与测试) 接线。跨模块、兼容、权限、窗口生命周期或发布恢复变更，先说明影响与验收；门槛见 [设计评审](./docs/engineering-at-scale.md#设计评审与-adr-门槛)。

## 实现约束

- 按独立新体系重构：复用职责合理的现有实现，不合理的接口与状态模型直接重设计。旧软件的 API、数据格式和插件体系不提供兼容或迁入；删除功能时连同依赖、SDK、桥接、专属测试和失效指南一并清理。
- 手写 TypeScript 统一通过 `src/lib/tauri.ts` 使用系统能力。Rust 命令 / DTO 是契约来源；签名、DTO 或绑定注册变化后，按 [IPC 流程](./docs/development.md#新增页面到-ipc-与测试) 生成、检查并提交绑定。
- 页面状态留在组件，公共偏好复用设置 Provider、模型与同步器。存储保留原子写入、revision 冲突和未来格式保护，恢复保留用户原件；异步订阅处理卸载、StrictMode 与晚到结果，职责见 [架构](./docs/architecture.md)。
- 未保存工作登记 `useUnsavedWork`，沿用离页协商和 AbortSignal。原生工作使用有界队列与合作取消，停止等待不代表已停止或回滚。恢复保留原件、归档和失败证据。
- 保留 HashRouter，原生门面检查运行环境；浏览器偏好与原生存档分开。测试 fixture 用于契约验证，新插件按统一 Node 契约接入。
- 手写 TypeScript 使用 `unknown` 收窄未知输入，不使用 `any` / `enum`；原生错误按稳定 `code` 处理。命名、Rust 分层和抽象规则见 [代码风格](./docs/conventions/code-style.md)。
- 界面复用语义 token 和控件，维护焦点、键盘与无障碍语义，文案同步中英词典。持续动效消费现有活动状态并清理，见 [界面规范](./docs/conventions/ui-guidelines.md)。`src/components/ui/` 保留上游兼容与本地修复，`src/styles/shadcn.css` 保持上游原文。

## 环境、验证与交付

使用 pnpm，首次安装执行 `pnpm install --frozen-lockfile`。版本读取 `.nvmrc`、`package.json` 和 `rust-toolchain.toml`；命令从仓库根目录运行。未安装依赖可运行 `node scripts/doctor.mjs`，详见 [开发指南](./docs/development.md)。

- 按 [日常验证范围](./docs/testing.md#日常验证范围) 选择检查；检查通过即可交付，新改动、失败或明确疑点出现时再验证。
- 日常界面检查使用无头 `pnpm test:ui`。真实窗口、测试 exe 和截图只在独立环境或用户安排的前台时段运行，见 [桌面干扰边界](./docs/testing.md#避免干扰本机桌面)。
- Rust 检查先准备 `dist/`，共享 target 的 Rust 检查与绑定任务顺序执行；保留编译缓存。
- 交付说明改动、执行的检查及影响结论的未测范围。
- 带 `-Force` 的检查与修改、删除、服务启停分开调用。遇到 `blocked by policy`，先检查脚本是否混用操作，再核验实际结果并记录仍失败的命令与错误。

## 配置、安全与协作

身份由 `app.config.json` 维护，变更通过 [产品身份配置](./docs/development.md#产品身份配置) 同步；版本用 `pnpm version:set`，品牌 SVG 通过生成脚本更新图标与安装器资源。修改资源源文件并提交生成结果。

IPC、路径、存储、外链和权限变化按 [安全规范](./docs/security.md) 处理。密钥使用受控渠道与系统存储，`VITE_` 仅放公开配置，日志保持脱敏。依赖与锁文件变更按 [依赖评审](./docs/development.md#新增依赖的评审标准) 处理。

新增、改写或审查文档时，按 [维护规则](./docs/README.md#维护规则) 核对事实与链接，按 [写作与免责措辞](./docs/README.md#写作与免责措辞) 处理提醒、限制和验收说明。保留许可证与第三方合法归属。所有改动从 `main` 的短期分支经 PR squash merge 合回，规则见 [Git 协作规范](./docs/conventions/git-workflow.md)。
