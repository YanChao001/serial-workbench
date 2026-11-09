# 停用工作流

本目录保留 Pages 与 release 模板，GitHub 不从此处执行工作流。活跃目录中的 CI/audit 仅手动触发。

启用前按[构建与发布](../../docs/development.md#构建与发布)落实身份、域名、Secrets、签名、更新和目标平台验收，再将模板移入 `.github/workflows/`。核对 Actions 完整 SHA、输入和实际工具行为；仓库同步器仍维护模板的受管配置。部署与公开发布按对应任务取得授权后执行。
