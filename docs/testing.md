# 测试规范

## 测试分层

| 层            | 关注点                                                       |
| ------------- | ------------------------------------------------------------ |
| Vitest 纯逻辑 | 设置迁移、同步、命令、快捷键、翻译和错误                     |
| 组件          | 路由、未保存工作、输入保留、键盘、焦点和无障碍               |
| Node 工程脚本 | 配置、版本、生成资源、归档、进程和文件边界                   |
| Rust          | 入参、权限、原子存储、revision、窗口生命周期、恢复和更新策略 |
| IPC           | 生成契约一致性和必要的真实命令调用                           |
| Playwright    | 浏览器生产资源、子路径、导航、偏好和自动无障碍扫描           |
| 真实桌面      | 原生启动、IPC、窗口、系统服务与进程重启                      |
| 正式安装版    | 安装、身份、签名、卸载、升级和平台集成                       |

按受影响行为选择层级，界面替身验证交互，原生能力由 Rust 和桌面检查验证。

## 日常验证范围

先确认要证明的行为，再选最小有效检查；通过后只因新改动、失败或明确疑点扩大或重跑。

| 改动       | 验证起点                                            |
| ---------- | --------------------------------------------------- |
| 文档       | 修改文件格式、本地文件 / 标题链接及与实现的事实核对 |
| 文案和样式 | 对应无头界面场景，按变化补明暗、键盘或尺寸          |
| 功能和修复 | 所属逻辑 / 组件 / 原生回归与类型检查                |
| 工程脚本   | 定向 Node 测试，公共文件操作变化再扩大              |
| Rust / IPC | 相关 Rust 测试；契约变化生成并检查绑定              |
| 发布       | 目标平台构建、安装升级与分发验收                    |

```sh
pnpm test src/layouts/app-shell.test.tsx
pnpm exec vitest related --run src/lib/settings-sync.ts
node --test scripts/clean.test.mjs
pnpm exec prettier --check docs/testing.md
```

`pnpm verify` 运行前端 / 脚本测试、格式、lint、类型、配置、品牌与版本检查，最后构建桌面前端；步骤见 [verify.mjs](../scripts/verify.mjs)。Rust、IPC 绑定导出、Playwright 和真实桌面验收按下文单独执行。

### 并行与耗时

`pnpm verify --jobs 1` 顺序运行检查，日志写入 `.cache/verify/` 的本轮目录。浏览器检查共享预览端口和报告目录，分开运行并保持 `dist-web/` 不变。共用 target 的 Rust 检查与绑定任务顺序执行，保留编译缓存。

## 测试的收益与边界

断言用户行为和公开契约：规则由所属层覆盖，入口检查接线。测试应能定位独立回归，主题、语言与尺寸组合按实际受影响场景选择。

删除功能时同步删除专属测试；保留原子提交、数据兼容、未来格式、并发、授权、取消、恢复与无障碍失败路径。用覆盖率定位遗漏，确认定向命令实际匹配了测试。

## 避免干扰本机桌面

日常界面检查默认使用无头浏览器。真实应用窗口、测试 exe 和原生截图只在独立 CI / 虚拟机或用户安排的前台时段运行。

`pnpm test:ui` 构建浏览器产物并无头执行 Playwright。`pnpm e2e:build` 只构建隔离原生程序；`pnpm test:e2e --interactive` 会显示、激活和切换真实窗口。`pnpm test:installer --interactive` 也会启动原生测试 exe。

独立标识符与临时目录隔离数据，`windowsHide` 隐藏子进程控制台，应用 GUI 仍可抢占焦点。没有前台时段时使用无头检查，交付时列出相关原生未测范围。

## 前端与脚本

```sh
pnpm test
pnpm test:scripts
pnpm typecheck
pnpm lint
```

测试与源码就近维护。组件 mock `@/lib/tauri` 能力，门面契约测试再 mock 底层 Tauri API。设置重点覆盖加载期间编辑、在途保存、冲突、旧事件、失败重试、未来格式和 StrictMode 订阅重建。

脚本文件与进程测试使用本次临时目录和受控进程，保持真实用户数据完整。新增页面步骤见 [页面到 IPC 流程](./development.md#新增页面到-ipc-与测试)。

## 体验与动效验收

按 [界面规范](./conventions/ui-guidelines.md) 检查受影响入口、焦点、键盘、动效及输入 / 滚动保留。

## Rust 测试

无头 crate 可直接从根运行定向测试，例如 `cargo test --locked -p serial-workbench-core`。桌面 crate 先准备 `dist/`，再选择包运行相关测试：

```sh
pnpm build
cargo test --locked -p serial-workbench --lib
cargo fmt --all -- --check
```

IPC 契约变化后依次运行 `pnpm bindings:generate`、`pnpm bindings:check`，并提交生成结果。绑定任务与共用 target 的 Cargo 检查顺序执行。

Host DTO 变化后顺序运行 `pnpm contracts:generate`、`pnpm contracts:check`；Rust 与 TypeScript 共用导出的正负 fixture。schema 验证结构，跨字段身份、权限和资源语义由 Host 入口继续核验。独立后端检查可使用根默认成员的 `cargo test --locked`；Clippy 显式选择 core / ipc / host / client / cli / mcp 六包并带 `--all-targets -- -D warnings`。包含桌面的里程碑检查使用 `cargo test --locked --workspace` 与 `cargo clippy --locked --workspace --all-targets -- -D warnings`。

CLI、MCP 与 HostClient 的交叉验收会启动真实适配器程序。先构建同一 target 的三个入口，再运行测试；CI 同样执行此前置构建：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo test --locked -p serial-workbench-host --test client_parity
```

交叉测试默认读取测试程序所在 target 目录的 CLI/MCP；需要检验独立构建时，可分别设置 `SWB_TEST_CLI_BIN`、`SWB_TEST_MCP_BIN` 为程序绝对路径。测试比较同一会话的原始事件与 TX 回执，同时验证 Operation 查询的当前资源读取权限。

涉及进程的 Rust 测试需核对临时目录和进程回收。

## Host 软件与独立格式验证

定向检查覆盖 contracts / host-client 与场景包装器；按实际改动选择运行：

```sh
pnpm exec vitest run packages/contracts/src packages/host-client/src
node --test scripts/generate-host-contracts.test.mjs scripts/test-capture-container-independent.test.mjs scripts/test-host-scenarios.test.mjs
```

独立格式验收先由 Rust 写出固定输入 fixture，再由不依赖 Rust parser、SDK 或 Host IPC 的 Node reader 扫描全部卷，核对原始字节、索引、摘要和 Partial / Unknown 回执。两个输出位置须使用尚不存在的绝对路径，结果文件放在 fixture 目录外：

```sh
cargo run --locked -p serial-workbench-host --example capture_fixture -- --output <新fixture绝对目录>
node scripts/test-capture-container-independent.mjs --fixture <该fixture绝对目录> --result <新结果文件绝对路径>
```

正式 T01 / T03 / T04 / T05 / T06 / T08 通过显式 harness 执行，不随 workspace 测试自动运行。构建、600 秒门槛、平台记录与待测范围见 [M1 软件场景验证](./m1-software-validation.md)。当前 CI 仍按下文执行既有检查，正式六场景由独立入口运行并在里程碑记录结果。

## 数据与恢复验证

设置验证覆盖原子写入、revision 冲突、损坏备份、读取失败保留，以及普通保存拒绝未来 schema、用户确认重置后替换未来设置。隔离恢复另测默认候选校验、未来格式保护、原件归档、安装日志、失败回滚及未知恢复元数据拒绝。

壁纸图库按自身格式与生命周期验证；默认设置恢复应保留图库和其他用户文件，归属见 [数据存储](./architecture.md#数据存储)。

## 浏览器生产构建冒烟

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:ui
```

测试生产 `dist-web/` 的 `/serial-workbench/` 子路径，冒烟覆盖工作区与设置入口、设置刷新、偏好保存、键盘和无障碍，并将资源加载、运行时和 CSP 错误记为失败；场景见 [smoke.spec.ts](../e2e/browser/smoke.spec.ts)。其它界面回归与其一起运行。

## 真实桌面 E2E

```sh
pnpm e2e:build
pnpm test:e2e --interactive --skip-build
```

按 [桌面边界](#避免干扰本机桌面) 安排执行。测试使用独立应用标识、临时目录和测试 WebDriver，并禁用真实自启动；场景与构建读取见 [runner](../e2e/run.mjs)。

## 安装版与启动验收

按目标平台验证首次启动、窗口恢复、深链允许范围、单实例、签名、卸载登记及已配置的更新通道。操作系统服务分别记录实际结果，便携版同时核对 WebView2 与用户数据位置，见 [发布检查清单](./build-release.md#发布检查清单)。

## 持续集成检查

日常使用本机定向验证和无头 `pnpm test:ui`。积累到大节点里程碑时，在 Actions 手动运行 [ci.yml](../.github/workflows/ci.yml)，选择待验收 ref；不在每次 push、PR 或定时任务上启动 CI。每次手动运行完整执行前端 / 工程脚本、无头浏览器、Rust fmt / Clippy / workspace 测试、生成 IPC 绑定比对及未签名原生程序构建，不按最后一次提交或旧文件树记录跳过检查。

原生构建和桌面 E2E 覆盖 Windows x64、Ubuntu 22.04 x64、macOS ARM64 / x64。宿主分别为 Windows Server 2022、Ubuntu 22.04、macOS 15 ARM64 / Intel；macOS 构建指定 `MACOSX_DEPLOYMENT_TARGET=14.0`，macOS 14 运行验收另行安排。

手动输入 `desktop_e2e` 默认开启，真实窗口只在独立 GitHub runner 执行。显式关闭时，质量门禁只允许桌面 job 跳过，并在运行摘要记录选择；其余 job 的失败、取消、缺失或跳过均使门禁失败。构建日志记录本次 SHA 与四目标结果，浏览器报告及桌面失败日志按 job 上传。四平台全量运行成功是里程碑 CI 验收；真串口硬件、72 小时稳定性、正式安装包、签名与公开发布使用各自验收流程。

[依赖审计](../.github/workflows/audit.yml) 同样手动运行，停止自动创建依赖升级 PR。需要的升级由维护者按里程碑集中处理，验证后将实现、测试、审阅修正和配套文档合入同一个中文提交，再经 PR squash 交付。

发布与 Pages 模板的状态、审查和启用步骤见 [停用目录说明](../.github/workflows-disabled/README.md)。
