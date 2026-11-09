# AGENTS.md

本文件适用于主仓库。先读 [README](./README.md) 和[文档索引](./docs/README.md)，再读取任务相关指南与源码。`marketplace/` 按其自身 AGENTS 管理。

## 按任务读取

- 实现、评审或文档维护：读取[开发规范](./docs/conventions.md)的对应章节；提交与 PR 同时遵循[贡献流程](./CONTRIBUTING.md)。
- 功能与范围：读[需求](./docs/requirements.md)、[当前进度](./docs/progress.md)和[任务计划](./docs/plan.md)；区分需求、实现和验收。
- 模块、状态、权限、生命周期或恢复：读[架构](./docs/architecture.md)。高影响变更先说明取舍、影响与验收。
- 页面、IPC、配置、资源或构建：按[开发指南](./docs/development.md)接线；契约变化读取[对应契约](./docs/contracts/README.md)。
- 验证与交付：按[测试](./docs/testing.md)选择相关检查；文档修改核对事实、路径和标题锚点。

## 实现约束

- 复用合理职责，重设计不合理模型；旧软件 API、存档和插件不兼容、不迁入。删除能力同步清理依赖、桥接、专属测试与失效文档。
- 手写 TypeScript 使用 `unknown` 收窄未知输入，禁止 `any`/`enum`；系统能力统一经 `src/lib/tauri.ts`。Rust DTO 是契约来源，签名/注册变化后生成、检查并提交绑定。
- 保留 HashRouter，路由与导航集中在 `src/routes.tsx`，命令复用 `src/commands/`。局部草稿留在组件，共享偏好使用现有 Provider/模型/同步器；未保存工作登记 `useUnsavedWork`。
- 异步处理卸载、StrictMode、切换和晚结果；原生任务用有界预算与合作取消，真实完成后归还资源。Operation 接纳、停止等待和实际终态分别处理。
- 保存保持原子提交、revision 冲突、未来格式写保护及原件；用户数据、密钥与失败证据按所属边界保留。
- 界面使用共享控件/语义 token，维护焦点、键盘、无障碍及中英文案；持续动效随活动状态清理。保留 UI 上游兼容与本地修复，`src/styles/shadcn.css` 保持上游原文。

## 环境与交付

使用 pnpm，首次 `pnpm install --frozen-lockfile`；版本读取配置，命令从根运行，无依赖诊断用 `node scripts/doctor.mjs`。共享 target 的 Cargo/生成任务顺序执行，桌面 Rust 检查先准备 dist，保留编译缓存。

日常 UI 运行无头 `pnpm test:ui`；真实窗口、测试 exe 和截图只在独立环境或用户安排的前台时段运行。相关检查通过即可交付，新增变化或明确疑点再补验证。

保留用户未提交改动。所有分支保持线性，经短期分支 PR squash 合入 main；同一里程碑的实现、测试、审阅与文档集中提交，提交/PR 使用中文。交付说明改动、实际检查和相关未测范围。

带 `-Force` 的检查与修改、删除、服务启停分开执行；遇 blocked by policy 核验混用操作及实际结果，记录仍失败的命令和错误。
