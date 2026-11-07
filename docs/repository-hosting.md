# 仓库托管配置

本文维护项目仓库链接和托管平台接线。当前支持 GitHub；迁移到其他平台时需实现对应发布适配器。应用身份同步见 [产品身份配置](./development.md#产品身份配置)，签名与交付见 [构建与发布](./build-release.md)。

## 修改入口

| 配置                                                  | 维护内容                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`app.config.json`](../app.config.json)               | 应用的 repositoryUrl、docsUrl、homepageUrl 和更新端点/公钥。                                             |
| [`repository.config.json`](../repository.config.json) | 源码与发行页链接模板、文档默认分支、发布来源分支、发布适配器/API地址，以及 marketplace 子模块的 gitUrl。 |

`repository.generated.json` 由同步器维护并纳入版本管理，保存上次同步的公开配置以识别旧链接。子模块地址只描述仓库位置，不配置插件下载、签名或运行能力。

应用身份使用 JSON 补丁同步，先预览差异再写入。更换产品身份或主仓库会清理旧的更新信任；同一产品迁移时，在补丁中显式提供需要保留的端点和可信公钥。

```sh
pnpm config:sync --config ../serial-workbench-config.json --dry-run
pnpm config:sync --config ../serial-workbench-config.json
pnpm repository:sync
pnpm config:check
```

`repository:sync` 更新根目录及 docs 的已知项目链接、`.gitmodules` 子模块地址、GitHub CI/Pages/Dependabot 分支配置和同步状态。归档的 Pages 模板同样接受分支同步与结构检查。固定第三方来源、许可证和测试样本保留原值。

同步后运行 `config:check`，检查配置漂移及可执行自有源码中的项目仓库 URL 字面量；单独检查托管配置可用 `repository:check`。这些检查已纳入 `verify`，重复同步应无变化。

同步使用原子替换和并发编辑检查；失败时按错误报告核对文件并保留用户改动。迁移还需分别配置本地 origin、平台项目、Secrets、保护分支、必需检查、Pages 域名和签名门户。

## 链接模板

`hosting.repositoryUrlTemplate` 使用 `{repository}`，将受控仓库身份映射为 HTTPS 源码地址。`hosting.links` 的 `file`、`commit`、`commits`、`compare`、`releases`、`release`、`releaseAsset`、`latestAsset` 定义各类链接，前端与 Node 工程脚本共用 [模板函数](../src/config/repository-links.mjs)。

链接模板使用 `{repositoryUrl}` 和相应的 `{ref}`、`{path}`、`{base}`、`{tag}`、`{asset}`。分支、标签、资产名作为单个片段编码，文件路径逐段编码；未知或缺失占位符会导致校验失败。docsUrl 和 homepageUrl 使用完整 URL，可指向独立文档站点或产品主页。

## 平台适配边界

| 入口                                                       | 当前职责                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`scripts/hosting/`](../scripts/hosting/)                  | GitHub API 请求、PR/Release 元数据、草稿与附件处理、Actions 事件/输出/环境变量、签名 artifact 选择和最终公开。 |
| [`scripts/release-lib.mjs`](../scripts/release-lib.mjs)    | 稳定的发布命令入口，按显式 hosting.provider 检查适配器；未知平台在远端操作前失败。                             |
| [`.github/`](../.github/) 与 [`.signpath/`](../.signpath/) | GitHub Actions、Pages、Dependabot、模板和可选 SignPath connector 的平台文件。                                  |

修改 URL 或页面路径时优先改配置；改变 Release API、认证或 CI 产品时，在上述入口实现并验证适配器，再设置 provider。平台环境变量与工作流按对应平台协议维护，业务代码通过适配入口调用。

更新客户端读取 HTTPS 的 Tauri 更新清单，发布端按配置模板核对仓库、tag 与资产名。迁移时保留已发布客户端可访问的更新入口和既有签名信任，必要时先发布过渡版本，流程见 [自动更新](./build-release.md#自动更新)。
