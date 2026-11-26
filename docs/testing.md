# 测试指南

<a name="测试与验收"></a>

从仓库根运行，选择与改动相关的检查。记录源码、平台、命令、结果和相关未测项。跨进程或实机的跑法见[专项验收](./acceptance.md)，通过的结果见[验证基线](./plan.md#验证基线)。

## 日常验证范围

| 变化                        | 选择                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 文档、链接或路径            | 检查 Markdown 格式、相对文件和标题链接。命令与事实对照脚本、配置或代码。涉及账本时核对阶段汇总并运行账本校验。 |
| TypeScript 业务、状态与组件 | 受影响 Vitest、typecheck、lint；界面接线再选 browser 场景                                                      |
| 工程脚本                    | `node --test <相关.test.mjs>`，核对实际命中及平台条件                                                          |
| Host/Rust                   | 受影响包/target 的测试、fmt/Clippy；独立程序交叉测试先构建同源入口                                             |
| DTO、命令注册或契约         | 对应生成/check、Rust 与 TS fixture，再验证语义边界                                                             |
| 存储、权限、取消、恢复      | 成功及实际失败路径、冲突、未来格式、原件、撤权、晚结果和资源责任                                               |
| 里程碑                      | 整体复审、`pnpm verify`、无头 UI、完整四目标手动 CI 和所属正式场景                                             |

文档修改可用 `pnpm exec prettier --check <文件>` 检查格式。涉及阶段和需求时，再运行 `pnpm planning:check` 与 `node --test scripts/check-feature-status.test.mjs`。已有验收结果需追溯到对应候选、命令及证据。仓库或应用配置的说明用 `pnpm config:check` 核对。

从实际用户行为、契约或故障后果选测试。优先复用能发现同类回归的现有用例，在真实系统、平台差异或跨进程行为会改变结论时做集成验证。夹具只准备用到的输入。定向检查足以支持当前判断时停止复跑，阶段出口执行相应正式验收。删除功能时同步清理专属用例。

异步用例分别核对接纳、执行者实际收到信号和最终结算。用真实状态或回执放行下一步，超时用于诊断缺少的阶段。跨进程就绪文件须在内容写完后原子发布。授权变更尤其要等执行者实际收到取消，再验旧任务结果和资源回收。

多个 Rust 目标共用夹具源码时，按实际调用方放置辅助代码。示例程序、集成测试和使用 `super::*` 的测试模块都受编译范围影响。新增父模块导入或调整这些编译入口时，先对受影响包跑 `cargo clippy --locked -p <包> --all-targets -- -D warnings`，复验原故障后再启动完整矩阵。

共享文档默认值变更须同时核对 Core、生成 fixture 与 Host 文档集成测试；系统默认值和用户显式命名分别验证，不能只跑默认值所在包。

## 设计与复核测试门槛

- **先判断是否需要硬门槛。** 有明确用户预算、代表性负载和可重复结果的测量适合阻断交付。故障定位、趋势观察和探索性负载按需采样。从用户后果定指标、计时边界和典型设备、负载。人工降速、加压或通用经验值作为正式门槛前，用项目自己的基线校准。
- **核对指标的实际含义。** 把分位数、成功率或超时写成具体测试边界，明确样本单位、样本量、排序位次、允许失败次数与等于阈值时的结果。用可手算的样本检查边界。如果单个偶发样本足以改变结论，先审查样本量与统计口径。不同输入类型各自统计，避免一类工作掩盖另一类的问题。
- **用可重复的对照确定余量。** 在固定环境、运行时和负载下取得多轮基线，错开无关重负载并记录机器资源。用最小对照分离应用工作和平台等待。保留尾部样本，按观测波动和用户容忍度定预算。
- **失败后先决定下一次运行要回答什么。** 产品故障先修并定向验证，基础设施故障恢复后重跑受影响作业，两者难以区分时先用现有日志和小范围对照定位。定向验证提供了新证据，再进入完整矩阵。主动复核反复在临界值跳动的硬门槛：使用同一批样本比较现行规则和候选规则，判断两者能检出的用户回归，按用户确认更新验收标准。保留原样本与原判定。

## 前端与脚本

```sh
pnpm exec vitest run <受影响文件>
pnpm typecheck
pnpm lint
node --test <相关脚本.test.mjs>
pnpm verify --jobs 1
```

verify 的步骤见 [verify.mjs](../scripts/verify.mjs)，日志写入 `.cache/verify/`。共用预览端口或报告目录的浏览器测试串行运行。

组件测试 mock Tauri 门面，传输测试 mock 底层；进程测试用独立 profile 和自有进程。常规无头 UI 核对长草稿经过连续按键和大段插入后的完整内容。

输入性能排查时，设置 `SWB_TEST_COMPOSER_PERF=1` 并运行 `pnpm test:ui e2e/browser/composer-input-latency.spec.ts --workers=1`。诊断在 4 倍 CPU 降速下分别记录连续按键和大段插入从 `input` 事件到动画帧回调的样本，报告达到 100 毫秒参考值的次数。设置 `SWB_TEST_COMPOSER_NATIVE_CONTROL=1` 可同时采集原生文本框对照。100 毫秒参考值只用于诊断，T06 按固定负载和阶段预算验收。 [长草稿用例](../e2e/browser/composer-input-latency.spec.ts)

## 桌面边界

日常 UI 使用无头浏览器。真实应用窗口、测试 exe、原生截图和安装器测试仅在独立 CI/虚拟机或用户安排的前台时段运行；隐藏子进程控制台不能阻止 GUI 抢占焦点。

`pnpm e2e:build` 只构建测试程序；`pnpm test:installer --interactive` 会启动原生测试 exe，也遵守此前台边界。

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:ui
```

此入口构建生产 `dist-web/` 并运行 `e2e/browser/`，检查子路径资源、工作台/设置、键盘、无障碍、CSP 与运行时错误。视觉改动按 [GUI 验收与证据](./gui-design.md#验收与证据)对照宽窄草稿，核对中英、明暗、透明背景、减少动效、窄窗口和焦点，实际查看代表性生成截图。

实际窗口的构建、运行和证据保留见[原生桌面验收](./acceptance.md#原生桌面)。

## Rust 与生成

无头包可直接 `cargo test --locked -p serial-workbench-core`；根默认成员不包含桌面。桌面检查先 `pnpm build` 准备 dist，再选择包：

```sh
cargo test --locked -p serial-workbench --lib
cargo fmt --all -- --check
```

用户正在运行开发程序时，可为无头检查显式指定 `--target-dir .cache/local-acceptance-target`，例如 `cargo test --locked --target-dir .cache/local-acceptance-target -p serial-workbench --lib`。独立目录保留缓存；仅设置 `--target` 仍会争用默认根目录锁。

共享 target 的 Cargo 与生成顺序执行。跨工作树或恢复旧 mtime 后，核对受影响的本项目 crate 确实重编，并按产物路径与摘要确认实际运行版本。Windows 重建前确认占用产物的自有测试进程已退出。里程碑跑 `cargo test --locked --workspace` 和 `cargo clippy --locked --workspace --all-targets -- -D warnings`，生成入口见[开发指南](./development.md#契约与功能接线)。

**串口与客户端：** `cargo test --locked -p serial-workbench-host --test serial_backend --test pty_roundtrip` 在目标 OS 上运行；PTY 被 cfg 排除不计通过。先在同一 target 构建 Host、CLI、MCP，再跑 `cargo test --locked -p serial-workbench-host --test client_parity`。Host 夹具普通 Operation 等待为 5 秒，十子动作的 15 秒聚合观察不能算作 5 秒门槛通过。

需要固定 Node、签名包或实际 SDK 客户端时，见[签名运行时与 SDK](./acceptance.md#签名运行时与-sdk)。

## 持续集成

[手动 CI](../.github/workflows/ci.yml)覆盖 Windows x64、Linux x64、macOS arm64/x64。里程碑选择完整模式，检查四个 Rust 和四个 Native 目标实际执行，核对收据、源码与未签名构建，Ubuntu 正式场景须在隔离网络中运行。runtime 专项、单目标诊断和关闭 Native 的运行均不替代完整候选。

原生预检设置 `native_preflight=true` 和 `desktop_e2e=true`。`native_preflight_target` 可选择单个目标，`macos` 一次复验两种 macOS 架构，`windows-and-macos` 同时复验 Windows。各目标复用原生 E2E 并分别保留日志和收据，完整候选继续按四目标验收。

`native_preflight_target=macos-input` 只构建 macOS 热键探针并在两种架构运行，不安装项目依赖或构建工作台。探针确认带功能键标志的 F10 在独立应用前台时收到一对 Carbon 按下和释放回调。收据记录会话内标记事件的数量和修饰键。此结果用于定位系统投递问题，工作台发送仍按 [IO-08 专项](./acceptance.md#桌面全局发送热键)验收。

工作区测试已经构建 Host、CLI、MCP 和默认示例。按 `compiler-artifact` 核对路径与目标特性后复用，保留测试范围和负载。[Cargo 测试目标选择](https://doc.rust-lang.org/cargo/commands/cargo-test.html#target-selection)

固定运行时的探针和三个参考包签名工具使用同一 Cargo 包和运行时镜像。四个入口在一次调用构建，后续从原路径执行探针与签名。

完整模式将 Linux x64 的 `verified_backend_` 用例放在独立必跑作业。该作业按同一候选验签并准备固定运行时，串行执行原筛选范围，保存候选 SHA、完整测试输出、运行时收据和失败夹具。Ubuntu Rust 作业仍覆盖 workspace、离线六场景和 600 秒负载，并在同次未签名构建上验证运行时安装布局及三个签名参考包。两个作业均须通过，单项断言和原 60 分钟作业上限继续适用。

Linux 签名后台作业在完成固定运行时校验后保存完整归档，Ubuntu Rust 作业在未签名构建前可从同一锁定清单键恢复这些文件。两边都按签名、长度和摘要重新验证，部分下载与失败文件由原诊断步骤保留。

### 失败定位与复验顺序

1. 先查失败作业的第一个失败步骤和原始产物，记下候选、平台、缓存命中、耗时、实际执行到的断言及退出原因。依赖下载、runner、测试驱动和产品各有对应的复现入口。启动或安装前失败时，对应业务场景记为未测。时间上限触发时，先找出耗时阶段和它正在等待的对象。
2. 用同一输入和验收断言在失败平台定向复验。产品缺陷优先得到修复前后的对照。断言选用领域对象及其稳定身份。一个对象有多份投影时，选与验证行为对应的投影。用只读探针等待新代次、所有权或应用状态，在确认前置状态后单独执行有副作用的动作。真实窗口同时核对对话框关闭、焦点归属和 Host 实际接受的结果。并发或超时带来的晚结果先查当前状态。已有副作用的命令仍按一次投递观察，重试和首次结果都留证据。
3. 已知失败路径在定向复验通过后，再汇合到同一候选的本机综合检查、完整无头 UI 和四目标 CI。仅依赖或 runner 被阻断时，在确认恢复后复跑受影响作业。记录缩短前后的构建、缓存及用例耗时，保留完整出口应有的目标、负载、断言及原始失败。

期限内的事件可能在下一次轮询才被读到。边界用例固定事件源时间，单独控制观察进度，核对最后一次读取和完整来源。真实运行再验证跨进程接线及结果一致性。

Windows x64 Rust 作业用同源 `dist-web`、无头 Chromium 和隔离 Host 跑[真实配对工作台专项](./acceptance.md#真实配对工作台专项)。Git Bash 以 `cygpath` 转换运行器临时路径供 Cargo 与 Node 共用。日志、截图和回执留在该目录，CI 分别报告进程失败和收据缺失。

## 依赖审计

`pnpm audit` 与 `cargo audit --file Cargo.lock` 使用当前锁文件；手动 audit workflow 保留。请求失败记为未完成，实际风险、升级和暂缓原因写入 PR，不将工具不可用记作通过。

## 专项验收

跨进程或实机步骤见[专项验收指南](./acceptance.md)。

- <a name="终端参考包验收"></a>[签名终端](./acceptance.md#终端参考包验收) · <a name="图表参考包后台采样"></a>[图表](./acceptance.md#图表参考包后台采样) · <a name="自动化参考包后台应答"></a>[自动化](./acceptance.md#自动化参考包后台应答)
- <a name="host-软件验收"></a>[Host 软件场景](./acceptance.md#host-软件验收) · <a name="独立录制格式"></a>[独立录制格式](./acceptance.md#独立录制格式)
- <a name="m3-契约冻结"></a>[M3 契约冻结](./acceptance.md#m3-契约冻结) · <a name="安装与发行验收"></a>[安装与发行验收](./acceptance.md#安装与发行验收)
