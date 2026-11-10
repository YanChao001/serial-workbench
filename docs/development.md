# 开发指南

命令从仓库根目录运行。实现约束见[开发规范](./conventions.md)，当前任务与已知失败见[进度](./progress.md)。

## 环境与启动

工具版本读取 [package.json](../package.json) 的 engines/packageManager、[.nvmrc](../.nvmrc) 和 [rust-toolchain.toml](../rust-toolchain.toml)。Windows 需要 C++ Build Tools、Windows SDK 和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要编译工具与 WebKitGTK 开发库，具体安装见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

pnpm 在项目内的 `.pnpm-store/` 保存依赖缓存，随项目保持在同一磁盘，配置见 [pnpm-workspace.yaml](../pnpm-workspace.yaml)。该目录由 Git、格式检查和文件监听排除；工具版本由 packageManager 固定，版本更新提示关闭，升级按依赖评审统一处理。

格式命令在展开文件路径时显式排除 `.cache/`，避免遍历其中由不同 Windows 执行身份创建的私有测试 profile；不修改其访问权限，失败现场继续保留。源码、测试和工程文档仍执行原有格式检查。

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

未安装 npm 依赖也可运行 `node scripts/doctor.mjs`。使用 `pnpm run doctor` 明确调用项目诊断，避免命中 pnpm 自带的同名命令。`pnpm dev` 提供 `http://localhost:1420` 浏览器预览；`pnpm build:web` 输出可部署到子路径的 `dist-web/`，原生构建使用 `dist/`。

浏览器生产预览使用 `pnpm build:web` 后运行 `pnpm exec vite preview --outDir dist-web`。TSX/CSS 由 Vite 热更新；Rust、capability 和平台配置变化后重新构建并重启原生进程。

`app:dev` 在启动 Tauri 前同源构建 Host/CLI，按内容哈希复制到 `.cache/dev-runtime/` 的独立版本目录，再通过副本 CLI `catalog --json` 完成就绪。Host 独立于 GUI，关闭窗口后仍可运行；执行副本避免 Windows 锁住下次 Cargo 要覆盖的产物。副本校验或准备失败停止启动，保留终端错误和已有版本。

已有 profile 的 Host 继续复用，不自动停止在途工作。需要应用新的 Host 实现时，先确认该 profile 的操作已结算，再用 CLI `--profile <实际绝对目录> host stop --json` 正常停止，随后运行 `pnpm app:dev`；窗口代码变化仍由开发工具重建。旧版本留下的 Host 若直接运行在 `target/debug/`，首次迁到副本前也需正常停止以解除占用。

准备阶段和桌面均使用 `src-tauri` 工作目录，相对 `SWB_PROFILE` 从此解析。target、release、target-dir、profile 和 config 参数同步给准备构建；命令行自定义 runner 被拒绝。Cargo env 注入、配置内 runner 或自定义 cwd 组合尚未验证。IDE 的 Windows Job 禁止独立启动时，可在允许独立运行的终端启动 Host，再连接同一绝对 profile。

## Host、CLI 与 MCP

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
```

默认程序在 `src-tauri/target/debug/`，Windows 带 `.exe`；Host、CLI 和 MCP 放在同一输出目录。CLI/MCP 首次连接可启动相邻 Host，普通客户端默认只有元数据权限。

以下示例在正式程序目录已加入 PATH 后执行，参数文件采用当前 [Core 类型](../crates/core/src/)：

```sh
serial-workbench-cli --profile <绝对目录> catalog --json
serial-workbench-cli --profile <绝对目录> context --out request-context.json --json
serial-workbench-cli --profile <绝对目录> invoke <actionId> --target-json target.json --params-json params.json --request-id <uuid> --request-context-json request-context.json --json
```

`context --out` 新建 UTF-8 AttachResult，不覆盖原文件。重试保持相同上下文、requestId 和参数，异参返回 `REQUEST_CONFLICT`；Host 重启后不重发旧 invoke，按原上下文查询持久结果：

```sh
serial-workbench-cli --profile <绝对目录> operation get --request-id <原uuid> --request-context-json request-context.json --json
```

正常调用返回接纳 Operation，使用 `operation get <operationId>` 查询终态；`operation cancel` 请求合作取消，退出客户端保留任务。`host stop` 的接纳和实际停止分别确认。目录定义 query/invoke、目标和参数 schema，CAS 写入通过 `--expected-revision`；完整参数与退出码以 [args.rs](../crates/cli/src/args.rs) 和 `--help` 为准。

`authorize`/`revoke` 是明确的本地用户控制入口。文件业务先经 `file.register` 登记再使用 ObjectRef，普通请求不自动读取用户控制凭据。MCP 使用 `serial-workbench-mcp --profile <绝对目录>`，stdout 仅承载官方 SDK 协议，工具来自同一目录和权限；取消工具等待不代替 `operation.cancel`。

Host/CLI/MCP 按 `--profile`、`SWB_PROFILE`、平台默认目录选择配置。相对路径绑定启动 cwd，不展开变量或 `~`；Windows 盘符相对/根相对路径拒绝。`SWB_LOG_LEVEL` 接受 off/error/warn/info/debug/trace，默认 info；空值和过滤表达式拒绝。日志写 stderr，CLI JSON/MCP 协议写 stdout；`startup.config.get` 提供脱敏来源。

## 契约与功能接线

Rust 包、共享 profile 和默认成员读取根 [Cargo.toml](../Cargo.toml)，共用 Cargo.lock 与 [.cargo/config.toml](../.cargo/config.toml) 的 target。仅无头包检查不需要前端，桌面检查先准备 `dist/`。

1. 对照[需求](./requirements.md)确定目标行为、失败和验收；页面放 `src/pages/`，有独立业务规则时建立 `src/features/<domain>/`。
2. `src/routes.tsx` 注册路由、布局、懒加载与导航；共用操作进入 `src/commands/`，同步深链和窗口路由白名单。
3. 局部草稿由组件拥有，偏好复用 Provider/同步器；未保存工作登记 `useUnsavedWork`，文案补齐中英词典。
4. 业务能力进入 Host 服务与目录，系统交互进入 Native 服务；命令处理边界适配，手写前端经 `src/lib/tauri.ts`。
5. Host wire DTO 改变后依次运行 `pnpm contracts:generate`、`pnpm contracts:check`，提交 `packages/contracts/src/generated/`。Rust 同源导出类型、draft-07 schema、目录、默认值及正负 fixture，客户端校验未知输入。
6. Native 命令/DTO 在 `src-tauri/src/bindings.rs` 注册，依次运行 `pnpm bindings:generate`、`pnpm bindings:check`，提交 `src/lib/generated/`。生成任务和共用 target 的 Cargo 检查顺序执行。
7. 按[测试范围](./testing.md#日常验证范围)验证规则及真实入口接线；删除功能同步清理所属源码、依赖、权限、专属测试和文档。

## 身份、资源与依赖

[app.config.json](../app.config.json) 管理名称、标识符、深链、浏览器存储空间和更新信任，`pnpm config:sync --config <配置补丁.json> --dry-run` 预览，去掉 dry-run 同步，再 `pnpm config:check`。身份变化可能改变数据位置，脚本保留原用户数据，已分发身份迁移另行设计。

同步器在 identifier 或 repositoryUrl 改变时清空原更新端点和公钥，只改变更新端点时也会清空公钥；同一产品迁移需要保留信任时，在补丁中显式提供匹配的端点和公钥，见 [init-lib.mjs](../scripts/init-lib.mjs)。配置同步不迁移磁盘数据。

[repository.config.json](../repository.config.json) 管理仓库、分支、市场和链接模板，修改后运行 `pnpm repository:sync` / `pnpm repository:check`，提交生成同步结果。同步更新受管链接与模板，不配置远端权限、Secrets、签名门户或域名；平台 API 在 `scripts/hosting/` 适配。

`repository.generated.json` 保存上次同步的公开配置，用于识别旧链接，和配置一起提交。修改链接优先改模板；更换托管平台须实现发布适配器，再设置 provider，子模块 gitUrl 不承担插件下载或信任配置。

品牌源在 `resources/branding/`，修改 SVG 后执行 `pnpm branding:generate` / `pnpm branding:check`，提交 icons 和安装器生成结果。安装器保留原生文字区、高 DPI 缩放和本地修复；升级 Tauri 时审查 NSIS/WiX 模板差异。皮肤和内置图片分别按 [skins](../resources/skins/README.md)、[wallpapers](../resources/wallpapers/README.md) 维护。

新增共享外观字段从 `crates/core` 的设置 DTO/默认值和生成结果开始，再接前端归一化、`applySettings`、语义 token 及设置控件；客户端窗口偏好走 ClientState。设置搜索控件 ID 与索引同步维护。

新依赖评估用途、替代方案、许可、平台、包体与安装脚本，提交最小清单/锁差异。锁冲突先合并清单，再用规定工具链基于已有锁重新解析；避免删除锁文件整体升级。

## 构建与发布

当前发布/Pages 模板停用，签名和更新配置待启用。手动 CI 见[测试](./testing.md#持续集成)；正式分发前按本节准备并验收。

```sh
pnpm version:set 1.2.0
pnpm version:check
pnpm app:build
pnpm app:build --bundles nsis
pnpm app:portable
```

版本脚本同步 npm/workspace、Tauri、Cargo 共享版本与锁文件。MSI/NSIS 的版本范围及预发布限制由 [version.mjs](../scripts/version.mjs) 校验，不能仅靠选择其他 bundle 绕过配置约束；已发布版本号不复用。

构建按 Cargo 真实输出收集桌面、Host、CLI、MCP 与组件清单。`--optimize size|speed` 均为 release，默认 size，speed 缩短编译但增大产物并改变优化；参数见脚本 `--help`。I8 路径边界及四目标未签名原生构建已通过，源范围见[进度](./progress.md#m1b-问题闭合)。

交付从 `artifacts/<version>/<target-triple>/installers/` 或 `portable/` 取文件，manifest 记录版本、target 和文件 SHA-256。同一版本/target 的该类产物整体替换，保留其他版本和另一类，失败恢复旧 bundle。Windows 产出 NSIS/MSI，macOS app/DMG，Linux 格式由 Tauri bundle.targets 决定。

Windows portable 包含程序、组件和许可证，需要 WebView2，数据写当前用户目录；应用内更新会转为安装版。`--skip-build` 核对构建收据、配置和组件哈希，源码变化需重新构建，复用 speed 时同时指定策略。macOS 和 Linux 分别使用 app/DMG 与 AppImage/系统包。

### 签名与更新

代码签名验证系统发布者，更新签名验证包和版本。**先确定最终交付字节，再生成更新签名与清单。**

- Windows 可选 SignPath 配置当前只覆盖 x64 NSIS 外层，安装后 exe、MSI 和第三方组件须另行处理。启用前确认服务资格、证书主体、审批人和最小 Secret 权限；后签改变字节，现模板拒绝与更新签名同时使用。
- SignPath 的提供方和公开签名策略入口、账号 MFA、人工审批及 `.signpath/artifact-configuration.xml` 随启用一起核对；token 仅限提交签名请求。PFX 和 SignPath 二选一，硬件或其他托管签名尚未接线，需实现工具与 signCommand。
- PFX 使用 `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`；macOS 的证书、身份与公证 Secrets 读取 [release 模板](../.github/workflows-disabled/release.yml)。正式 macOS 分发完成 Developer ID 签名、公证与 stapling；Linux 当前提供哈希，未配置独立包签名。凭据通过受控渠道提供。
- 更新在 app.config 配置匹配端点、公钥，发布端配置 `TAURI_SIGNING_PRIVATE_KEY`，加密私钥另设 password Secret。公钥固定在安装包内，deployment 仅可覆盖 HTTPS 镜像或以空端点禁用，不能替换公钥。
- 启用后发布模板核验四目标、最终资产、签名版本和唯一 latest.json。无公钥的旧客户端需手动安装可信版本，换钥使用过渡版本或手动安装。
- 发布准备保留正式源、tag、构建环境、许可、组件收据、签名及最终哈希；验收升级时采用两个不同版本，覆盖发现、下载、验签、未保存协商、安装和重启。

### 交付检查

1. 确认可交付候选、需求范围和有效里程碑 CI，在 PR 准备用户可见摘要及升级限制。
2. 在确认的 main 提交打 `v<version>` 标签，同源构建四目标；恢复模板前核对 Actions SHA、参数、平台和 Secrets。
3. 验证最终哈希、发布者、许可、安装/卸载、协议关联、自启动、更新及失败恢复。Windows MSI 按机器卸载不保证清除原账户 HKCU，自启动应先在原账户关闭。
4. 核对 draft 资产与更新清单后再执行公开发布；观察安装/更新失败及错误报告。撤回错误清单或资产时保留证据，用更高修复版本恢复；不覆盖旧版本号或假定较旧程序可读取较新数据。

恢复 release 模板后，v* tag 或手动触发会构建并在必要 job 全部成功后自动公开同一 Release，发布授权与适用验收须在触发前完成。失败、取消或意外跳过保留 draft；需要源码修正时使用新版本/tag，已公开资产不靠重跑替换。

发布说明从 tag 源提交对应的已合入 PR 读取“变更内容”和“影响范围”，也支持显式的“变更摘要”和“升级与限制”；这些标题是工具契约。版本 PR 覆盖上一公开正式版以来的全部变化，可用 `pnpm release:notes` 只读预览（需完整 Git 历史及 gh 认证）。更新清单生成后再编辑 Release 正文不会自动同步其中的说明。

## 排障与清理

先记录应用/源码版本、系统、稳定错误 code 和触发步骤，再检查实际进程及日志。诊断区可复制脱敏报告；文件日志由 Tauri 路径 API 定位，见 [diagnostics.rs](../src-tauri/src/diagnostics.rs)，反馈前复核私有内容。

| 现象                                                | 检查                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 窗口不出现/白屏                                     | 已有实例、托盘/显示器、WebView、终端和原生日志、资源路径/CSP；真实窗口按[桌面边界](./testing.md#桌面边界)安排                                                                                       |
| `HOST_START_FAILED`                                 | 正式相邻 Host、相同 profile、程序源身份及 Windows Job 限制                                                                                                                                          |
| Host 失效后重试失败                                 | I3 的重新附着与 epoch 问题，保留本地草稿，不重复发送旧动作                                                                                                                                          |
| command not found / permission denied               | 当前二进制、命令注册、生成绑定、capability、窗口身份及目标授权                                                                                                                                      |
| 串口无法连接                                        | 使用工作台平台引导，核对实际设备、驱动、权限和原始错误；拒绝访问不能据此猜测占用进程                                                                                                                |
| 1420 端口冲突                                       | 确认进程归属；改端口同步 Vite、Tauri devUrl 和编辑器调试配置                                                                                                                                        |
| Rust 长时间无输出                                   | CPU/磁盘、实际编译/链接进程与日志；保留缓存，顺序执行共享 target 的任务                                                                                                                             |
| `Blocking waiting for file lock on build directory` | 另一 Cargo 正在使用同一 target；先核对任务归属并等待或停止自己的检查。显式 `--target` 仍共享根构建目录锁；无头检查可用独立 `--target-dir .cache/local-acceptance-target`，真实桌面验收优先放独立 CI |
| Windows 无法覆盖 `serial-workbench-host.exe`        | 后台 Host 仍在运行；先核对该 profile 的在途工作，再用已构建 CLI 的 `--profile <实际绝对目录> host stop --json` 正常停止并等待 `stopped: true`，随后重试构建                                         |
| EPERM / 归档失败                                    | 确认占用来自本轮程序或扫描，停止自己的相关进程再重试；保留失败证据                                                                                                                                  |
| 图标或安装器仍旧                                    | 核对源 SVG、生成资源、实际 exe/快捷方式和系统图标缓存，重新构建                                                                                                                                     |
| 保存/恢复失败                                       | 区分 Host CAS 与 ClientState，重读冲突，损坏/未来格式保留原件，不编辑版本号强行覆盖                                                                                                                 |

清理先预览 `pnpm clean:temporary --dry-run`。temporary 清理临时报告、前端输出、默认 Rust 缓存和旧便携备份，保留正式版本归档与依赖；outputs 清理生成内容并保留识别出的 Cargo 缓存；artifacts 清整个分发目录；clean 默认还清默认 Rust 输出；all 再删除根依赖。精确路径见 [clean-lib.mjs](../scripts/clean-lib.mjs)，自定义 target 自行管理，重装依赖使用冻结锁文件。

带 `-Force` 的检查与删除、修改、服务启停分开调用。遇到 blocked by policy，检查是否混用操作并核验实际结果，记录仍失败的命令和错误。
