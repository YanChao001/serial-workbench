# AGENTS.md

适用于主仓库。先读 [README](./README.md) 和[文档索引](./docs/README.md)；`marketplace/` 是独立子模块，遵循其自身 AGENTS。

- 开始前核对工作树，保留用户未提交改动。[需求](./docs/requirements.md)定义范围，[路线与进度](./docs/plan.md)区分已交付、工作树实现和待验项。旧软件 API、存档、插件不迁入。
- 实现与评审遵循[开发规范](./docs/conventions.md)；模块、权限、生命周期、数据恢复及发布变更先按[架构](./docs/architecture.md)说明取舍、影响与验收。删除能力同步清理调用方、依赖、专属测试和文档。
- 页面、配置、IPC 与生成按[开发指南](./docs/development.md#契约与功能接线)。保留 HashRouter、共享控件/偏好模型与未保存工作登记；手写 TypeScript 用 `unknown` 收窄、不用 `any`/`enum`，系统能力统一经 `src/lib/tauri.ts`。Rust DTO 是契约来源，变更后同步生成、检查并提交绑定。
- 明确异步晚结果、授权和资源的归属；操作接纳、停止等待和真实终态分别处理。保存保持原子、revision 冲突及未来格式保护。维护中英、焦点与无障碍，`src/styles/shadcn.css` 保持上游原文。
- 从根目录用 pnpm。首次 `pnpm install --frozen-lockfile`，无依赖诊断用 `node scripts/doctor.mjs`。共享 target 的 Cargo/生成顺序运行，桌面 Rust 检查先准备 dist，保留编译缓存。
- 按[测试指南](./docs/testing.md)选择相关检查；日常 UI 用无头 `pnpm test:ui`。真实窗口、测试 exe 与截图只在独立环境或用户安排的前台时段运行。带 `-Force` 的检查与修改、删除、启停分开；遇策略拦截核对实际结果，记录仍失败的命令与错误。
- 开工、切换任务及建立额外分支或 worktree 时，读[主工作区与单任务](./docs/conventions.md#主工作区与单任务)。在主工作区用一个短期分支完成当前任务。按[贡献流程](./CONTRIBUTING.md)和[合入与清理](./docs/conventions.md#合入与清理)交付，说明实测与待验范围。
