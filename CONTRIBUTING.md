# 参与开发

1. 从[路线与进度](./docs/plan.md#当前任务顺序)取当前一项任务，依据[需求](./docs/requirements.md)和[架构](./docs/architecture.md)明确问题、交付范围及验收。
2. 核对主工作区，从最新 `main` 切一个短期分支，按[主工作区与单任务](./docs/conventions.md#主工作区与单任务)处理需要额外分支或 worktree 的例外。
3. 按[开发指南](./docs/development.md)实现并同步文档，执行[相关检查](./docs/testing.md#日常验证范围)。
4. 提交当前任务的中文 PR，按[合入与清理](./docs/conventions.md#合入与清理)验收并 squash 合入。同步本地 `main`，清理已交付分支和临时 worktree，更新进度后接续下一项。

PR 使用[模板](./.github/pull_request_template.md)描述最终行为、原因、结果及相关未测范围。真实窗口遵守[桌面边界](./docs/testing.md#桌面边界)；智能体同时读取 [AGENTS.md](./AGENTS.md)。

贡献默认采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。安全问题按 [SECURITY.md](./SECURITY.md) 私密报告。
