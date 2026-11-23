# 专项验收

从仓库根运行。按[测试指南](./testing.md)准备环境，按[需求矩阵](./requirements.md#附件验收方案与功能映射)选择适用场景。当前结果见[路线](./plan.md)与[需求账本](./feature-status.json)。

| 要验证的能力                            | 入口                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| 真实桌面、浏览器配对、双 Host 和接管    | [原生桌面](#原生桌面) · [配对浏览器与 LAN](#配对浏览器与-lan)                           |
| 本机 HTTP 控制、版本拒绝和重启恢复      | [本机 HTTP 控制](#本机-http-控制)                                                       |
| 固定 Node、签名包后台、Raw/派生流和 SDK | [签名运行时与 SDK](#签名运行时与-sdk)                                                   |
| 签名终端、图表和自动化                  | [终端](#终端参考包验收) · [图表](#图表参考包后台采样) · [自动化](#自动化参考包后台应答) |
| 六个 Host 软件场景、T06 与录制校验      | [Host 软件验收](#host-软件验收) · [独立录制格式](#独立录制格式)                         |
| v1 冻结、安装升级和实机发行             | [M3 契约冻结](#m3-契约冻结) · [安装与发行验收](#安装与发行验收)                         |

## 原生桌面

先按[桌面边界](./testing.md#桌面边界)安排运行环境。

先运行 `pnpm e2e:build`，再用 `pnpm test:e2e --interactive --skip-build` 执行 `e2e/specs/`。用构建收据核对桌面及相邻 Host、CLI、MCP 同源，使用独立 profile。工作台重启场景核对旧实例退出、新 epoch、显式重新附着、订阅和未发草稿。 [运行器](../e2e/run.mjs)

Windows 测试应用在初始化 WebView 前加入自己的 Job，runner 通过独立 profile 收据核对 PID 并按持有的进程句柄停止应用。应用退出关闭 Job 并回收子进程。启动失败或回收未知时保留现场。 [进程管理](../e2e/process.mjs)

签名插件用 `pnpm e2e:build --with-node-runtime` 准备固定 Node 和同源工具。用 `pnpm test:e2e --interactive --skip-build --with-node-runtime` 复用时，runner 在开窗前重查构建收据中的资源、模式和允许的链接。 [终端参考包](#终端参考包验收)

WebDriver 命令报错前可能已触发原生副作用，按一次投递观察结果。日常可用独立 HTTP 夹具复验驱动配置，实际界面等待由只读状态确认。 [传输用例](../e2e/webdriver-transport.test.mjs)

Native 刷新需观察旧文档被替换，再检查新窗口 IPC 就绪。同一阶段串行复用 profile，首个失败后保留现场；成功时核对实际进程退出、非空阶段日志及零意外 RPC 冲突。系统文件选择夹具、条件跳过和无头截图分别标明，不计为真实系统交互。

隔离插件视图须在各平台实际验证。Windows Wry 会把标记为仅主框架的初始化脚本注入子框架，Linux 的原生 IPC 请求也可能报告主框架 URL。验证子框架拿不到 Tauri 全局和通用原生 IPC，并检查导航、旧消息端口失效、关窗回收、焦点、语言、主题及缩放。 [锁定版 Wry 接口](https://docs.rs/wry/0.57.0/wry/struct.WebViewBuilder.html) · [插件视图契约](./contracts/node-extension-v0.md#5-web-ui-与客户端效果)

## 本机 HTTP 控制

AUTO-12 的 HTTP、WebSocket 和 LAN TCP 使用同一候选。附着拒绝核对 `supportedProtocolVersions` 和 `upgradeTarget`，实际收发比较源 Host、会话代次、游标和原始事件。三类入口使用各自的认证和当前 Host 授权。

```sh
cargo test --locked -p serial-workbench-host --test http_control --test browser_pairing -- --test-threads=1
cargo test --locked -p serial-workbench-host --lib paired_host_uses_owner_session_for_tx_and_raw_and_unpair_closes_only_lan
cargo build --locked -p serial-workbench-host -p serial-workbench-cli --bins
node e2e/http-control.mjs <Host绝对路径> <CLI绝对路径> <新证据目录>
```

HTTP 用例以实际 Virtual Echo 核对获准的写入、同一请求重试、改参冲突、读页接续及撤权，并确认未完成的 HTTP 正文不会阻止正式 Host 退出。进程专项使用同轮且相邻的 Host 和 CLI，启动独立 profile，经继承管道取得 HTTP 入口，使用实际 CLI 授权、撤权和停止。重开时核对 Host 与 actor 保持、实例代次递增、旧凭据失效、授予范围保留以及两次进程退出。原始收据记录程序摘要，失败保留独立 profile 与进程日志。 [进程验收入口](../e2e/http-control.mjs) · [HTTP 契约](./contracts/host-v0.md#本机-http-控制)

## 配对浏览器与 LAN

### 配对浏览器

配对浏览器定向验证先运行 `pnpm build`，用 `cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins` 准备同源程序，再运行 `node e2e/paired-browser.mjs <Host> <CLI> dist <新证据目录> <MCP>`。脚本经本机继承管道启动独立 Host，显式授权临时浏览器身份。无头 Chromium 验证错码拒绝、虚拟串口回显、保存布局及刷新后的会话代次，CLI 对照工作区与共享设置。传入 MCP 程序时，同一场景用两组命名身份和两个窗口复验跟随范围、查询轮询、暂停及草稿保留。实际设备查询在草稿编辑期间等待，离开输入框后只在绑定窗口打开目录指定面板，查询轮询不重新打开。暂停期间从实际 MCP 发送并经 Virtual Echo 回显。浏览器发起接管后从 CLI 核对等待确认的客户端与串口。关闭请求窗口后核对清理及原写入权。失败时 WebSocket 诊断记录消息类型、动作和结果码。

签名终端使用同源正式工作台资源、签名归档与固定 Node。在无头 Chromium 配对只读身份后，从「插件」页打开实际签名终端。设置 `SWB_TEST_BROWSER_ASSETS` 为 `dist/`、`SWB_TEST_BROWSER_NODE_BIN` 为固定 Node 程序、`SWB_TEST_SIGNED_TERMINAL_RECEIPT` 为签名收据、`SWB_NODE_RUNTIME_TEST_ROOT` 为准备好的 runtime 目录、`SWB_TEST_BROWSER_TERMINAL_OUTPUT` 为新的证据目录。使用绝对路径，运行 `cargo test --locked -p serial-workbench-host --test browser_pairing paired_chromium_opens_and_retires_a_signed_terminal_view -- --ignored --nocapture`。测试核对包摘要、opaque frame、实际 Virtual Echo 的原始回显、关页后焦点和读取者回收、重开补读、实测撤销执行信任和原会话继续运行。浏览器签名终端支持相对路径的预构建普通脚本和样式。

签名图表复用同一配对夹具。按[后台采样](#图表参考包后台采样)准备签名图表与固定 Node，另设 `SWB_TEST_SIGNED_CHART_RECEIPT` 和新的 `SWB_TEST_BROWSER_CHART_OUTPUT` 绝对路径，运行 `cargo test --locked -p serial-workbench-host --test browser_pairing paired_chromium_reads_and_retires_a_signed_chart_view -- --ignored --nocapture`。用已签名的视图接收 Virtual Echo 派生样本，核对专属 Raw 页面确认、关页后采样继续并重开补读、浏览器与本机 Host 的样本及源字节范围一致。最后撤销执行信任，检查旧视图释放且原工作台连接与串口会话仍可用。

已运行的 Host 用 `cargo test --locked -p serial-workbench-host --test browser_pairing` 验证本机配对、只读授权、撤销和接管。撤销后确认两个浏览器连接关闭，再在同一串口会话核对桌面发送的终态。接管用实际 WebSocket 发起，核对浏览器不能自行批准，拒绝及断开后原写入权保留，批准后只有所选 MCP 失去当前串口写入权。桌面设置的无头用例为 `pnpm test:ui e2e/browser/browser-access.spec.ts --workers=1`，验证配对与停用、窄窗口和焦点，以及明确显示端口和客户端后传递当前确认编号。正式桌面验收从实际设置页生成配对码，用该候选安装资源打开浏览器，再从真实桌面窗口确认浏览器发起的接管。

Windows 托管原生作业复用同一 E2E 构建，准备 Chromium headless shell 后运行 `pnpm test:e2e --interactive --skip-build --browser-takeover`。本机只在独立环境或约定的前台时段运行。原生设置页选「查看和操作」并生成配对码，无头 Chromium 使用该入口及实际资源加入。原生确认后检查浏览器收到终态、所选 MCP 失去写入权及另一客户端仍可发送。关闭浏览器访问后核对连接退出和原会话的真实回显。`artifacts/e2e/browser-takeover-*` 保留同源构建收据、原生确认截图、权限与会话结果及日志，截图隐藏配对码。

### 双 Host

LAN 进程验收使用同源且相邻的 Host、CLI 和 MCP 程序，运行 `node e2e/lan-route.mjs <Host> <CLI> <MCP> <新证据目录>`。脚本启动两份独立 Host，在 B 打开 Virtual Echo 并共享。A 的实际 CLI 验证授权前拒绝、跨进程读写 B 的会话与原操作回执，实际 MCP 验证 B 对命名客户端的独立归属。撤销 A 的 CLI 路由权后 MCP 仍可读取，A 解除配对后确认原 MCP 路由失效，B 本地会话仍可读。收据和命令日志用于软件验收。跨机网卡、USB 设备和控制租约恢复各按相应场景验收。

同机双栈角色模拟运行 `node e2e/lan-route.mjs <Host> <CLI> <MCP> <新证据目录> --loopback-roles`。runner 直接启动并持有同一对 Host，给两份独立 profile 各开一个 Virtual Echo。双方在 IPv4 和 IPv6 回环地址轮流作发起端与会话所属端，逐次核对配对身份、Host 和会话代次、CLI 写入终态以及本地与远端读回的 Raw 来源、游标和字节。每轮确认监听端口释放，最后核对两个自有进程正常退出。原始事件、程序摘要及进程日志随收据保存。此项记录同机软件模拟范围，两台 Windows 物理机的双栈角色互换及 USB 串口继续按 M6 实机验收。

活动跟随核对两个 Host 所见的活动编号和操作者一致。A 只能订阅获准会话的活动，B 收回共享后终止订阅。工作台按所选客户端定位共享会话和配置面板。

S12 软件用例运行 `cargo test --locked -p serial-workbench-host --lib stopped_caller_host_loses_its_interactive_lease_but_owner_settles_independent_tx`。B 共享尚未打开的 Virtual Echo 设备。A 经真实 TCP 请求打开、发现新会话并使用其收发。测试时钟只推进 B 的租约时间，派发屏障控制断线或撤权的时机。核对 B 的原始 TX/RX、旧请求回执、独立任务和 A 重启后重连。B 人工接管选中的客户端时，核对已接纳写入取消、同一对端另一客户端与 B 本机继续写入、所选客户端继续读且重连仍拒绝写入。B 重新授权后试读旧回执并发送新 TX。最后撤销整项共享，核对 A 独立任务在派发前取消而 B 本机写入继续。

桌面 LAN 桥的无窗口检查在准备 `dist` 后运行 `cargo test --locked -p serial-workbench --lib desktop_lan_switch_uses_remote_business_and_local_management`。两份真实 Host 以 TCP 相连。用例核对失败切换保留本机代次，成功切换使用 B 的普通身份收发。窗口的原本机连接继续读取 A 的共享设置，配对管理也落在 A。随后验证远端重连沿用所选身份，返回本机沿用原代次并释放远端连接，B 的会话继续运行。

桌面 LAN 界面用 `pnpm test:ui e2e/browser/lan-access.spec.ts --workers=1` 验证设置中的配对、监听、授权与撤销，以及工作台的连接重试、收发显示、草稿和设置归属。真实 TCP、授权及收发由桌面桥和 LAN 用例验证。

Windows 原生用例复用桌面 CI 的同源构建，在隔离桌面运行 `pnpm test:e2e --interactive --skip-build --lan`。运行器持有两份 Host 和配置，依次启动 B 和 A 的桌面。B 在设置中共享已打开的串口，接管实际转发的一个 MCP 客户端，验证其他客户端和 B 本机继续收发。A 从工作台连接并打开同一会话，通过桌面收发，跟随命名 MCP 客户端的参数动作，再回到本机 Host。收据、截图、进程日志和构建信息保存在 `artifacts/e2e/lan-desktop-*`。全量四目标 CI 的 Windows 原生作业执行该用例。物理机和实际 USB 串口按 M6 矩阵验收。

### 本机接管

桌面人工接管在「活动」中选择 MCP 客户端，再接管当前串口。Host 定向用例用 `cargo test --locked -p serial-workbench-host --test control_state takeover` 核对排队、在途结算和无法确认的控制结果。`takeover_waits_for_the_selected_admission_but_not_another_serial_port` 检查接纳中的请求与其他串口并发。准备 `dist` 后运行 `cargo test --locked -p serial-workbench --lib desktop_takeover_revokes_the_selected_actor_and_keeps_the_session`，使用无窗口桌面桥和实际 Host 确认撤销范围、终态及原会话代次。真实窗口按桌面运行前提验收。

## 签名运行时与 SDK

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

## 签名参考包

桌面 Rust 用例先运行 `pnpm build` 准备 dist。真实窗口使用[同源原生构建](#原生桌面)。

### 终端参考包验收

「串口监听」通过公开 SDK 提供所选串口的只读收发视图。以同一候选的桌面、Host、CLI 和 MCP 在独立 profile 验收，真实窗口遵守[桌面边界](./testing.md#桌面边界)。收据记录包摘要、Host、会话代次和 Virtual 输入的字节范围及摘要。

终端源码位于 [SDK 示例](../packages/plugin-sdk/examples/reference-terminal/)。先运行 `pnpm plugin-sdk:fixture`。签名工具读取单独准备的 32 字节 Ed25519 测试种子，输出 ZIP 和一行包含包摘要、来源 ID 和公钥的 JSON。保存 stdout 作为本轮签名收据，公钥用该收据核对。

已交付的签名参考包变更后递增版本，用原来源签发。验收包内修复时从上一版已安装状态升级，核对启用、执行信任和新的界面表现。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_terminal -- .cache/plugin-sdk/examples/reference-terminal/main.js <测试种子文件> <新ZIP绝对路径> terminal-reference local-acceptance
```

按[真实 Node 包](#签名运行时与-sdk)准备 `SWB_NODE_RUNTIME_TEST_ROOT`，将 `SWB_TEST_SIGNED_TERMINAL_RECEIPT` 设为签名收据的绝对路径。无头桥接测试使用文件选择夹具，覆盖实际管理事务、精确 Virtual 会话上的视图资源与 Raw reader、撤权和重新激活。测试关闭 reader 后继续录制，重开读取留存数据，并回放已完成的录制核对关闭前、中、后的 RX 字节与会话代次。嵌入式 Host 场景暂缓视图确认，用正常 Virtual Echo 输入验证缺口与后续数据，再核对协议上限的 TX 意图完整到达。Host 分段测试检查后段同长度篡改。无头 Chromium 测试载入实际壳脚本和 SDK 终端包，检查 sandbox 端口、确认序号、缺口提示、恢复后的内容、设备文字安全和 iframe 重载。原生窗口、实际产品客户端及平台差异按下面的场景验收。

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

四目标独立桌面通过 `pnpm test:e2e --interactive --terminal-automated --skip-build` 执行签名场景。`pnpm e2e:build --with-node-runtime` 在同一次 Cargo 构建准备桌面、伴随程序、签名工具和录制核对工具。runner 校验收据中的工具路径和摘要，再在 Host 退出后运行预编译的录制核对工具。场景使用真实主窗、Host 和独立 Wry 渲染器。从主窗安装并显式授权，录制期间通过实际 CLI 追加读取权，核对关闭和重开中的 Raw 确认位置、累计 RX 字节、撤权停止及最终回放。

Windows 四目标桌面作业和 Windows 原生预检各用真实系统对话框执行一次完整签名场景。先构建并自检一次辅助程序，WebDriver 在打开和保存时调用同一个程序。它只操作该次启动的应用 PID 所拥有的前台对话框，确认文件名控件持有键盘焦点后由系统键盘输入路径，读回核对再按 Enter。随后按 Host 实际登记的目标路径验证开始录制。打开和保存分别记录原生窗口句柄、所属应用、输入方式、提交路径和焦点返回。证据为 `native-picker-open.json`、`native-picker-save.json` 和同一次原生场景日志。Linux 与 macOS 的自动化使用文件选择夹具，其他原生桌面观察按阶段出口验收。

同一次 Windows 签名场景用系统键盘输入 `Ctrl+=` 和 `Ctrl+0`，从真实 WebView2 controller 观察前台主窗和插件窗各自的放大与恢复。插件窗口在确认回读录制期间的输入后保留放大前后的原生截图。仅复验签名场景时，在[手动 CI](../.github/workflows/ci.yml)设置 `native_preflight=true`、Windows x64 目标和 `desktop_e2e=false`。四目标里程碑继续执行基础桌面用例和参考包场景。

验收撤权后重新信任并启用同一个签名包。从恢复的目录入口新开视图，核对桌面连接的 generation 未变化、旧视图已关闭、新视图确认了关窗前后的完整 RX。Windows 还通过桌面控件把英语深色切换为中文浅色，待新视图确认读取后保存原生截图，和先前的英语深色截图一起核对。

需要从桌面核对录制正文时，用本地用户控制入口给桌面身份授予所选输出引用的 `content.read`。验证录制期间追加权限时，先开始录制，再提交这项授权。随后发送已知字节，停止录制并回放核对。Host 定向用例使用 `cargo test --locked -p serial-workbench-host --test capture_api_host`。同组还覆盖源读取或目标写入撤销后空闲录制的真实终态。

1. 在桌面插件页打开「管理来源」，认可测试来源。点击「安装插件」，选择来源和文件。核对列表显示插件名称、版本和「等待授权」，展开行核对签名来源。归档摘要通过 Host 回执核对。用普通 MCP 身份检查目录，再用正确的包摘要和当前 revision 请求确认执行信任。应观察到目录隐藏该动作、请求被拒绝，信任记录和 revision 保持原值。随后由本地用户确认同一份包并显式启用。
2. 用同一 Virtual 会话录制已知输入。为核对结果，给验收身份单独授予所选录制输出的 `content.read`。打开只读终端的隔离 iframe，关页后继续输入，再重开视图。核对录制覆盖关页前、中、后的字节及顺序，旧视图订阅已释放，新视图按快照与游标接续。慢读者或游标过期时应显示缺口或从可用录制补读，核对恢复区间，不能用屏幕最后一行推断录制完整。
3. 给三个入口的测试身份授予相同的目标读取范围，对照同一源、会话代次和字节区间的可见结果。选一个身份读取录制的结果引用，确认可读后撤销其内容权限。再次读取原区间和该引用，正文均应被拒绝，其余获准读者仍可读取。验证有副作用的动作时，用一次接纳的回执观察终态，独立调用分别核对接纳和实际执行次数。

保留同一桌面连接复查执行信任撤销及重新启用。签名终端桥接用例逐次对照实际 Host 目录可见性和传给窗口的目录变更通知。`pnpm exec vitest run src/providers/host-controller.test.ts` 同时检查旧连接通知和晚到目录页。

`pnpm test:ui e2e/browser/plugins.spec.ts e2e/browser/smoke.spec.ts` 通过受控桌面 IPC 检查安装页、按名称和版本识别插件、来源、信任后显式启用及失败提示。用例检查界面中的权限说明和实际意图携带的原包摘要，覆盖暗色和中文窄窗口。原生文件对话框和实际窗口仍用前述独立或前台环境验收。

### 图表参考包后台采样

执行 `pnpm plugin-sdk:fixture`，复用独立的 32 字节 Ed25519 测试种子和已准备的固定 Node。将签名 stdout 保存为收据，并把 `SWB_TEST_SIGNED_CHART_RECEIPT` 设为其绝对路径。`SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 分别指向同源 CLI 和 MCP 程序。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_chart -- .cache/plugin-sdk/examples/reference-chart/main.js <测试种子文件> <新ZIP绝对路径> chart-reference local-acceptance
cargo test --locked -p serial-workbench --lib native_chart_samples_exact_rx_from_the_signed_reference_package -- --ignored --test-threads=1 --nocapture
node --test scripts/reference-chart.test.mjs
pnpm test:ui e2e/browser/plugin-view.spec.ts e2e/browser/chart-view.spec.ts
```

在独立 Virtual Echo 会话安装签名包，确认执行信任后启用。核对签名清单的解析器通过 Host 目录可发现，跨 RX 事件拼成的样本携带实际事件游标与原始字节区间。CLI 和实际 stdio MCP 对照桌面桥的分页结果。验证普通身份的会话授权边界及撤销执行信任后的目录撤回。超长输入失败时保留原始输入和此前样本，用受控 SDK 输入验证未完成记录不会跨缺口发布。

桌面桥接用例在生产 Operation 运行中开启图表。首个样本发布前视图保持等待，输入两个完整样本后先读取这两项，再发送最后一段并经同一视图读完。重开后对照留存页，撤销执行信任后复查读页。用例还经真实 MCP 发起离屏 SVG 导出，核对同一结果引用的字节与桌面实际另存的文件一致。无头 Chromium 用实际壳和图表脚本验证 iframe 隔离、留存缺口、曲线与样本值。

实际图表窗口可在[手动 CI](../.github/workflows/ci.yml)选择 `native_preflight=true`、目标和 `native_preflight_chart=true`。独立桌面上经插件页安装签名包，开窗后切回工作台发送一组电压。第一个样本获实际隔离 iframe 确认后关闭图表，再发送两个样本。回到插件页选择「另存为 SVG…」，核对文件中的曲线和文件摘要。Windows CI 通过实际系统保存对话框选择目标并记录焦点返回，其他平台由夹具提供目标。重开图表并核对同一任务的三项样本。随后让 runner 停止并重启持有的 Host，核对新进程和代次，以及重开的原生窗口随旧连接关闭。SVG、收据与原始日志保存在 `artifacts/e2e/signed-chart-*`。需验收图表的完整四目标候选设置 `desktop_chart=true`，Windows 桌面作业共用一套构建和固定 Node，并执行签名终端及图表场景。

### 自动化参考包后台应答

执行 `pnpm plugin-sdk:fixture`，复用独立的 32 字节 Ed25519 测试种子和已准备的固定 Node。把签名 stdout 保存为收据，将 `SWB_TEST_SIGNED_AUTOMATION_RECEIPT` 设为其绝对路径。`SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 分别指向同源 CLI 和 MCP 程序。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_automation -- .cache/plugin-sdk/examples/reference-automation/main.js <测试种子文件> <新ZIP绝对路径> automation-reference local-acceptance
cargo test --locked -p serial-workbench --lib native_automation_uses_exact_responses_and_keeps_capture_running -- --ignored --nocapture
```

用例在 Virtual Echo 会话核对两次应答和 RX 范围，再验证应答不符、收到前缀后超时、迟到应答和等待应答时取消。测试暂停一条设备回显，在观察到原始写入回执且越过配置的应答期限后放行。同一 Host 时钟核对实际到达时间，原请求仍结算为超时，迟到证据指回该请求和原始字节区间，后续步骤不执行。两条用例均从独立 MCP 身份送入竞争写入，检查原始流中的排队意图及租约结算后的实际发送。停止录制后逐字节核对 55 字节。真实 MCP 程序在同一会话另执行一步，CLI 读取同一结果引用并核对正文。撤销 MCP 的会话读取权限后复查结果读取工具和 CLI 的独立读取权。

`node --test scripts/node-backend-cancellation.test.mjs` 向实际 Node bootstrap 先发送带 `CANCELLED` 的 Raw 回执，并验证任务在收到取消控制帧之前已报告取消。真实 Host 中的授权复核、父动作终态和录制连续性仍由原生用例验证。

长脚本用同一签名包与运行时执行 `cargo test --locked -p serial-workbench --lib native_automation_long_script_survives_caller_disconnect_and_settles_workers -- --ignored --nocapture`。实际 MCP 以独立模式接纳六轮脚本，关停发起进程后观察任务进度继续推进，重新连接后通过 MCP 和 CLI 读回同一结果。第二次运行在观察到首轮完成且 worker 仍存活时提交取消，分别核对接纳与终态、未提交后续子项、worker 实际退出以及录制的原始字节和会话代次。

完整四目标 CI 的原生 runtime 验收步骤使用每个目标实际安装布局，构建、签名并运行终端、图表和自动化三个参考包的无窗口用例。产物分别保留在 `artifacts/reference-terminal`、`artifacts/reference-chart` 与 `artifacts/reference-automation`。各平台的原生窗口和实际离线安装遵循阶段出口另行验收。

## 签名主题

按[签名运行时](#签名运行时与-sdk)准备固定 Node，并在独立环境运行 Host 和无头界面检查。

```sh
pnpm plugin-sdk:fixture
cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_theme_ -- --ignored --test-threads=1 --nocapture
pnpm test:ui e2e/browser/theme-colors.spec.ts --workers=1
```

Host 用例通过实际 IPC 安装测试签名包、确认执行信任、启用、停用和撤权。核对目录的包和主题 ID、原归档摘要、颜色及实际配置查询。另测签名正确但含未知字段或违反发布者 schema 的资源被拒绝执行确认，以及通过执行确认的未签名包不提供主题。无头界面用受控 Host 回复核对选色、保存引用、归档变更和断线时的回退。原生桌面与真实配对浏览器的同源显示按阶段出口复验。

签名工具读取单独准备的 32 字节 Ed25519 测试种子，生成桌面安装夹具。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_theme -- .cache/plugin-sdk/examples/reference-theme/main.js <测试种子文件> <新ZIP绝对路径> theme-reference local-acceptance
```

## Host 软件验收

正式六场景 T01/T03/T04/T05/T06/T08 不随 workspace 测试自动执行。构建同源三程序和 harness，随后运行：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo build --locked -p serial-workbench-host --example software_scenarios
node scripts/test-host-scenarios.mjs --harness <harness绝对路径> --output <尚不存在的证据目录>
```

默认 harness 在 `src-tauri/target/debug/examples/`，Windows 带 .exe；从相邻 debug 查找正式程序。wrapper 只接受实际 600 秒 T06、六场景/18 断言、有效源与相对证据路径、telemetry 及全部自有进程退出记录。成功后才删除临时 profile，失败保留现场；POSIX 持有进程组有界停止，Windows 由持有的 Job 收容子进程。

Windows T06 若确认退出码 `0xC00000FD` 来自 harness 主线程栈溢出，可只重链 `software_scenarios` 并设置 4 MiB 栈保留（`-C link-arg=/STACK:4194304`）。保留首次失败并用同一负载复验，Host、Node runtime 和性能预算沿用原候选。

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

## M3 契约冻结

以至少两个仅使用公开 SDK 的参考插件验证终端、协议事务、长脚本、网络和独占工具交接、合成 UART 波形及图表离屏导出。核对 schema 与类型、获准入口的结果、revision/epoch、撤权、取消、unknown、写盘恢复及未来格式。完成不兼容版本拒绝、实际 MCP 产品客户端、正式 Node 离线包、后台整套升级和故障回收后冻结 v1。

DIAG-08 的 M3 金样由 [签名 Host 用例](../crates/host/tests/client_parity/uart_gold.rs) 生成双通道 8N1 电平，再通过 [公开 SDK 示例](../packages/plugin-sdk/examples/uart-gold.ts) 读取字节、原始采样区间和相对纳秒偏移。用例核对两路共用的采样时钟、超过 JavaScript 安全整数的采样序号，以及获准客户端通过文件引用读回的实际结果。先按[签名运行时](#签名运行时与-sdk)准备 `SWB_NODE_RUNTIME_TEST_ROOT` 并运行 `pnpm plugin-sdk:fixture`，再按需选择 `cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_uart_gold_ -- --ignored --nocapture`。四目标 CI 的原生 runtime 检查包含该用例。VCD 和带采样率的 CSV 导入、校验位与 BREAK 在 M5 验收。

### 签名插件传输

按[签名运行时](#签名运行时与-sdk)准备固定 Node 及 `SWB_NODE_RUNTIME_TEST_ROOT`，然后用同轮源码构建 SDK 示例并运行实证。

```sh
pnpm plugin-sdk:fixture
cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_transport_ -- --ignored --test-threads=1 --nocapture
```

用例安装实际签名参考包，通过标准 Host IPC 对批准的插件设备执行打开、写入和关闭。独立本机 TCP 对端核对实际二进制字节，Raw 核对 Host 实例、会话代次和来源。未经授权的打开不能到达对端，撤销用户读取授权终止其 Raw 交付。显式关闭、重新打开的新会话代次和停用后的实际对端断开分别核对。故障用例单独签名测试包装，实际写入后在返回线路回执前退出所属 Node 进程。TCP 对端核对已到达的字节和关闭，Host 核对派发区间仍为 `unknown`、卸下设备目录条目并拒绝过期操作。四目标 CI 的原生运行时检查包含两条用例。桌面参数输入、跨机适配和发行候选证据沿用各阶段的专项。

桌面参数入口运行 `pnpm test:ui e2e/browser/plugin-transport.spec.ts`，检查显式提交、失败保留输入和成功清理草稿登记。Host 参数校验和实际 TCP 对端继续通过签名传输用例检查。

### 有序会话钩子

按[签名运行时](#签名运行时与-sdk)准备资源后，运行 `cargo test --locked -p serial-workbench-host --lib native_node_task_session_hooks_ -- --ignored --nocapture`。签名任务通过 Virtual Echo 核对原代次的打开、实际 RX、最终 TX 回执与关闭，并在回调失败时验证 reader 名额释放。运行 `cargo test --locked -p serial-workbench-host --test session_lifecycle --test stream_budget` 覆盖底层故障、未结算 TX、撤权重授与旧代次的收尾。 `node --test scripts/node-backend-cancellation.test.mjs` 复验迟到页、租约释放及缺口续读。

## 安装与发行验收

Windows 更新准备的原生测试用 `cargo test --locked -p serial-workbench --lib updater::host::tests -- --test-threads=1 --nocapture`。用例在独立 profile 启动真实旧进程，观察正常退出、已释放锁时的等待和非零退出。关闭进程句柄后重试，检查原代次的失败仍会拒绝准备。

验证同协议的旧版与候选 Host 进程时，把 `SWB_TEST_UPDATER_LEGACY_HOST_BIN` 和 `SWB_TEST_UPDATER_CURRENT_HOST_BIN` 分别设为旧版和候选 Host 程序的绝对路径，选择 `desktop_install_recovers_through_current_host_after_legacy_shutdown` 并加上 `--ignored`。按 [Rust 与生成](./testing.md#rust-与生成)核对两份程序的构建与摘要。用例验证旧程序退出后提示重开工作台，再用候选启动同一 profile，核对新代次和正常关停。锁交接、替换与失败恢复须用两个实际安装包验证。

如果测试进程所在的 Windows Job 禁止自动启动独立 Host，保留原始结果，并设置 `SWB_TEST_UPDATER_MANUAL_HOST_START=1` 复验手动启动后恢复同一 profile。收据区分两种启动方式，自动启动仍需在允许独立 Host 启动的环境中验证。

Windows T14 同卷套件切换的软件专项用 `cargo test --locked -p serial-workbench-ipc --lib install_switch::tests -- --nocapture`。夹具使用独立 profile 和模拟的桌面、Host、CLI、MCP、Node 文件。核对写入意图受阻、归档旧套件后中断、新套件换入后提交前中断、处于 Windows 占用状态的目录无法移动、重新取得锁后可以恢复，以及摘要篡改。收据记录原身份、代次、profile 字节核对结果、两个套件的完整摘要及恢复结果。

安装协调进程先验证两套产物的完整摘要并记录操作 ID 和安装路径，经本机 Rust 接口 `InstallSwitch::open` 持有实例锁并核对旧 Host 退出，再调用 `replace`。重启后用同一操作 ID 和安装路径调用 `recover`。调用方负责在换入前排除其他程序写入安装目录，并在启动任何产品进程前完成恢复。当前用户版 NSIS 的暂存入口只接受同一条 `/S /SWB-STAGE` 参数组合，套件写入安装器自身的 `.swb-stage-<operation>` 目录。启动前该目录仅含协调进程已验签的安装器。实际接入须等待安装器退出，收回该份安装器副本并验证剩余目录摘要，再执行套件切换，覆盖注册表与快捷方式的提交和回滚。用两个真实安装包验证进程监督、锁交接和终态。

NSIS 暂存预检在[手动 CI](../.github/workflows/ci.yml)选择 `runtime_preflight=true`、`runtime_preflight_target=x86_64-pc-windows-msvc` 和 `runtime_preflight_suite=windows-nsis-stage`。隔离 runner 编译候选 NSIS，用相同工具链运行 `pnpm test:installer --interactive`。暂存夹具调用生产初始化函数，检查空操作目录写入、已有文件保护和错误目录名拒绝。实际安装器用一次性密钥签名，验证工具在调用暂存入口前拒绝常规签名、版本不符与内容篡改。成功后核对签名安装器副本已收回、Host/CLI/MCP 与 Node 的固定摘要，以及安装相关注册表项的前后状态。`installer-layout.log` 保留全套件、安装器、桌面程序、卸载器和各组件的摘要。正式签名、持锁换入、回滚与两个版本的实际升级各自验证。

候选 `efce804` 的隔离 Windows 收据覆盖 8.3 短名展开、重定向目录拒绝和真实安装器的组件摘要。 [Windows NSIS 暂存收据](https://github.com/YanChao001/serial-workbench/actions/runs/45162109634/artifacts/14812661628)

隔离 Windows 环境中，准备 Tauri 的 NSIS 编译器缓存后运行 `pnpm test:installer --interactive`。暂存夹具嵌入生产入口，在新目录执行并核对套件文件。已含其他文件和命名不符的目录都必须拒绝，保留原文件和安装器副本。此场景不写入已安装程序和注册信息。

M6 用发行候选在预先未安装 WebView2 Runtime 的独立 Windows x64 环境验证 NSIS。将本轮发行候选的安装包和同源验收材料转移到环境中，记录 WebView2 的系统和当前用户注册信息、网络状态及安装前后的版本。断网状态下实际安装并首次启动，使用已安装的程序运行三个签名参考场景。记录系统版本、安装退出码、组件摘要、首次打开窗口及用例结果。M2 和 M3 验证 Windows 安装包内置的离线 Runtime、固定 Node 安装布局和软件参考场景。最低系统和正式发行签名按 M6 矩阵验收。 [Microsoft 离线部署](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#offline-deployment)

Ubuntu x64 的实际 Debian 离线安装可在[手动 CI](../.github/workflows/ci.yml)选 `runtime_preflight=true`、`runtime_preflight_target=x86_64-unknown-linux-gnu` 和 `runtime_preflight_suite=linux-offline-installer`。作业在线构建同源 `.deb` 和签名参考包，进入仅有停用 loopback 的隔离网络后执行 `dpkg --install`。无外网环境中以普通用户运行现有参考包用例。终端使用安装后的 Host、CLI 与 MCP，图表和自动化使用安装后的 runtime 和客户端。收据保留 `.deb` 与安装组件摘要、隔离观察、三个签名包签名回执和测试输出。此专项用于 T14 的 Ubuntu 离线软件验收，原生窗口、最低系统和发行安装器另行验收。

macOS 使用 `runtime_preflight_suite=macos-offline-installer`，目标选择 `aarch64-apple-darwin` 或 `x86_64-apple-darwin`。作业检查 Seatbelt 实际拒绝 IPv4 和 IPv6 连接，保留本机 Unix socket。在同一规则下挂载实际 DMG，把 `.app` 复制到本轮独立安装目录，卸载映像后使用副本运行现有三个参考场景。记录系统、架构、进程隔离、映像与安装组件摘要。签名与公证按正式发行验收执行。

进入 M6 时，按[验收场景映射](./requirements.md#附件验收方案与功能映射)核对纳入需求在前序阶段应完成的软件验证。例如 T04 此时已有能力与配置回执，接线与仪器结果留在 M6 实测。PERF-08 的实际 72 小时在本阶段完成。T14 在 M2 验证离线包，在 M3 验证后台升级，M6 用发行候选核验 Windows 断网实装和最终产物。退出 M6 时逐项核对适用的软件、硬件和发行证据，排除或推迟项沿用账本中的范围决定。

安装升级前先按变更选择数据验证：CAS 冲突、未来格式拒写、读/写/备份失败、替换竞态及中断恢复均核对原件和最终状态。隔离恢复同时检查暂存、明确重启、归档及回滚；只读 fixture 或成功返回不足以确认恢复正确。

按实际系统覆盖安装、首次/重复启动、卸载、系统 WebView、协议关联、自启动与窗口恢复；更新使用两个不同版本核对下载/验签、工作协商、安装、重启和失败恢复。Windows portable 单独验证，macOS 签名/公证、Linux 包格式分别记录。

按[平台目标](./requirements.md#平台目标)在最低支持系统核验安装与运行。Windows 实测目标芯片、接线、流控、BREAK、拔插与休眠，并用两台物理机在 IPv4/IPv6 下互换 LAN 角色。macOS/Linux 做实现与虚拟设备验证。三平台各自用固定 release 和典型负载实际运行 72 小时，记录机器、完整进程树、吞吐、队列、CPU/RSS 和控制延迟。

初始软件参考负载为单会话 11,520 B/s、四会话各 100 KiB/s、八会话各 1 MiB/s 压力；M1/M2 实测后固定机器、预算及阈值。3/6/12 Mbps 使用确实支持的适配器和对端；百万点/60FPS 记录通道、可见范围及降采样，满队列保留缺口或停止原因。
