# 停用工作流

此处的 Pages 与 release 模板不会执行。手动 CI、专项预检与审计见[持续集成](../../docs/testing.md#持续集成)。

启用前按[构建与发布](../../docs/development.md#构建与发布)落实身份、域名、Secrets、签名、更新和目标平台验收，再将模板移入 `.github/workflows/`。核对 Actions 完整 SHA、输入和实际工具行为；仓库同步器仍维护模板的受管配置。部署与公开发布按对应任务取得授权后执行。
