# 测试与验收

从仓库根运行，只选择与改动相关的检查。记录源码、平台、命令、结果和影响判断的未测项；当前已验证到哪一步见[验证基线](./plan.md#验证基线)。

## 日常验证范围

| 变化                        | 选择                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| 文档、链接或路径            | 格式、文件/标题链接、配置事实；涉及账本时运行 planning:check 和校验脚本测试 |
| TypeScript 业务、状态与组件 | 受影响 Vitest、typecheck、lint；界面接线再选 browser 场景                   |
| 工程脚本                    | `node --test <相关.test.mjs>`，核对实际命中及平台条件                       |
| Host/Rust                   | 受影响包/target 的测试、fmt/Clippy；独立程序交叉测试先构建同源入口          |
| DTO、命令注册或契约         | 对应生成/check、Rust 与 TS fixture，再验证语义边界                          |
| 存储、权限、取消、恢复      | 成功及实际失败路径、冲突、未来格式、原件、撤权、晚结果和资源责任            |
| 里程碑                      | 整体复审、`pnpm verify`、无头 UI、完整四目标手动 CI及所属正式场景           |

新增或修复测试时，先指出它能发现的用户回归、契约破坏或重要故障。选能证明该行为的最低成本层级。已有用例覆盖同一风险时，复用断言或合并场景。替身与真实边界跑同一条路径时，保留能证明该平台用户行为的那一遍，替身可用于定向诊断。测试夹具只准备实际使用的输入，使用应用就绪信号区分准备与业务响应。常规修复在受影响路径验证通过后即可停止定向复跑，阶段出口执行规定的验收。随功能删除清理专属用例。

共享文档默认值变更须同时核对 Core、生成 fixture 与 Host 文档集成测试；系统默认值和用户显式命名分别验证，不能只跑默认值所在包。

## 设计与复核测试门槛

- **先判断是否需要硬门槛。** 有明确用户预算、代表性负载和可重复结果的测量适合阻断交付。故障定位、趋势观察和探索性负载按需采样。从用户后果定指标、计时边界和典型设备、负载。人工降速、加压或通用经验值作为正式门槛前，用项目自己的基线校准。
- **核对指标的实际含义。** 把分位数、成功率或超时写成具体测试边界，明确样本单位、样本量、排序位次、允许失败次数与等于阈值时的结果。用可手算的样本检查边界。如果单个偶发样本足以改变结论，先审查样本量与统计口径。不同输入类型各自统计，避免一类工作掩盖另一类的问题。
- **用可重复的对照确定余量。** 在同设备或固定 runner、同运行时、同负载下取得多轮基线，错开无关重负载并记录机器资源。比较真实场景与最小对照，分段观察应用工作和平台等待。保留原始样本及尾部，依据观测到的波动和用户容忍度设预算。接近门槛的通过仍应追踪余量。
- **允许复核既有标准。** 当结果反复在门槛两侧跳动、对照也失败，或测量与用户行为脱节时，重新审视现行口径。并列给出原规则和候选规则对同一组证据的判断，说明哪些用户回归仍能检出，再按用户确认更新验收标准。既有失败、原样本和判定保留可追溯。

## 前端与脚本

```sh
pnpm exec vitest run <受影响文件>
pnpm typecheck
pnpm lint
node --test <相关脚本.test.mjs>
pnpm verify --jobs 1
```

verify 的实际步骤见 [verify.mjs](../scripts/verify.mjs)，本轮日志写入 `.cache/verify/`。浏览器、预览端口和报告目录不并发运行；Cargo/生成任务共用 target 时顺序执行。

组件测试 mock Tauri 门面，传输测试 mock 底层；进程测试用独立 profile 和自有进程。界面输入性能的定向入口见[长草稿基准](../e2e/browser/composer-input-latency.spec.ts)。排查浏览器本身的输入成本时，设置 `SWB_TEST_COMPOSER_NATIVE_CONTROL=1` 定向运行该文件，产物会附带原生文本框对照。

## 桌面边界

日常 UI 使用无头浏览器。真实应用窗口、测试 exe、原生截图和安装器测试仅在独立 CI/虚拟机或用户安排的前台时段运行；隐藏子进程控制台不能阻止 GUI 抢占焦点。

`pnpm e2e:build` 只构建测试程序；`pnpm test:installer --interactive` 会启动原生测试 exe，也遵守此前台边界。

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:ui
```

此入口构建生产 `dist-web/` 并运行 `e2e/browser/`，检查子路径资源、工作台/设置、键盘、无障碍、CSP 与运行时错误。视觉改动核对明暗、透明背景、减少动效、窄窗口和焦点；必要时实际查看生成截图。

真实桌面通过 `pnpm e2e:build` 与 `pnpm test:e2e --interactive --skip-build` 运行 `e2e/specs/`，使用测试配置和 WebDriver。构建包含相邻同源 Host/CLI/MCP，收据校验源码、target/profile 与程序哈希；runner 使用独立 Host profile、持有 PID、正常 CLI 认证及实际退出，失败保留现场。工作台场景在同一窗口内请求 runner 重启其持有的 Host，核对旧实例退出、新 epoch、显式重新附着、订阅及未发送草稿。

准备签名插件原生验收时，运行 `pnpm e2e:build --with-node-runtime`。它按正式资源校验和布局给测试 Host 准备固定 Node，并在构建收据记录资源字节、文件模式和允许的链接。复用该构建时运行 `pnpm test:e2e --interactive --skip-build --with-node-runtime`，runner 会在打开窗口前重查收据。签名终端的窗口、文件选择和焦点仍按[终端参考包场景](#终端参考包验收)操作和记录。

WebDriver 不自动重发失败或超时的命令：脚本报错前可能已执行原生副作用。`e2e/webdriver-transport.test.mjs` 用实际驱动配置及独立 HTTP 夹具验证一次投递，日常检查不启动原生窗口；界面等待仍由各用例的只读观察条件负责。

Native 刷新需观察旧文档被替换，再检查新窗口 IPC 就绪。同一阶段串行复用 profile，首个失败后保留现场；成功时核对实际进程退出、非空阶段日志及零意外 RPC 冲突。系统文件选择夹具、条件跳过和无头截图分别标明，不计为真实系统交互。

## Rust 与生成

无头包可直接 `cargo test --locked -p serial-workbench-core`；根默认成员不包含桌面。桌面检查先 `pnpm build` 准备 dist，再选择包：

```sh
cargo test --locked -p serial-workbench --lib
cargo fmt --all -- --check
```

用户正在运行开发程序时，可为无头检查显式指定 `--target-dir .cache/local-acceptance-target`，例如 `cargo test --locked --target-dir .cache/local-acceptance-target -p serial-workbench --lib`。独立目录保留缓存；仅设置 `--target` 仍会争用默认根目录锁。

共享 target 的 Cargo 与生成顺序执行。从备份恢复旧 mtime 时确认受影响 crate 实际重新编译；交叉测试需同源程序，不能用仅有源码指纹的旧二进制。里程碑跑 `cargo test --locked --workspace`、`cargo clippy --locked --workspace --all-targets -- -D warnings`；两套绑定的生成/check 见[开发指南](./development.md#契约与功能接线)。

**串口与客户端：** `cargo test --locked -p serial-workbench-host --test serial_backend --test pty_roundtrip` 在目标 OS 上运行；PTY 被 cfg 排除不计通过。先在同一 target 构建 Host、CLI、MCP，再跑 `cargo test --locked -p serial-workbench-host --test client_parity`。Host 夹具普通 Operation 等待为 5 秒，十子动作的 15 秒聚合观察不能算作 5 秒门槛通过。

**真实 Node 包：** 先按[资源准备](../resources/runtime/README.md)准备目标平台的正式资源根，用绝对路径设置 `SWB_NODE_RUNTIME_TEST_ROOT`；macOS 在构建前还须绑定同套 `SWB_NODE_RUNTIME_BUILD_IMAGE`。完整环境及执行顺序以[专项工作流](../.github/workflows/runtime-preflight.yml)为准。按影响从下列入口选用，默认 workspace 的 ignored 项不计通过：

```sh
cargo test --locked -p serial-workbench-host --test node_packages verified_backend_ -- --ignored --test-threads=1
cargo test --locked -p serial-workbench-host --lib native_node_ -- --ignored --test-threads=1 --nocapture
```

前者经签名包安装、确认、启用运行实际处理器；后者覆盖撤权与提交竞态、恢复、父子任务、worker 故障、结果访问与 Raw/Capture 连续性。macOS 另跑 `cargo test --locked -p serial-workbench-host --lib native_macos_ -- --ignored --test-threads=1` 核验监护和实际退出。逻辑时钟推进、取消 ACK 与 OS 进程退出是不同证据。

托管定向复测启用 `runtime_preflight` 并选择单一 `runtime_preflight_target`。`runtime_preflight_suite=host-ipc` 运行派生、Raw、Host 和 Node 自动恢复；`macos-signature` 在所选 macOS 架构运行已复现失败的后台用例及原生安装布局与启动故障。默认 `all` 运行完整运行时专项。里程碑仍用同一候选的完整四目标工作流验收。

任务 Raw 专项使用同一原生资源根。测试持续接收 Virtual 数据，在后端准备页后暂缓交付，并核对四个 Raw 名额用满时的控制回执、取消、内存释放与录制回放。

```sh
cargo test --locked -p serial-workbench-host --lib native_node_task_raw_lane -- --ignored --test-threads=1 --nocapture
```

任务派生专项使用签名包从实际 Raw 事件发布样本，检查字节范围、配置摘要、满额时控制和录制、两路分页、过期、撤权及取消后的名额释放。将 `SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 指向同源程序，可对照相同 Operation 的公开成功回包。需要保留签名 ZIP 与实际回包时，将 `SWB_TEST_DERIVED_EVIDENCE` 设为尚不存在的证据目录。仍按 T06 核验固定负载的延迟与峰值。

```sh
cargo test --locked -p serial-workbench-host --lib native_node_task_derived_lane -- --ignored --test-threads=1 --nocapture
```

**作者 SDK 与 CLI/MCP：** `pnpm plugin-sdk:fixture` 检查作者类型并编译示例。将 `SWB_TEST_NODE_SDK_FIXTURE` 指向 `.cache/plugin-sdk/examples/native-parity.js` 的绝对路径，`SWB_TEST_CLI_BIN` / `SWB_TEST_MCP_BIN` 指向同源两程序，再运行：

```sh
cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_ -- --ignored --test-threads=1 --nocapture
```

这组通过官方 MCP SDK 和实际 CLI 检查公开目录、动作/查询、重放、结果读取与窄撤权，不替代 GUI、隔离视图或真实 MCP 产品客户端。

## 终端参考包验收

M2 B 的第一个场景使用 C 将继续交付的终端包。以公开 SDK 构建并签名，在独立 profile 中运行同一候选的桌面、Host、CLI 和 MCP。按[桌面边界](#桌面边界)运行真实桌面步骤。记录包摘要、Host 和会话代次，以及已知 Virtual 输入的字节范围与摘要。

终端源码位于 [SDK 示例](../packages/plugin-sdk/examples/reference-terminal/)。先运行 `pnpm plugin-sdk:fixture`。签名工具读取单独准备的 32 字节 Ed25519 测试种子，输出 ZIP 和一行包含包摘要、来源 ID 和公钥的 JSON。保存 stdout 作为本轮签名收据，公钥用该收据核对。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_terminal -- .cache/plugin-sdk/examples/reference-terminal/main.js <测试种子文件> <新ZIP绝对路径> terminal-reference local-acceptance
```

按[真实 Node 包](#rust-与生成)准备 `SWB_NODE_RUNTIME_TEST_ROOT`，将 `SWB_TEST_SIGNED_TERMINAL_RECEIPT` 设为签名收据的绝对路径。无头桥接测试使用文件选择夹具，覆盖实际管理事务、精确 Virtual 会话上的视图资源与 Raw reader、撤权和重新激活。测试关闭 reader 后继续录制，重开读取留存数据，并回放已完成的录制核对关闭前、中、后的 RX 字节与会话代次。Host 分段测试检查后段同长度篡改。无头 Chromium 测试载入实际壳脚本和 SDK 终端包，检查 sandbox 端口、确认序号、设备文字安全和 iframe 重载。原生窗口、实际产品客户端及平台差异按下面的场景验收。

将 `SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 指向同源的两个程序。无头桥接用例会在同一 Host 上对照桌面 reader、实际 CLI 和官方 MCP SDK 读到的会话数据与录制结果，再撤销 MCP 对该会话和录制的读取授权，复核 CLI 仍可读取。两个变量均缺失时日志会记录跳过这部分用例，四目标里程碑 CI 提供两个程序。

同时将 `SWB_TEST_TERMINAL_HOST_BIN` 指向按[发行资源布局](./contracts/runtime-distribution.md#安装布局与启动)准备、能自行定位固定 Node 的同源正式 Host 程序。正式进程用例在独立 profile 和无关工作目录启动该二进制，进程环境去掉 PATH，核对已持有的 Host PID 和实际 Node PID。签名终端共用管理、视图、录制和三入口断言，最后由实际 CLI 停止 Host 并等待真实退出。仅复跑嵌入式 Host 时，可用全名 `native_reference_terminal_install_enable_and_revoke_through_desktop_bridge` 选择用例。

```sh
pnpm build
cargo build --locked -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo test --locked -p serial-workbench-host --lib pages_retain_the_verified_digest
cargo test --locked -p serial-workbench --lib native_reference_terminal_ -- --ignored --test-threads=1 --nocapture
pnpm test:ui e2e/browser/plugin-view.spec.ts
```

要在同一正式 Host 上加跑 Claude Code MCP 客户端验收，将 `SWB_TEST_CLAUDE_CODE_BIN` 设为已安装程序的绝对路径，将 `SWB_TEST_TERMINAL_PRODUCT_OUTPUT` 指向本轮新建的空目录，然后只运行 `native_reference_terminal_uses_installed_runtime_through_formal_host`。Windows 若需要指定 Git Bash，请设置 `CLAUDE_CODE_GIT_BASH_PATH`。用例给实际 stdio 适配器授予同一 Virtual 会话及录制输出的精确读取权，通过客户端发现并调用签名动作，核对完成录制的引用和正文。撤销授权后用同一身份重新连接，检查目录和原引用。客户端使用临时配置及本地预设模型响应，记录目录保留客户端事件和授权前后的调用。

在独立桌面或已约定的前台时段，保持 `SWB_TEST_SIGNED_TERMINAL_RECEIPT` 指向本轮签名收据并运行 `pnpm test:e2e --interactive --terminal-manual --skip-build`。runner 核对已准备固定 Node 的构建，启动独立 Host 和桌面程序，并输出 `terminal-inputs.json`。从该文件复制来源 ID、密钥 ID 和公钥十六进制，使用实际文件对话框选择其中的 ZIP 和录制路径。在无其他输入的 Virtual Echo 会话中依次发送 `writes` 中的三个 HEX 值，分别在关窗前、关窗期间和重开后发送，关闭发送区的额外行尾。完成录制、停用和撤权步骤后退出应用。runner 等待本轮 Host 停止，再按本轮 Host 及实例代次回放核对完整录制、同一会话和全部 69 字节。窗口焦点、显示、语言、主题、缩放及隔离观察另记录在同一 `artifacts/e2e/signed-terminal-*` 目录。

四目标独立桌面通过 `pnpm test:e2e --interactive --terminal-automated --skip-build` 执行签名场景。`pnpm e2e:build --with-node-runtime` 在同一次 Cargo 构建准备桌面、伴随程序、签名工具和录制核对工具。runner 校验收据中的工具路径和摘要，再在 Host 退出后运行预编译的录制核对工具。场景使用真实主窗、Host 和独立 Wry 渲染器。从主窗安装并显式授权，录制期间通过实际 CLI 追加读取权，核对关闭和重开中的 Raw 确认位置、累计 RX 字节、撤权停止及最终回放。缩放按手动入口验证。

Windows 四目标桌面作业和 Windows 原生预检各用真实系统对话框执行一次完整签名场景。先构建并自检一次辅助程序，WebDriver 在打开和保存时调用同一个程序。它只操作该次启动的应用 PID 所拥有的前台对话框，确认文件名控件持有键盘焦点后由系统键盘输入路径，读回核对再按 Enter。随后按 Host 实际登记的目标路径验证开始录制。打开和保存分别记录原生窗口句柄、所属应用、输入方式、提交路径和焦点返回。证据为 `native-picker-open.json`、`native-picker-save.json` 和同一次原生场景日志。Linux 与 macOS 的自动化使用文件选择夹具，其他原生桌面观察按阶段出口验收。

需要从桌面核对录制正文时，用本地用户控制入口给桌面身份授予所选输出引用的 `content.read`。验证录制期间追加权限时，先开始录制，再提交这项授权。随后发送已知字节，停止录制并回放核对。Host 定向用例使用 `cargo test --locked -p serial-workbench-host --test capture_api_host`。同组还覆盖源读取或目标写入撤销后空闲录制的真实终态。

1. 在桌面插件页打开「管理来源」，认可测试来源。点击「安装插件」，选择来源和文件。核对列表显示插件名称、版本和「等待授权」，展开行核对签名来源。归档摘要通过 Host 回执核对。用普通 MCP 身份检查目录，再用正确的包摘要和当前 revision 请求确认执行信任。应观察到目录隐藏该动作、请求被拒绝，信任记录和 revision 保持原值。随后由本地用户确认同一份包并显式启用。
2. 用同一 Virtual 会话录制已知输入。为核对结果，给验收身份单独授予所选录制输出的 `content.read`。打开只读终端的隔离 iframe，关页后继续输入，再重开视图。核对录制覆盖关页前、中、后的字节及顺序，旧视图订阅已释放，新视图按快照与游标接续。慢读者或游标过期时应显示缺口或从可用录制补读，核对恢复区间，不能用屏幕最后一行推断录制完整。
3. 给三个入口的测试身份授予相同的目标读取范围，对照同一源、会话代次和字节区间的可见结果。选一个身份读取录制的结果引用，确认可读后撤销其内容权限。再次读取原区间和该引用，正文均应被拒绝，其余获准读者仍可读取。验证有副作用的动作时，用一次接纳的回执观察终态，独立调用分别核对接纳和实际执行次数。

本场景提供 GUI 管理、公开 SDK 和关页连续性的证据。B 的流预算、取消与压力场景及 C 的三个完整参考包仍按[路线](./plan.md#当前执行与下一步)验收。

保留同一桌面连接复查执行信任撤销及重新启用。签名终端桥接用例逐次对照实际 Host 目录可见性和传给窗口的目录变更通知。`pnpm exec vitest run src/providers/host-controller.test.ts` 同时检查旧连接通知和晚到目录页。

`pnpm test:ui e2e/browser/plugins.spec.ts e2e/browser/smoke.spec.ts` 通过受控桌面 IPC 检查安装页、按名称和版本识别插件、来源、信任后显式启用及失败提示。用例检查界面中的权限说明和实际意图携带的原包摘要，覆盖暗色和中文窄窗口。原生文件对话框和实际窗口仍用前述独立或前台环境验收。

## 图表参考包后台采样

执行 `pnpm plugin-sdk:fixture`，复用独立的 32 字节 Ed25519 测试种子和已准备的固定 Node。将签名 stdout 保存为收据，并把 `SWB_TEST_SIGNED_CHART_RECEIPT` 设为其绝对路径。`SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 分别指向同源 CLI 和 MCP 程序。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_chart -- .cache/plugin-sdk/examples/reference-chart/main.js <测试种子文件> <新ZIP绝对路径> chart-reference local-acceptance
cargo test --locked -p serial-workbench --lib native_chart_samples_exact_rx_from_the_signed_reference_package -- --ignored --test-threads=1 --nocapture
node --test scripts/reference-chart.test.mjs
pnpm test:ui e2e/browser/plugin-view.spec.ts e2e/browser/chart-view.spec.ts
```

定向场景在独立 Virtual Echo 会话内安装签名包，确认执行信任后显式启用。三次输入跨实际 RX 事件拼成 `1.25`、`-2` 和 `3.5`，分别核对字节范围 `[0,6)`、`[6,9)` 和 `[9,13)`。同源 CLI 对照桌面桥首页，官方 MCP SDK 通过真实 stdio 程序对照两页。超长输入使对应任务失败，Host 仍能读到原始输入和前一任务的样本。缺口测试用受控 SDK 输入验证未完成记录不会跨缺口发布。实际运行故障按 C 的完整场景验收。

桌面桥接用例从同一个成功 Operation 开启和重开图表并对照派生页，撤销执行信任后复查读页。无头 Chromium 用实际壳和图表脚本验证 iframe 隔离、留存缺口、曲线与样本值。原生图表窗口以及运行中采样仍需按 C 的完整场景验收。

## 自动化参考包后台应答

执行 `pnpm plugin-sdk:fixture`，复用独立的 32 字节 Ed25519 测试种子和已准备的固定 Node。把签名 stdout 保存为收据，将 `SWB_TEST_SIGNED_AUTOMATION_RECEIPT` 设为其绝对路径。`SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 分别指向同源 CLI 和 MCP 程序。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_automation -- .cache/plugin-sdk/examples/reference-automation/main.js <测试种子文件> <新ZIP绝对路径> automation-reference local-acceptance
cargo test --locked -p serial-workbench --lib native_automation_uses_exact_responses_and_keeps_capture_running -- --ignored --nocapture
```

用例在 Virtual Echo 会话核对两次应答和 RX 范围，再分别验证应答不符、收到前缀后超时和等待应答时取消。结果区分超时和应答不符，取消请求与父动作实际停止分别核对。三种情况下都只接纳首个发送子动作。独立发送仍可使用同一会话，停止录制后逐字节核对全部 32 字节。真实 MCP 程序在同一会话另执行一步，CLI 读取同一结果引用并核对正文。撤销 MCP 的会话读取权限后复查结果读取工具和 CLI 的独立读取权。

`node --test scripts/node-backend-cancellation.test.mjs` 向实际 Node bootstrap 先发送带 `CANCELLED` 的 Raw 回执，并验证任务在收到取消控制帧之前已报告取消。真实 Host 中的授权复核、父动作终态和录制连续性仍由原生用例验证。

完整四目标 CI 的原生 runtime 验收步骤使用每个目标实际安装布局，构建、签名并运行终端、图表和自动化三个参考包的无窗口用例。产物分别保留在 `artifacts/reference-terminal`、`artifacts/reference-chart` 与 `artifacts/reference-automation`。各平台的原生窗口和实际离线安装遵循阶段出口另行验收。

## Host 软件验收

正式六场景 T01/T03/T04/T05/T06/T08 不随 workspace 测试自动执行。构建同源三程序和 harness，随后运行：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo build --locked -p serial-workbench-host --example software_scenarios
node scripts/test-host-scenarios.mjs --harness <harness绝对路径> --output <尚不存在的证据目录>
```

默认 harness 在 `src-tauri/target/debug/examples/`，Windows 带 .exe；从相邻 debug 查找正式程序。wrapper 只接受实际 600 秒 T06、六场景/18 断言、有效源与相对证据路径、telemetry 及全部自有进程退出记录。成功后才删除临时 profile，失败保留现场；POSIX 持有进程组有界停止，Windows 由持有的 Job 收容子进程。

| 场景 | 必须覆盖                                                 |
| ---- | -------------------------------------------------------- |
| T01  | 三客户端同会话，RX/TX hash，partial/unknown 不重放       |
| T03  | 客户端离开后任务继续，退出结算，重启 epoch 不重发        |
| T04  | 能力/逐字段配置结果、BREAK 清理和隔离                    |
| T05  | 写盘故障、轮转恢复、崩溃前缀；注入错误与真实满盘分别记录 |
| T06  | 慢读者隔离、控制响应、丢失核算及 600 秒遥测              |
| T08  | 离页继续录制、完成验证、只读回放/seek                    |

完整 JSON/断言名称由 [wrapper](../scripts/test-host-scenarios.mjs) 和 [harness](../crates/host/examples/software_scenarios.rs) 维护。样本须覆盖时长、单调时间与字节、相邻不超过 3 秒；RSS 为实际进程树，队列取 Host 指标，延迟取客户端单调时钟并按 nearest-rank 核对。11,520 B/s 是软件参考负载；记录实际目标、系统和程序哈希。

Node 组合负载在同一套六场景上复用 T06 的发生器、Raw 慢读者、控制遥测和录制。先运行 `pnpm plugin-sdk:fixture`，然后指定已校验资源目录及编译后的公开 SDK 示例。证据目录与基座运行分别提供。

```sh
node scripts/test-host-scenarios.mjs --harness <harness绝对路径> --output <新证据目录> --node-runtime <已准备的资源目录> --node-parser .cache/plugin-sdk/examples/t06-parser.js
```

发生器在录制、读者及签名解析任务就绪后启动。验收核对发生器、快速 Raw 读者、解析器、回放的字节与 SHA-256，以及派生页的全部偏移范围、慢读者过期和恢复。逐秒校验派生留存和读页占用、峰值与限额；读页排空后确认读页占用归零，历史峰值与留存样本仍可观测。Node 运行在独立私有 Host，并由实际 CLI 停止该 Host，再确认 Node 进程退出。组合 RSS 采集 Host、验收客户端及实际 Node owner，辅助进程另行取证。原始包、派生样本、逐秒控制及队列遥测、录制和退出证据随报告留存。

Ubuntu 手动 CI 在联网安装/构建后运行 `scripts/test-host-offline.mjs`，以独立 network namespace、原 runner UID/GID 执行同一六场景。前后核对命名空间、仅未启用 lo、无 IP/双栈路由及父环境不变，并从外部上传原始证据。失败不回退联网；本地单元测试只验证接线。

### 独立录制格式

```sh
cargo run --locked -p serial-workbench-host --example capture_fixture -- --output <新fixture绝对目录>
node scripts/test-capture-container-independent.mjs --fixture <该目录> --result <新的外部结果绝对路径>
```

Node reader 不依赖 Rust parser/SDK/IPC，扫描全部卷核对字节、索引、水位、摘要和 partial/unknown。两个输出位置尚不存在，结果文件在 fixture 外。格式见 [Capture](./contracts/capture-container-v0.md)。

## 持续集成

[手动 CI](../.github/workflows/ci.yml)覆盖 Windows x64、Linux x64、macOS arm64/x64。里程碑选择完整模式，检查四个 Rust 和四个 Native 目标实际执行，核对收据、源码与未签名构建，Ubuntu 正式场景须在隔离网络中运行。runtime 专项、单目标诊断和关闭 Native 的运行均不替代完整候选。

完整模式将 Linux x64 的 `verified_backend_` 用例放在独立必跑作业。该作业按同一候选验签并准备固定运行时，串行执行原筛选范围，保存候选 SHA、完整测试输出、运行时收据和失败夹具。Ubuntu Rust 作业仍覆盖 workspace、离线六场景和 600 秒负载，并在同次未签名构建上验证运行时安装布局及三个签名参考包。两个作业均须通过，单项断言和原 60 分钟作业上限继续适用。

### 失败定位与复验顺序

1. 先查失败作业的第一个失败步骤和原始产物，记下候选、平台、缓存命中、耗时、实际执行到的断言及退出原因。依赖下载、runner、测试驱动和产品各有对应的复现入口。启动或安装前失败时，对应业务场景记为未测。时间上限触发时，先找出耗时阶段和它正在等待的对象。
2. 用同一输入和验收断言在失败平台定向复验。产品缺陷优先得到修复前后的对照。测试夹具明确等待新代次、所有权或应用状态；真实窗口同时核对对话框关闭、焦点归属和 Host 实际接受的结果。并发或超时带来的晚结果先查当前状态。已有副作用的命令仍按一次投递观察，重试和首次结果都留证据。
3. 已知失败路径在定向复验通过后，再汇合到同一候选的本机综合检查、完整无头 UI 和四目标 CI。仅依赖或 runner 被阻断时，在确认恢复后复跑受影响作业。记录缩短前后的构建、缓存及用例耗时，保留完整出口应有的目标、负载、断言及原始失败。

## M3 契约冻结

以至少两个仅使用公开 SDK 的参考插件验证终端、协议事务、长脚本、网络和独占工具交接、合成 UART 波形及图表离屏导出。核对 schema 与类型、获准入口的结果、revision/epoch、撤权、取消、unknown、写盘恢复及未来格式。完成不兼容版本拒绝、实际 MCP 产品客户端、正式 Node 离线包、后台整套升级和故障回收后冻结 v1。

## 安装与发行验收

进入 M6 时，按[验收场景映射](./requirements.md#附件验收方案与功能映射)核对纳入需求在前序阶段应完成的软件验证。例如 T04 此时已有能力与配置回执，接线与仪器结果留在 M6 实测。PERF-08 的实际 72 小时在本阶段完成。T14 的离线包和后台升级分别在 M2、M3 验证，M6 用发行候选核验最终产物。退出 M6 时逐项核对适用的软件、硬件和发行证据，排除或推迟项沿用账本中的范围决定。

安装升级前先按变更选择数据验证：CAS 冲突、未来格式拒写、读/写/备份失败、替换竞态及中断恢复均核对原件和最终状态。隔离恢复同时检查暂存、明确重启、归档及回滚；只读 fixture 或成功返回不足以确认恢复正确。

按实际系统覆盖安装、首次/重复启动、卸载、系统 WebView、协议关联、自启动与窗口恢复；更新使用两个不同版本核对下载/验签、工作协商、安装、重启和失败恢复。Windows portable 单独验证，macOS 签名/公证、Linux 包格式分别记录。

按[平台目标](./requirements.md#平台目标)在最低支持系统核验安装与运行。Windows 实测目标芯片、接线、流控、BREAK、拔插与休眠，并用两台物理机在 IPv4/IPv6 下互换 LAN 角色。macOS/Linux 做实现与虚拟设备验证。三平台各自用固定 release 和典型负载实际运行 72 小时，记录机器、完整进程树、吞吐、队列、CPU/RSS 和控制延迟。

初始软件参考负载为单会话 11,520 B/s、四会话各 100 KiB/s、八会话各 1 MiB/s 压力；M1/M2 实测后固定机器、预算及阈值。3/6/12 Mbps 使用确实支持的适配器和对端；百万点/60FPS 记录通道、可见范围及降采样，满队列保留缺口或停止原因。

## 依赖审计

`pnpm audit` 与 `cargo audit --file Cargo.lock` 使用当前锁文件；手动 audit workflow 保留。请求失败记为未完成，实际风险、升级和暂缓原因写入 PR，不将工具不可用记作通过。
