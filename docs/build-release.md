# 构建与发布

当前交付应用空壳，应用更新端点与公钥为空，代码签名和公开发布待配置。里程碑 CI 采用手动检查；正式发布工作流仍停用，[release.yml](../.github/workflows-disabled/release.yml) 保存在 [模板归档](../.github/workflows-disabled/README.md) 中。本文的自动化流程供恢复发布时使用。

按交付的平台、格式和通道选择相应章节，命令从仓库根目录执行。普通 PR 使用 [日常验证范围](./testing.md#日常验证范围)；签名资格与范围见 [代码签名策略](./code-signing-policy.md)，运行时信任边界见 [安全规范](./security.md)。

## 版本号：四个地方必须一致

使用脚本同步版本：

```sh
pnpm version:set 1.2.0
pnpm version:check
```

脚本同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 的自身包版本；写入失败回滚，并发冲突保留用户内容与备份。`version:check` 核对版本一致性，发布模板还会核对 `v<version>` tag。

版本号更新与其他改动一样，从 `main` 创建短期分支，经普通 PR 合入 `main`。在该 PR 准备本次版本的公开摘要与升级限制，合入后完成验收，再从已确认的 `main` 提交打 tag；具体步骤见 [Git 发布流程](./conventions/git-workflow.md#发布流程)。

当前包含 MSI，主版本 ≤ 255、次版本 ≤ 255、修订版本 ≤ 65535；预发布或构建元数据用作第四段时须为 ≤ 65535 的整数。`beta.1` 等文本需显式设置 `bundle.windows.wix.version`，或先从配置移除 MSI；仅传 `--bundles nsis` 不改变版本校验依据。NSIS 各主版本段也须 ≤ 65535，完整规则见 [版本脚本](../scripts/version.mjs)。

已发布版本号不复用；自动更新和安装器的版本限制见 [回滚](#回滚)。

## 构建

```sh
pnpm app:build # 默认优先压缩程序体积
pnpm app:build --bundles nsis # 只交付一种格式
pnpm app:build --optimize speed # 优先编译速度
```

脚本构建 release 并将本次安装包收集到 `artifacts/<version>/<target-triple>/installers/`：

| 平台    | 格式                                            | 当前安装方式                                        |
| ------- | ----------------------------------------------- | --------------------------------------------------- |
| Windows | `nsis/*.exe`、`msi/*.msi`                       | NSIS 按用户安装；MSI 所有用户安装，提权遵循系统策略 |
| macOS   | `dmg/*.dmg`、`macos/*.app`                      | 拖拽安装                                            |
| Linux   | `deb/*.deb`、`rpm/*.rpm`、`appimage/*.AppImage` | 系统包或 AppImage                                   |

目标由 [`tauri.conf.json > bundle.targets`](../src-tauri/tauri.conf.json) 决定，当前为 `all`；升级 Tauri CLI 后复核各平台默认格式。[浏览器预览](./development.md#浏览器预览构建与部署) 单独输出 `dist-web/`，不生成原生包。

`dist/`、`dist-web/` 和 Cargo 默认 `src-tauri/target/` 用于编译输出，交付文件统一从 `artifacts/` 获取。`app:build` 先编译并从 Cargo 输出确定实际产物，再隔离旧 bundle、打包和归档；失败恢复旧 bundle。脚本沿用 Cargo 缓存，支持自定义编译目录。

每次整体替换当前版本 / target 对应的 `installers/` 或 `portable/`，保留其他版本、target 和另一类产物。仅构建 NSIS 时，本轮 `installers/` 只保留此次构建结果。每类目录的 `manifest.json` 记录版本、target、时间和普通文件 SHA-256；`.app` 等目录只记录目录类型，应校验 DMG / 归档文件哈希。发布者身份另按 [代码签名](#代码签名) 验证。

参数见 `pnpm app:build --help`：`--target` 同时决定归档目标名，`--config` 合并后的版本须与项目一致，`--no-bundle` 只编译。debug、自定义 runner、裸 Cargo 参数及 macOS universal target 使用 `pnpm tauri`，自行管理和收集输出。清理交付目录用 `pnpm clean:artifacts`，其他范围见 [清理说明](./development.md#清理构建产物)。

归档使用同级重命名并重试短暂文件占用；自定义监听须排除生成目录。持续占用按 [EPERM 排障](./troubleshooting.md#windows-归档目录出现-eperm) 处理后重新归档。

### 编译策略

`app:build` 与 `app:portable` 的 `--optimize size|speed` 由包装脚本处理，两者均为 release 构建：

- `size` 为默认，优先缩小程序体积，编译等待较长。
- `speed` 关闭优化与 LTO、启用增量编译并保留符号，缩短编译等待；程序、缓存会增大，运行性能可能下降，按产品负载评估。

具体值以 [`Cargo.toml`](../src-tauri/Cargo.toml) 和 [构建脚本](../scripts/build-lib.mjs) 为准。两种策略共用分发路径与 Cargo 缓存；切换后首次重新编译依赖，无需清空缓存。

### 便携版（免安装）

Windows 便携脚本将主 exe、`使用说明.txt`、`LICENSE`、`NOTICE`、第三方许可和 `manifest.json` 收集到 `artifacts/<version>/<target-triple>/portable/`：

```sh
pnpm app:portable # 默认优先压缩程序体积
pnpm app:portable --skip-build # 核对源码后复用先前便携构建
pnpm app:portable --optimize speed
```

仅支持 Windows 宿主和 Windows 目标，参数见 `pnpm app:portable --help`；安装包使用 `app:build`。`--skip-build` 校验先前便携构建收据的版本、配置、参数、策略与 exe SHA-256；源码变化需由维护者核对，修改后重建。复用 `speed` 构建时同时传入 `--optimize speed --skip-build`。

- 目标机器需要 WebView2，安装入口见随包说明。数据写当前用户目录，不随 exe 移动；设置、壁纸和日志均不在便携包中。
- 应用内更新默认启动 NSIS 安装器并转为安装版；保留免安装形态时，从发行页手动下载新版 portable。
- 便携构建使用 `--no-bundle`，需对最终 exe 单独进行 Authenticode 签名，例如 `signtool sign /sha1 <指纹> /fd sha256 <exe>`；签名后更新清单 SHA-256 并验签。重新收集会整体替换便携目录。
- Linux 使用 AppImage，macOS 分发 `.app` / DMG。

### 安装器外观

品牌视觉源仅维护 [`resources/branding/`](../resources/branding/) 的 SVG。应用名称等身份先按 [产品身份配置](./development.md#产品身份配置) 修改，再生成并提交全部生成资源：

```sh
pnpm branding:generate
pnpm branding:check
```

`app-icon.svg` 直接供前端 / favicon 使用，并生成 `src-tauri/icons/` 的系统图标；`installer-*.svg` 生成 `src-tauri/installer/` 的 NSIS / WiX BMP。尺寸与生成映射见 [品牌脚本](../scripts/branding-lib.mjs)。生成图片由脚本维护，安装器 BMP 为无 alpha 的 24 位格式；窗口背景另见 [皮肤说明](../resources/skins/README.md)。

定制时保留以下约束：

- 安装文字使用原生控件。WiX 会叠加标题和正文；横幅图形留右侧，欢迎页视觉留左侧，以实际中英文 / 高 DPI 安装界面核对留白和比例。
- [NSIS 模板](../src-tauri/installer/installer.nsi) 的“品牌定制”段维护文案、字体、页脚和图片。对话框沿用标准安装器字体度量，标题单独设字体；页眉等比显示，侧栏等比铺满并居中裁切。保留 24 位缩放、绘制失败回退和图片所有权；静默布局检查后按受影响安装界面验收。
- 自定义文案使用独立 `LangString`；增加语言时补齐并编译检查。NSIS 语言由 `nsis.languages`、MSI 由 `wix.language` 控制；`bundle.copyright` 为空会使 NSIS 回退上游页脚。
- [WiX 片段](../src-tauri/installer/wix-ui.wxs) 跳过可见 `PrepareDlg`，后台准备与提权仍保留；`fragmentPaths` 与 `componentGroupRefs` 必须同时配置。
- 重新构建才更新安装包。Rust 构建监听 `icons/`，NSIS 快捷方式使用已安装 exe 的图标索引 0 并刷新缓存；验收同时检查安装器、已安装 exe 和快捷方式，旧缓存见 [排障](./troubleshooting.md#安装后仍显示旧图标)。
- 升级 Tauri 时对照同版本上游模板合并，保留本地品牌、高清图片、WebView2 临时路径、执行引号与文件关联修复。使用自定义 `wix.template` 时同样处理。

### 自启动与卸载

Windows 按当前用户在 HKCU 以应用 identifier 写 Run 项，读取 StartupApproved 状态并严格引用当前 exe；NSIS currentUser 卸载器清理本应用的 Run / StartupApproved 项。

MSI 卸载可能由另一账户或按机器执行，用户应先在应用内关闭自启动，以清理原用户的 HKCU 项。macOS / Linux 使用官方插件；分发涉及该平台自启动时，按 [安装验收](./testing.md#安装版与启动验收) 检查启用、禁用与卸载。

## 代码签名

### Windows

Authenticode 标识发布者并验证完整性，SmartScreen 还会评估应用信誉。证书要求见 [Tauri 签名指南](https://v2.tauri.app/distribute/sign/windows/) 及服务方文档；项目的启用条件、审批与签名范围见 [代码签名策略](./code-signing-policy.md)。

| 路线                                     | 仓库接入状态                                                |
| ---------------------------------------- | ----------------------------------------------------------- |
| SignPath Foundation                      | 发布模板保留可选 job，启用前完成申请、门户和仓库配置        |
| 可导出 PFX                               | 发布模板已接入导入、打包签名与验签，证书须有效且允许导出    |
| Azure Artifact Signing / USB Token / HSM | 未接线，须安装工具、配置身份及 `bundle.windows.signCommand` |

#### SignPath Foundation

按 [基金会申请入口](https://signpath.org/apply) 和 [条款](https://signpath.org/terms) 提交项目、许可、公开产物和信誉信息。申请人确认个人数据处理与服务条款，获批后按 [签名策略](./code-signing-policy.md) 配置服务方署名、公开入口和账号 MFA。

门户侧配置 project、artifact configuration（[仓库 XML](../.signpath/artifact-configuration.xml)）、开启人工审批的 signing policy，并按 [GitHub 可信构建接入](https://docs.signpath.io/trusted-build-systems/github) 约束仓库、工作流和 commit。API token 只授予项目 / 策略提交权限，不授予自动审批。

在 GitHub Settings → Secrets and variables → Actions 配置：

| 类型      | 名称                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Variables | `SIGNPATH_ORGANIZATION_ID`、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`、`SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` |
| Secret    | `SIGNPATH_API_TOKEN`                                                                                                        |

组织 ID 控制是否启用签名 job。启用后以本次 Actions artifact ID 提交请求，经门户人工批准、验签和重建清单后，替换同一个 draft Release 的 NSIS 资产。完整顺序见 [CI 多平台构建](#ci-多平台构建)。

SignPath 与 PFX 二选一，签名范围见 [签名策略](./code-signing-policy.md#签名范围)。后签与 updater 的组合限制见 [签名顺序](#更新服务端与签名顺序)。

#### 其他硬件或托管签名

Azure Artifact Signing、USB Token 和证书商 HSM 需安装 CLI / 驱动，配置身份、凭据和 `signCommand`。公共信任、私钥保护与用途由签发方政策决定。

#### 可导出 PFX 流程

使用有效且允许导出私钥的证书；内部 / 自签名证书需由使用环境单独建立信任。发布模板通过 `WINDOWS_CERTIFICATE`（PFX 的 base64）与 `WINDOWS_CERTIFICATE_PASSWORD` 导入证书，在打包阶段签名并验证 NSIS / MSI 产物。

本地可查询证书指纹，将 `certificateThumbprint` 等参数放入仓库外临时配置后构建：

```powershell
Get-ChildItem Cert:\CurrentUser\My | Select-Object Subject, Thumbprint
pnpm app:build --config <临时签名配置文件路径>
```

证书和私钥不进仓库；便携 exe 按 [便携版](#便携版免安装) 单独签名。

#### 未签名分发

未配置代码签名仍可构建模板 / 内测包，实际能否运行取决于系统与组织策略；公开交付时如实标明签名状态和已验证平台。

### macOS

站外分发应做 Developer ID 签名、公证，并在干净机器验证 Gatekeeper。发布模板使用以下 Secrets：

| 变量                                                                        | 用途                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY` | base64 `.p12`、密码与 Developer ID Application 身份 |
| `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`                               | Apple ID、App 专用密码与团队 ID，用于公证           |

本地先将证书导入钥匙串，设置签名身份与公证环境变量，再运行 `pnpm app:build`。发布模板会导入证书并提交公证，缺证书时生成未签名 / 未公证包。对最终 `.app` 检查：

```sh
codesign --verify --deep --strict --verbose=2 "/path/to/My App.app"
spctl --assess --type exec --verbose=3 "/path/to/My App.app"
```

`.app` 用执行评估，`--type install` 用于 `.pkg`；说明见 [Apple 公证排障](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)。还须实际下载、挂载、拖拽安装和首次启动。

### Linux

当前未配置独立发行包签名，提供文件哈希；软件源有额外要求时按渠道配置。更新签名独立执行。

## 自动更新

Rust updater 通过 [`src/lib/tauri.ts`](../src/lib/tauri.ts) 提供检查、下载安装与重启服务。启用时在 [`app.config.json`](../app.config.json) 配置项目端点和公钥，为发布流程配置匹配私钥，并发布带有效清单与签名的更高版本。

配置齐备后，主窗口在设置就绪且页面可见时延迟检查一次；`autoCheckUpdates` 默认 `true`，可在设置关闭。后台失败静默处理，发现新版本后提示查看，下载与安装由用户确认。浏览器只提供界面预览。超时、失败分类和进度见 [`updater.rs`](../src-tauri/src/updater.rs)。

### 配置公钥与发布签名

1. 首次配置时在仓库外生成密钥，按 [密钥管理](./security.md#密钥与证书) 备份；已有通道不可直接覆盖旧密钥。

   ```sh
   pnpm tauri signer generate -w ~/.tauri/my-app.key
   ```

2. 在 `app.config.json` 设置公钥和本项目端点，运行 `pnpm config:sync` 与 `pnpm config:check`。发布模板按 `repository.config.json` 的链接模板核对仓库和清单地址；默认 GitHub 示例：

   ```json
   {
     "updates": {
       "endpoint": "https://github.com/<owner>/<repo>/releases/latest/download/latest.json",
       "publicKey": "<签名公钥内容>"
     }
   }
   ```

3. 配置 Secrets `TAURI_SIGNING_PRIVATE_KEY`，加密密钥另设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。公私钥须成对配置；两边均为空时，发布模板生成普通安装包。
4. 按正式流程发版。发布模板临时启用 `createUpdaterArtifacts: true`，收集后用 [Rust 验证器](../src-tauri/src/bin/verify-updater.rs) 核对最终文件、公钥、`.sig` 与签名版本。本地需要更新签名时，另行启用该配置并提供签名环境变量。
5. 独立 job 核对四个目标元数据和 draft 实际资产，生成唯一 `latest.json`。下载 URL 使用 GitHub 返回的正式资产名；正文取自 Release，超出长度限制时优先保留摘要、升级限制和完整说明链接。

首次为无公钥客户端启用更新时，用户须手动安装带公钥版本。启用或变更更新链路时，按 [安装与升级验收](./testing.md#安装版与启动验收) 使用两个不同版本走通发现、下载、验签和安装；便携版更新会转为安装版。

默认 `/releases/latest/` 面向公开正式版本，详见 [GitHub Release 规则](https://docs.github.com/en/rest/releases/releases#create-a-release)。测试通道需单独配置端点、版本比较与发布校验。手动生成更新签名时提供匹配的 `--app-version`，内部工具见 [release-lib.mjs](../scripts/release-lib.mjs)。

### 运行时策略与安装行为

默认策略编译自 `app.config.json`。受控部署可在 `appConfigDir/deployment.json` 写 `{ "updates": { "endpoint": "https://mirror.example/latest.json" } }` 覆盖镜像，或将 `endpoint` 设为空字符串禁用更新。公钥固定、部署校验与策略变化后的重新检查规则见 [更新通道](./security.md#更新通道)。

检查、下载句柄与进度由 Rust 管理并跨窗口同步。下载验签后、实际安装前统一协商所有窗口的未保存工作和原生在途工作；保存失败或取消则保留工作，安装期间冻结窗口。见 [更新与恢复架构](./architecture.md#恢复诊断与更新)。

更新弹窗展示 Release 的 Markdown 正文，复用安全渲染与受控外链；没有正文不影响下载安装。

Windows 安装可能结束当前进程、启动安装器并重新打开应用；安装后进程仍在运行的平台提供界面重启入口。

更新清单使用 Tauri v2 原生格式：Windows 默认 NSIS，并提供 NSIS / MSI 平台入口；macOS 使用 `.app.tar.gz`；Linux 默认优先 AppImage，另有 DEB / RPM 入口，系统包可能提权。

### 更新服务端与签名顺序

默认使用 GitHub Releases 静态清单；自建服务器提供相同的 [Tauri updater 格式](https://v2.tauri.app/plugin/updater/)。链接、端点校验与发布适配入口见 [仓库托管配置](./repository-hosting.md)。

**先确定最终交付字节，再生成更新签名与清单。** PFX 在打包阶段完成代码签名，可配合当前更新流程；SignPath 后签会改变字节，发布模板会拒绝同时启用。支持该组合需在后签后重新生成并验证 `.sig` 与清单。

## CI 多平台构建

恢复 [release.yml](../.github/workflows-disabled/release.yml) 并启用 Actions 后，推送 `v*` tag 或手动触发会启动正式发布。提交须属于 `main`，tag 与项目版本一致；手动运行按所选 ref 的项目版本关联 Release。日常 CI 范围见 [测试规范](./testing.md#持续集成检查)。

Rust 发布缓存按 `matrix.target` 区分，为 macOS ARM64 与 x86_64 分别保存编译缓存。

**触发前完成适用验收、确认发布说明并取得公开发布授权；全部必要任务成功后会自动公开 Release。** 草稿暂存构建与签名资产，平台验收范围按下节记录。

流程如下：

1. `validate` 用冻结锁文件安装依赖并执行 `pnpm verify`；里程碑 [CI](./testing.md#持续集成检查) 的结果随本次发布验收记录，不复用旧文件树标记跳过检查。校验发布来源、版本和草稿基线后，创建 / 复用唯一同版本 draft，将 Release ID 传给后续任务；发现多个草稿或已公开版本时停止。
2. `build` 构建 Windows x64（NSIS / MSI）、macOS arm64 与 x64（DMG / app）、Linux x64（DEB / RPM / AppImage），按 ID 上传；配置 PFX 时校验实际 NSIS / MSI 签名。Linux 系统依赖由 workflow 安装，本地环境见 [开发指南](./development.md#环境要求)。
3. 已启用的 `publish-updater` 汇总清单；`sign-windows` 完成 SignPath 签名与验证。两者成功或因未启用而跳过后，才公开同一 Release。必要任务失败、取消或意外跳过时保留草稿。

`build-installers-<target>` 是 build 阶段的归档；SignPath 启用时最终签名归档为 `signed-installers-x86_64-pc-windows-msvc`，Release 的 NSIS 也会替换。收集使用 `tauri-action` 返回的文件路径；macOS workflow artifact 外包 tar，保留 `.app` 权限与符号链接。

发布正文由 [发布说明脚本](../scripts/release-notes.mjs) 读取上一公开正式版至本次 SHA 的完整 Git 历史，按 Conventional Commits 分类；摘要与升级限制取自发布 SHA 对应、已合入 `main` 的 PR 正文。准备版本的 PR 填写“变更摘要”“升级与限制”，覆盖上一公开正式版以来的全部变更，包括期间的未公开版本；破坏性变更写明升级操作与数据影响。

本地预览需要完整历史；已有公开正式版本时还需其标签。首次发布没有对应 PR 时使用通用说明；有对应 PR 时填写公开摘要与升级限制。源码基线、正文或长度校验失败时，流程在创建草稿前停止。下载说明列出实际架构、格式、依赖与签名状态，支持的系统范围以版本更新 PR 的安装验收结果为准。

版本更新 PR 合入后、打 tag 前可预览正文，不修改远端：

```powershell
$env:GITHUB_REPOSITORY = 'owner/repo'
pnpm release:notes # 需已登录 gh，输出 artifacts/<version>/release-notes.md
```

预览时核对实际变更、破坏性变更和升级限制。重跑保留草稿人工编辑；正文修正须在更新清单汇总前完成，生成后再改正文不会同步 `latest.json`。

失败恢复按是否需要源码变化处理：无须改代码时重跑失败任务；须改代码时使用新版本和新 tag。历史重复草稿先备份元数据，按资产 ID 下载并校验哈希，归并到一个草稿且保留上传标签，核对后删除重复草稿并重跑汇总。已公开版本不能靠重跑替换资产。

## 发布检查清单

先确定本次交付的平台、架构、安装格式与更新通道，再选择以下验收。版本更新 PR / Release 记录版本、commit、环境、产物哈希、实际结果、待验证范围和支持 / 恢复负责人，据此声明可交付目标。

- [ ] 按 [Git 发布流程](./conventions/git-workflow.md#发布流程) 从 `main` 创建短期分支，同步版本、核对提交范围并完成适用检查；通过普通 PR 合入 `main`，正文写清本次版本的摘要与升级限制。
- [ ] 对本次交付的平台 / 格式按 [安装验收](./testing.md#安装版与启动验收) 检查最终包、签名 / 公证和原生系统服务。品牌、关联、自启动等变化时补对应验收。
- [ ] 提供自动更新时，按 [安装与升级验收](./testing.md#安装版与启动验收) 验证旧版到本次版本的发现、下载、验签与安装；存储格式、迁移或恢复链路变化时，按 [恢复验证](./testing.md#数据与恢复验证) 选择受影响历史数据和失败场景。
- [ ] 合入 `main` 后预览发布正文，完成上述适用验收，在已确认提交打 `vX.Y.Z`；发布流程获准启用后，等待全部必要发布 job 成功。
- [ ] 自动公开后核对版本、公开资产、哈希、签名及启用的更新清单 / Latest 状态，向使用方同步说明。

## 发布后观察

负责人核对公开下载和已启用更新源可用、哈希 / 签名与验收包一致；根据启动、白屏、数据和安装升级反馈决定是否暂停推荐问题版本，记录观察范围。

发布观察依赖用户反馈、本地日志与诊断。维护者提供支持渠道，收集日志时说明范围并脱敏；新增遥测、告警或分阶段放量时，另行设计隐私和控制。

阻断故障先确认版本与数据状态，暂停推荐问题包并保留原产物 / 哈希。改更新源只影响后续请求，不能撤销已下载安装器或恢复数据；处理决定与行动项见 [故障反馈](./engineering-at-scale.md#性能发布与故障反馈)。

## 回滚

- 代码使用 `git revert` 恢复后，以新 tag 和更高版本发布，沿用正常升级。默认更新只接受更高版本；确需降级时单独处理 Rust 版本比较和安装器限制，或指导用户手动重装。
- 存档迁移在发布前设计兼容与恢复。重新安装旧二进制前，核对旧版能否读取现有设置与图库数据，并保留原件。

涉及存储格式、迁移或恢复链路的发布，按 [数据与恢复验证](./testing.md#数据与恢复验证) 演练旧数据升级、失败与修复版恢复。应用的默认设置恢复只处理设置存档；图库、日志与外部文件按各自范围备份和恢复，位置见 [数据存储](./architecture.md#数据存储)。保留原件归档，并记录恢复范围与可能丢失内容。
