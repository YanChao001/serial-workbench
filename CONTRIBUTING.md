# 参与开发

1. 对照[需求](./docs/requirements.md)和[进度](./docs/progress.md)明确问题、预期行为及验收，读取受影响的[架构](./docs/architecture.md)。
2. 按[开发规范](./docs/conventions.md)确定边界；涉及契约、数据、权限、生命周期或发布恢复时，先说明取舍与验证。
3. 按[开发指南](./docs/development.md)实现并同步文档，执行[相关检查](./docs/testing.md#日常验证范围)。
4. 从 main 的短期分支提交中文里程碑 PR，完成自审后 squash 合入，确认主线包含交付再清理分支。具体规则见[协作](./docs/conventions.md#协作)。

PR 使用[模板](./.github/pull_request_template.md)描述最终行为、原因、结果及相关未测范围。真实窗口遵守[桌面边界](./docs/testing.md#桌面边界)；智能体同时读取 [AGENTS.md](./AGENTS.md)。

贡献默认采用 [Apache-2.0](./LICENSE)，保留 [NOTICE](./NOTICE) 和第三方归属。安全问题按 [SECURITY.md](./SECURITY.md) 私密报告。
