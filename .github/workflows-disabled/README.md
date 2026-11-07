# 发布模板归档

这里保存 Serial Workbench 的 `pages.yml` 和 `release.yml` 模板。GitHub 从 `.github/workflows/` 读取工作流，本目录用于归档。

当前 GitHub Actions 停用，CI 与依赖审计配置保留在原工作流目录。应用更新端点与公钥、代码签名和 Pages 环境待配置。

恢复时按 [构建与发布](../../docs/build-release.md) 核对仓库、产品身份、密钥、目标平台与安装验收，取得部署或公开发布授权后，将相应模板移回活跃工作流目录并启用 Actions。仓库同步器继续维护 Pages 模板的分支配置。

停用目录不在 Dependabot 的 GitHub Actions 更新范围内。恢复前人工核对各 Action 的版本、固定 SHA 与输入参数，并运行静态检查；恢复后再纳入自动更新。
