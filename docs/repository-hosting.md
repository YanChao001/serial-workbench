# 仓库托管配置

本文维护项目仓库链接、下载来源和托管平台接线。当前支持 GitHub；迁移到其他平台时需实现对应发布适配器。应用身份同步见 [产品身份配置](./development.md#产品身份配置)，签名与交付见 [构建与发布](./build-release.md)。

## 修改入口

| 配置                                                                          | 维护内容                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`app.config.json`](../app.config.json)                                       | 应用的 `repositoryUrl`、`docsUrl`、`homepageUrl`、更新端点 / 公钥，以及市场仓库身份 / 公钥                                                                  |
| [`repository.config.json`](../repository.config.json)                         | 源码与发行页链接模板、文档默认分支、发布来源分支、发布适配器 / API 地址、市场子模块地址、目录 / 包地址模板和下载目录前缀                                    |
| [`marketplace/repository.config.json`](../marketplace/repository.config.json) | 独立市场的托管链接、配套宿主仓库与默认 ref、跨仓库文档 ref 和壁纸 User-Agent 模板；详见其 [开发指南](../marketplace/docs/development.md#仓库来源与平台入口) |

`repository.generated.json` 由同步器维护并纳入版本管理，保存上次同步的公开配置以识别旧链接。市场维护自己的同名状态文件，签名目录身份以 `marketplace/listings.json.repository` 为准。

应用身份使用 JSON 补丁同步，先预览差异再写入。更换产品身份或主仓库会清理旧的更新与市场信任；同一产品迁移时，在补丁中显式提供需要保留的端点和可信公钥。

```sh
pnpm config:sync --config ../serial-workbench-config.json --dry-run
pnpm config:sync --config ../serial-workbench-config.json
pnpm repository:sync
pnpm config:check
```

`repository:sync` 更新根目录及 `docs/` 的已知项目链接、`.gitmodules` 市场地址、GitHub CI / Pages / Dependabot 分支配置和同步状态。归档的 Pages 模板同样接受分支同步与结构检查；市场已初始化时，还会调用市场自己的同步入口。固定第三方来源、许可证和测试样本保留原值。

同步后运行 `config:check`，检查配置漂移及可执行自有源码中的项目仓库 URL 字面量；单独检查托管配置可用 `repository:check`。这些检查已纳入 `verify`，重复同步应无变化。

同步使用原子替换和并发编辑检查；失败时按错误报告核对文件并保留用户改动。迁移还需分别配置本地 `origin`、平台项目、Secrets、保护分支、必需检查、Pages 域名和签名门户。

## 模板与下载规则

`hosting.repositoryUrlTemplate` 使用 `{repository}`，将受控仓库身份映射为 HTTPS 源码地址。`hosting.links` 的 `file` / `commit` / `commits` / `compare` / `releases` / `release` / `releaseAsset` / `latestAsset` 定义各类链接，前端与 Node 共用 [模板函数](../src/config/repository-links.mjs)。

链接模板使用 `{repositoryUrl}` 和相应的 `{ref}`、`{path}`、`{base}`、`{tag}`、`{asset}`。分支、标签、资产名作为单个片段编码，文件路径逐段编码；未知或缺失占位符会导致校验失败。`docsUrl` 和 `homepageUrl` 使用完整 URL，可指向独立文档站点或产品主页。

市场传输由同一份根配置编译进入 Rust：`catalogUrlTemplate` 定义目录位置，`packageUrlTemplate` 通过已签名条目的 tag / asset 构造包位置，`downloadUrlPrefixes` 同时约束初始请求与逐跳重定向。前缀必须是以 `/` 结尾的 HTTPS 目录，无凭据、查询参数或 fragment，仅允许默认 443 端口。按规范化 origin 与目录前缀匹配；任一前缀无效时整个策略拒绝。实际下载 URL 可保留 CDN 的签名查询参数。

下载来源编译在安装包中，前端按配置请求。迁移传输位置时，保留市场仓库 / 公钥身份、防降级记录、目录验签、包哈希和权限规则。当前市场身份使用 `owner/repo` 两段格式，其他身份格式和 API 在迁移时适配。

## 平台适配边界

| 入口                                                              | 当前职责                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/hosting/`](../scripts/hosting/)                         | GitHub API 请求、PR / Release 元数据、草稿与附件处理、Actions 事件 / 输出 / 环境变量、签名 artifact 选择和最终公开        |
| [`scripts/release-lib.mjs`](../scripts/release-lib.mjs)           | 保留稳定的发布命令入口，按显式 `hosting.provider` 检查适配器；未知平台在远端操作前失败                                    |
| [`.github/`](../.github/) 与 [`.signpath/`](../.signpath/)        | GitHub Actions、Pages、Dependabot、模板和可选 SignPath connector 的平台文件；上游 action 地址及凭据键名属于这些集成的协议 |
| [`marketplace/scripts/hosting/`](../marketplace/scripts/hosting/) | 独立市场的 GitHub 发布操作与源码 tag 复核                                                                                 |

修改 URL 或页面路径时优先改配置；改变 Release / MR API、认证或 CI 产品时，在上述入口实现并验证适配器，再设置 `provider`。平台环境变量与工作流按对应平台协议维护，业务代码通过适配入口调用。

更新客户端读取 HTTPS 的 Tauri 更新清单，发布端按配置模板核对仓库、tag 与资产名。迁移时保留旧客户端可访问的更新入口和既有签名信任，必要时先发布过渡版本，流程见 [自动更新](./build-release.md#自动更新)。
