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

参考图表 0.1.4 的配对场景另核对持续接收、语言切换和重开后的均值与缺点分母。浏览器无头用例 `pnpm test:ui e2e/browser/chart-view.spec.ts e2e/browser/replay-layout.spec.ts e2e/browser/framing-tool.spec.ts --workers=1` 核对过期派生序号、无效样本、工作台校验失败、固定宽度回放缺帧和筛选后的统计口径。

首方 `swb.builtin.chart` 由 Host 按完整归档摘要登记。隔离 profile 的 `native_node_bundled_protocol_registers_on_first_start_and_restart` 用例检查自动激活、无会话授权时拒绝、授权后跨块采样及 SVG 文件，并核对重启后归档摘要与安装 revision 保持。浏览器夹具覆盖共享视图的统计计算。正式离线安装需另从插件页打开「Voltage Chart」，核对随包来源、实际采样、统计和桌面 SVG 保存。

视图契约变更时，运行 `node --test scripts/generate-host-contracts.test.mjs scripts/product-chart.test.mjs`。无关 RPC DTO 的变更应保留视图生成字节，实际接收的 DTO 变更应反映在构建中。视图的 Raw 与派生通道分别用 `pnpm test:ui e2e/browser/plugin-view.spec.ts e2e/browser/chart-view.spec.ts --workers=1` 核对。随包图表 0.1.2 保留 0.1.0 和 0.1.1 的签名前驱，用 `known_predecessor_upgrades_and_preserves_the_profile_decision` 验收启用、停用和卸载后的更新结果。

更新内嵌归档时，从仓库根目录构建同目录的后台和视图，然后按 `sign_builtin_chart <main.js> <32 字节种子文件> <新归档 ZIP> swb.product <版本专用 key ID>` 调用 `cargo run -p serial-workbench-host --example sign_builtin_chart --`。将签名收据的归档摘要和来源审批写入 `crates/host/resources/node-packages/chart.json`，同时记录后台、清单、HTML、CSS、视图脚本的 SHA-256。用 `node --test scripts/product-chart.test.mjs` 核对仓库源码和签名描述。

```sh
pnpm exec esbuild packages/plugin-sdk/examples/reference-chart/builtin.ts --bundle --platform=node --target=node26 --format=esm --charset=utf8 --legal-comments=none --outfile=.cache/builtin-chart/main.js
pnpm exec esbuild packages/plugin-sdk/examples/reference-chart/view.ts --bundle --format=iife --minify --charset=utf8 --legal-comments=none --outfile=.cache/builtin-chart/view.js
```

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

执行 `pnpm plugin-sdk:fixture`。图表后台编译为单个入口，签名归档从该文件读取 `dist/main.mjs`。复用独立的 32 字节 Ed25519 测试种子和已准备的固定 Node。将签名 stdout 保存为收据，并把 `SWB_TEST_SIGNED_CHART_RECEIPT` 设为其绝对路径。`SWB_TEST_CLI_BIN` 和 `SWB_TEST_MCP_BIN` 分别指向同源 CLI 和 MCP 程序。

```sh
cargo run --locked -p serial-workbench-host --example sign_reference_chart -- .cache/plugin-sdk/examples/reference-chart/main.js <测试种子文件> <新ZIP绝对路径> chart-reference local-acceptance
cargo test --locked -p serial-workbench --lib native_chart_samples_exact_rx_from_the_signed_reference_package -- --ignored --test-threads=1 --nocapture
node --test scripts/reference-chart.test.mjs
pnpm test:ui e2e/browser/plugin-view.spec.ts e2e/browser/chart-view.spec.ts
```

在独立 Virtual Echo 会话安装签名包，确认执行信任后启用。核对签名清单的解析器通过 Host 目录可发现，跨 RX 事件拼成的样本携带实际事件游标与原始字节区间。CLI 和实际 stdio MCP 对照桌面桥的分页结果。验证普通身份的会话授权边界及撤销执行信任后的目录撤回。超长输入失败时保留原始输入和此前样本，用受控 SDK 输入验证未完成记录不会跨缺口发布。

桌面桥接用例在生产 Operation 运行中开启图表。首个样本发布前视图保持等待，输入两个完整样本后先读取这两项，再发送最后一段并经同一视图读完。重开后对照留存页，撤销执行信任后复查读页。用例还经真实 MCP 发起离屏 SVG、PNG 和 CSV 导出，核对同一结果引用的字节与桌面保存的文件一致。CSV 列出样本序号、十进制电压及确切会话的事件和字节区间。PNG 为 640 × 360，验证文件签名、分块校验、刻度及与 SVG 对应的采样像素。无头 Chromium 用实际壳和图表脚本验证 iframe 隔离、留存缺口、曲线与样本值。

实际图表窗口可在[手动 CI](../.github/workflows/ci.yml)选择 `native_preflight=true`、目标和 `native_preflight_chart=true`。独立桌面上经插件页安装签名包，开窗后切回工作台发送一组电压。第一个样本获实际隔离 iframe 确认后关闭图表，再发送两个样本。回到插件页分别选择「另存为 SVG…」「另存为 CSV…」和「另存为 PNG…」，核对曲线坐标、CSV 样本与范围、PNG 画面和三个文件的摘要。Windows CI 通过实际系统保存对话框选择目标并记录焦点返回，其他平台由夹具提供目标。重开图表并核对同一任务的三项样本。随后让 runner 停止并重启持有的 Host，核对新进程和代次，以及重开的原生窗口随旧连接关闭。SVG、收据与原始日志保存在 `artifacts/e2e/signed-chart-*`。需验收图表的完整四目标候选设置 `desktop_chart=true`，Windows 桌面作业共用一套构建和固定 Node，并执行签名终端及图表场景。

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

### 命令序列（IO-10）

自动化参考包提供 `swb.reference.automation.sequence`。已授权的调用者传入所选会话、UTF-8 JSON 文档字符串 `definition` 和当前 Raw 游标 `startEventSeq`。用 `stream.cursor` 为同一 Host 会话代次取快照，提交其 `cursor.position + 1`。可用 `pnpm plugin-sdk:fixture` 构建当前参考包，然后按本页的签名参考场景安装和授权。发送目录、鉴权和取消使用普通 Host 动作入口。

```json
{
  "version": 1,
  "variables": { "channel": "01" },
  "steps": [
    {
      "kind": "send",
      "hex": "AA ${channel}",
      "expect": { "hex": "4F 4B", "timeoutMs": 200 }
    },
    {
      "kind": "repeat",
      "count": 2,
      "steps": [
        { "kind": "delay", "milliseconds": 20 },
        { "kind": "send", "hex": "50" }
      ]
    },
    {
      "kind": "if",
      "variable": "channel",
      "equals": "01",
      "then": [{ "kind": "send", "hex": "BB" }]
    }
  ]
}
```

预校验覆盖所有分支、变量、HEX 和最坏执行路径。`onMatch` 是匹配当前应答后执行的可选步骤组。`onTimeout` 是终止前可选的无应答补救组。该组最多执行明确配置的发送和等待，任务保留超时结果，避免后续匹配被旧应答触发。错误应答、源事件断档、配置变化和部分写入结束任务。应答结果保留本轮 TX 操作 ID、定义位置及匹配字节的 Raw 区间。等待和执行后续分支时，前一轮事务租约已释放。

用 `node --test scripts/command-sequence.test.mjs` 核对循环顺序、匹配与超时分支、无写入拒绝、未确认写入和取消。签名后台用例 `native_automation_uses_exact_responses_and_keeps_capture_running` 还直接调用当前序列动作，核对两次匹配应答的源区间、实际 TX 终态，以及超时补救后停止后续步骤。独立对端分别提供匹配、超时、错误及分段应答，将发送日志与每次 TX 回执和源字节范围对照。在工作区菜单打开「命令序列」，载入示例或打开已有 UTF-8 JSON。检查目标会话、展开的发送字节、延时和匹配或超时分支，另存时核对版本与内容。点击运行后核对当前 Raw 游标、独立任务和回执中的接收区间。关闭并重开面板后，可以从原任务继续观察或停止。`pnpm test:ui e2e/browser/command-sequence.spec.ts e2e/browser/repeat-send.spec.ts --workers 1` 覆盖文件、预览、显式启动、最新游标、拒权和实际取消。取消选文件或导入错误保留编辑中的定义。桌面保存等待真实写盘回执，浏览器按钮只发起下载。任务状态查询失败后可重查或请求停止，错误 Raw 作用域在提交前被拒绝。

首方 `swb.builtin.automation` 0.1.1 在同一包登记 `swb.builtin.automation.sequence` 和原有定时发送。`node --test scripts/product-automation.test.mjs scripts/components-build.test.mjs` 核对 0.1.1 归档和组件描述。Windows 的 `native_node_bundled_protocol_registers_on_first_start_and_restart` 验证首启、重启、写权限拒绝、两轮 Virtual Echo 与延时，`node_packages::product::tests` 核对 0.1.0 升级时启用、停用和卸载状态。正式安装继续专项验收。

### 规则触发（AUTO-07）

工具窗先列目标会话，再给规则编辑器。定义错误紧随编辑器，成功验证后在操作按钮前展示条件、效果和时限。载入、保存、武装与停止共用工具窗小尺寸。宽窗按钮并排，窄窗自然换行。接纳、武装、取消与结果放在独立状态区，长操作标识和通知消息在区内换行。显式武装时将初始状态带入可见范围，键盘焦点留在原来的控件。命令效果使用当前 Host 目录的动作类型和目标。在宽窄窗都把未登记、不能从会话执行或应改用专用效果的提示紧贴定义字段。错误沿用主题语义色和现有字号，自然换行并关联键盘焦点。在可用命令点击武装后，沿用下方任务状态区反馈当前授权结果。编辑和保存仍可继续，窄窗按钮依旧按空间换行。

```text
宽窗                                  窄窗
目标会话                              目标会话
[规则定义编辑器]                      [规则定义编辑器]
定义或动作目标反馈                    定义或动作目标反馈
条件、效果和时限                      条件、效果和时限
[载入示例] [保存] [武装] [停止]         [载入示例] [保存]
任务状态与来源                        [武装] [停止]
                                      任务状态与来源
```

在工作台菜单打开「规则触发」，明确选择当前可写会话并检查规则条件、效果和观察时限。载入示例后点击「武装规则」，待收到 Host 武装进度，再由对端分块发送包含 `ALARM` 的 UTF-8 行。首个换行用于同步边界。核对通知内容、原会话代次和准确的接收字节区间。定长字段规则从明确对齐的空闲位置武装，分别用正确校验、错误校验、源断档、配置变化和会话关闭验证派发范围。

用相同条件在两个客户端同时武装，核对唯一的活动监听和重复武装的 `already_armed` 结果。分别验证串口效果的确认写入、取消与租约释放，以及向同会话已授权插件转交写库或命令动作的真实结果。切换或撤销客户端权限后，确认后续动作按最新授权拒绝。正式发行环境另核对插件安装登记和 0.1.3 升级。

分别在权限预检和 Host 接纳回执期间停止。预检中止后没有派发请求，已派发时等待确切的操作标识再申请取消。关闭面板后切到设置，等候通知并重开面板核对来源。再验证任务结果早于接纳回执到达，以及关闭面板时已发起的取消继续结算。

定向软件验证使用 `node --test scripts/rule-condition.test.mjs scripts/rule-trigger.test.mjs scripts/product-automation.test.mjs` 和 `pnpm test:ui e2e/browser/rule-trigger.spec.ts --workers=1`。隔离原生环境沿用随包自动化首次登记与重启专项，真实设备与发行分别收集独立证据。

带固定 Node 布局的生产 Host 使用本章的 `e2e/paired-browser.mjs`。在配对浏览器武装规则后关闭面板，确认放弃未保存的定义。向 Virtual Echo 发送带起始换行的 `RULE:BENCH` 行，重开面板查看同一任务和命令序列回执。用 CLI 核对两个操作的共同根、会话代次、规则命中的 11 字节来源，以及序列一次写出并匹配的 `RULE:ACK`。将 `workspace.save` 设为规则效果，核对 420 像素宽窗提示目标不支持，武装按钮不可用，WebSocket 没有发送该规则，工作区内容和修订保持一致。浏览器夹具还验证未登记和保留动作的提示、精确会话参数的 Host 预检、拒权后保留草稿，以及修正定义时清除旧反馈。`receipt.json` 的 `ruleCommand` 保留配对证据。单独的写库插件、实机对端和发行安装仍按本项验收。

### 日历定时任务（AUTO-08）

按工具窗内容宽度分列。定点模式保留时间和字节输入，cron 模式宽窗两列排日期条件，窄窗依序纵排。UTC 预览与有效性提示置于操作之前。观察区使用统一反馈和等宽数字，长收据按文字边界换行，在有界列表中可用键盘滚动。显式武装时将初始状态带入可见范围，后续状态更新保持当前滚动位置。

```text
日历宽窗                               日历窄窗
目标会话 [定点][cron]                  目标会话 [定点][cron]
[表达式]        [时区]                [表达式]
[结束时间]      [次数]                [时区]
[发送字节 / 载入]                     [结束时间]
UTC 预览 [武装] [停止]                 [次数] [发送字节 / 载入]
任务状态 [逐轮收据]                    UTC 预览 [武装] [停止]
                                       任务状态 [逐轮收据]
```

首方自动化 0.1.5 和参考自动化 0.1.10 分别登记 `swb.builtin.automation.calendar` 与 `swb.reference.automation.calendar`。在工作台菜单打开「日历定时任务」，选择指定时刻或 cron，填写发送字节或导入当前发送草稿。核对目标会话和 UTC 预览，在明确武装后检查独立任务。Host 接纳后先等待武装进度。关闭并重新打开面板，按原操作 ID 等待停止终态或查看回执。同会话有另一活动计划时，继续核对原操作。未提交的表单由未保存工作确认保护。一次执行提供 `schedule: { kind: "once", at }`，`at` 带明确的 UTC 偏移。循环执行提供 `schedule: { kind: "cron", expression, timeZone }` 和带偏移的 `endAt`。cron 按分钟、小时、日、月、星期填写，支持列表、区间、步进和英文月、星期缩写。指定日期和星期范围时任一匹配即可，两者之一覆盖全部范围时按另一字段。时区采用 IANA 名称。还须传当前会话修订 `sessionRevision` 和 `bytesBase64`，循环可设置 1–32 次尝试，默认 1 次。Host 已确认零写入的超窗尝试计入次数并留存操作 ID。单次武装的结束时间最多距 Host 当前时间 366 天。

运行 `node --test scripts/calendar-*.test.mjs` 核对夏令时跨越、已过期定点、休眠后跳过错过的时隙、回拨、派发前再次复核、取消、用完和归还配额，以及真实回执结构下的逐次结算。检查每轮操作 ID、计划与观察时间、跳过的区间和写入确认。运行 `cargo test --locked -p serial-workbench-host --lib tx_calendar_window_is_checked_at_device_dispatch_after_host_waiting`，用可控 Host 时钟核对有效窗口、已过期的请求，以及正常接纳后停在设备派发前直至过期的请求。用 `pnpm test:ui e2e/browser/calendar-schedule.spec.ts --workers=1` 验证入口、无效日期、权威会话修订变更和关闭面板后的停止。隔离真实 Host 的 `native_node_bundled_protocol_registers_on_first_start_and_restart` 核对签名登记、定点写入和实际子回执。另武装一个未来计划后正常关停，重启后复用原授权身份。经过原时隙及迟到窗口，复核原操作的真实非成功终态、修订和零子操作保持一致。独立设备对端与正式安装环境另行收集证据。

异常退出专项使用独立临时 profile。将 `SWB_TEST_CALENDAR_HOST_BIN` 设为已准备固定 Node 布局中的 Host 程序绝对路径，将 `SWB_TEST_CALENDAR_CRASH_OUTPUT` 设为新证据目录的绝对路径。运行 `cargo test --locked -p serial-workbench-host --test startup_main calendar_process_recovery::signed_calendar_does_not_replay_after_host_process_loss -- --ignored --exact --test-threads=1`。测试在计划武装后、原时隙前终止自己启动的 Host。重启后核对 Host 与操作者身份、递增的 Host 与会话代次，以及已派发父任务的 `unknown` 终态。跨过原时隙和迟到窗口后，核对修订稳定、零子操作及零原始收发。显式武装新计划应产生一次 Virtual Echo 收发。`receipt.json` 记录程序和签名归档摘要、代次和两项操作。

改参数和撤权专项使用相同环境变量与另一个证据目录。运行 `cargo test --locked -p serial-workbench-host --test startup_main calendar_process_recovery::signed_calendar_checks_reconfiguration_and_revocation_before_writing -- --ignored --exact --test-threads=1`。先在任务已武装后将 Virtual Echo 从 9600 改为 19200，核对配置回读和新修订。原计划应留下 `transmit_unconfirmed` 结果，指向以 `REVISION_CONFLICT` 拒绝的子写入，已接纳与未知范围均为空。再武装一个新计划并撤销发起者的 `device.modify`。计划应在到期前以 `PERMISSION_DENIED` 中止，无子写入。跨过两个原时隙及迟到窗口后对照 Raw，确认零实际写入、零回显。恢复权限后显式武装新计划，核对精确收发字节以及两个旧终态保持稳定。

### 手工发送录制（AUTO-04）

沿用接收区确认窗和发送区录制弹层。宽窗按目标、HEX、确认与回执顺序。窄窗同一列换行，保持原有共用按钮高度。取消或关闭预览保留接收区焦点，仅确认发送可加入录制。录制计数继续显示已确认的动作，另在命令序列查看发送顺序。

```text
宽窗                            窄窗
目标 · 字节数 · 来源            目标 · 字节数
[原始 HEX 预览]                 来源
[确认发送] [实际回执]           [原始 HEX 预览]
                                [确认发送]
                                实际回执
```

打开可写会话，在发送区选择「录制手工发送」，明确开始后手工发送一段普通字节。从接收区选取连续 HEX 字节，先预览并取消，再打开预览并明确确认。停止录制并检查完整回执计数，在命令序列中预览相同的 HEX、写入期限和有证据的等待。单次写入期限超出 5 秒时，录制保留已确认前缀。等待用工作台观察到完整写入后到下次手工提交的单调时钟，线级时序继续用实际线路采样核对。预览、另存和运行分别触发。生成到编辑器前后的未保存内容受同一离开流程保护。独立对端验收记录原始 TX 和发送顺序。

用 `pnpm test src/features/workbench/manual-send-recording.test.ts src/features/workbench/send-history.test.tsx` 核对完整回执、顺序、缺失证据、写入交错及等待上限。用 `pnpm test:ui e2e/browser/command-sequence.spec.ts e2e/browser/receive-context.spec.ts --workers 1` 核对录制稿、选区取消、精确修订和显式运行。真实配对浏览器沿用本章的 `e2e/paired-browser.mjs`。先用 CLI 核对取消选区预览后仅有原手工 TX，再确认发送两字节并立即关闭预览，观察录制仍保留两项真实回执。复核草稿的发送顺序、写入期限和选区 HEX，显式运行后用独立 Raw 读数核对新增两次 TX。`receipt.json` 的 `manualRecording` 保存证据。用 `node --test scripts/command-sequence.test.mjs` 核对执行器使用指定写入期限，旧定义沿用默认期限。首方自动化 0.1.2 保留 0.1.0、0.1.1 作为可验证前驱。其他手工动作、系统密钥解析和长文件动作继续按同项验收。

#### 录制字节的输入引用

在原录制弹层用共享复选框选择「将发送字节保存为输入引用」。默认保留原录制方式。引用模式按确认顺序给每段发送分配名称。命令序列工具内沿用已有的定义和预览分栏，临时 HEX 字段置于预览栏。窄窗先显示定义和文件操作，再显示临时输入与预览。输入用共享高度、等宽字体和掩码，长名称可换行。未填或无效时可导出定义，运行保持不可用。

```text
宽窗                                  窄窗
[JSON 定义]   [运行所需输入]           [JSON 定义]
[另存 JSON]   [recorded_send_1]       [另存 JSON]
              [发送引用、等待]         [运行所需输入]
[运行]         任务状态                [recorded_send_1]
                                      [发送引用、等待] [运行]
```

从原录制切到引用模式，发送两段测试字节后生成草稿。核对 JSON 只含名称、占位符、顺序及时限。保存并重新打开，确认临时值为空。输入不完整的 HEX 时不接纳 Host 操作。输入替换字节后，预览显示引用，显式运行使用本次值。再次另存和重开均只含引用。退出面板或替换定义会清除临时输入。用独立 Raw 读端对照原发送与替换后的实际 TX。引用使用版本 1 的 `variables`，值为 `null`，须用于顶层发送步骤的完整 HEX 模板，原有字面变量继续适用。工作台在运行前绑定为普通版本 1 JSON。`manual-reference-sequence.json` 与收据 `manualRecording` 可从配对专项取用。

每项引用可在掩码输入旁选择二进制文件。宽栏保持输入和「选择文件」并排，窄栏在同一引用下排列，状态紧随对应输入。选择后显示绑定的字节数。取消、空文件、超过 256 字节及读取失败保留该输入原有值。关闭工具或更换定义后忽略未完成的文件读取。

```text
宽栏                              窄栏
recorded_send_2                   recorded_send_2
[掩码 HEX] [选择文件]             [掩码 HEX]
已绑定 4 字节                     [选择文件]
                                  已绑定 4 字节
```

重新打开带引用的 JSON 后，用文件选择器为其中一项绑定含 00 和 FF 的短文件。复验取消、257 字节越界、重新导出、输入清空以及显式运行后的独立 Raw TX。序列不包含本地文件路径，打开时由用户重新选择。`receipt.json` 中的 `manualRecording.selectedFileHex` 记录独立 TX 已核对的四字节样本。无头回归持住已选文件的读取，关窗后重新导入同一引用，再释放旧读，核对新窗口仍缺输入且没有 Host 接纳。桌面原生文件选择器沿用隔离环境的原生窗口验收。

为含输入引用的发送步骤配置三个重试帧，其中一个由普通变量展开为 `00`。打开草稿能预览全部重试，输入绑定为 `00` 后定位到冲突的重试帧并禁用运行。改用不同的输入后，显式运行只提交一次，Host 入参包含实际绑定值。配对验收先通过独立 Raw 端确认冲突期间没有新增 TX，再由 Virtual Echo 返回预期应答，核对实际文件字节及匹配后没有多发重试帧。

### 测试用例与断言（AUTO-05）

从工作区打开「命令序列」。配置 `{"kind":"send","hex":"53","expect":{"hex":"A4","timeoutMs":100,"retry":[{"hex":"54","expectHex":"A5"}]}}` 作为一个步骤。对端收到 53 时保持静默，收到 54 时回 A5。预览应显示备用请求和期望应答。显式运行后，从回执展开核对首轮超时、第二轮匹配、两个不同操作 ID 以及第二轮的 RX 区间。确认设备支持同一业务动作的重试，并提供可在应答中区分每次尝试的相关字节。

用 `node --test scripts/command-sequence.test.mjs` 核对迟到旧应答、部分写入、缺失 TX 证据、重试之间的外部写入、预算和最终超时分支。用 `pnpm test:ui e2e/browser/command-sequence.spec.ts --workers 1` 核对预览、重叠应答拒绝、显式运行和逐次结果。固定 Node 原生用例 `native_node_bundled_protocol_registers_on_first_start_and_restart` 对照签名包的完整写入与进程内独立对端响应。实际串口对端和正式离线发行继续专项验收。

### 测试套件与报告（AUTO-06）

在可写会话的工作区菜单打开「测试套件」。载入示例，或打开 `{"version":1,"name":"Bench","cases":[{"name":"Echo","sequence":{"version":1,"steps":[{"kind":"send","hex":"53","expect":{"hex":"53"}}]}}]}`。也可给某项设置 `"skip":true`。用独立对端分别给出正确应答、错误应答和迟到应答，核对用例按顺序接纳、失败或无法确认后跳过其余项。停止时核对请求阶段与 Host 取消终态分别显示，报告保留原任务 ID。导出 JUnit XML 和 HTML，核对内容与面板一致。JUnit 用 skipped 元素承载取消记录并另列取消计数，HTML 显示各自状态和最近实际趋势。同一窗口重新打开面板时核对报告仍属于原会话与原定义。逐次核对新游标和 Host 配置修订。仅写入且没有应答断言时，保留当前真实结果并阻止后续用例。存在未归属应答时要求确认对端已结束上一轮并重新打开会话。

运行 `pnpm test src/features/workbench/test-suite.test.ts` 核对报告可解析、显示转义、取消和不确定结果。用 `pnpm test:ui e2e/browser/test-suite.spec.ts --workers 1` 核对工作台接线、二次运行趋势和实际保存请求。桌面原生选择器与真实串口对端继续结合正式候选验收。

### 参数化与数据驱动（AUTO-09）

在「测试套件」载入「载入数据驱动示例」，再从「CSV 输入」替换用例的 CSV。首行使用唯一的列名。用 `"data":{"csv":"Byte\\n83\\n84\\n","bindings":{"payload":{"column":"Byte","type":"u8"}}}` 为 `${payload}` 提供两轮输入。也可用 `"table":{"columns":["Byte"],"rows":[[83],[84]]}` 替换 `csv` 字段。绑定类型支持十六进制字节 `hex`、十进制字节 `u8`、编码成十六进制的 UTF-8 字节 `utf8` 和字面文本 `text`。每轮按序列中的模板位置验证转换结果。

核对一份带表头、跨行引号字段的 UTF-8 CSV。结果应显示每条记录开始的物理行号，变量表从第 1 个数据行计数。让第一轮匹配、第二轮超时、第三轮跳过，核对面板、JUnit XML 和 HTML 的来源位置，以及前两轮的 Host 操作 ID。在最后一行设置越界字节，核对导入拒绝并保留原草稿。编辑定义时也应禁止运行无效套件。运行 `pnpm exec vitest run src/features/workbench/test-suite.test.ts` 和 `pnpm test:ui e2e/browser/test-suite.spec.ts --workers 1` 复验。真实串口对端按同一顺序核对实际字节、应答与报告，正式发行使用同一候选验收。

### 定时与循环发送（IO-09）

签名自动化参考包 0.1.6 提供 `swb.reference.automation.repeat`。在独立任务中对确切会话代次提交 `sendBase64`、`periodMs` 和 `count`，可设置首次延时、抖动、RX 启动或终止条件，以及本轮期望应答。周期为 10 至 60,000 ms，每次最多 64 轮。抖动须小于半周期，以保证计划时隙的顺序。开始条件从延时后的当前源尾部起算。持有租约期间核对本轮写入和应答，轮间等待释放租约。观察到终止条件后停止接纳下一轮，已经提交的写入仍按实际结果结算。跨留存缺口或配置换代停止。每轮记录预计时隙、提交子动作前的任务时钟及操作 ID，实际写入时间和范围从该 ID 对照 Host 回执。

用 `node --test scripts/reference-repeat-send.test.mjs scripts/reference-automation.test.mjs` 核对单调调度、错过时隙、拆段触发、旧数据隔离、应答与取消。上面的签名后台用例还以 Virtual Echo 检查三次确切完整 TX、每轮应答及终止条件停止后续写入。在工作台菜单打开「定时发送」，核对当前端口、会话代次和每轮预览。用 `pnpm test:ui e2e/browser/repeat-send.spec.ts --workers 1` 核对使用现有发送草稿、独立任务、禁止按回车误发、权限拒绝、重开后继续停止及真实终态。默认 Host 嵌入 `swb.builtin.automation`，工作台优先选择 `swb.builtin.automation.repeat`。独立安装的自动化参考包仍能提供同一调度契约。`node --test scripts/product-automation.test.mjs scripts/components-build.test.mjs` 核对首方编译、归档摘要和发行描述。随包签名更新使用 `sign_builtin_automation`，参数顺序与 `sign_builtin_chart` 相同。原生首次启动与重启测试 `native_node_bundled_protocol_registers_on_first_start_and_restart` 核对首方动作登记、拒权和 Virtual Echo 应答。实际串口验收用独立对端记录完整字节和各轮接收时刻。分别检查固定周期、抖动范围、错过时隙后的发送间隔，以及拆分起止标记、逐轮应答和取消后停止。把对端原始记录与 Host TX 回执关联。正式发行安装用同一发行候选核对离线首次启动和重启的动作登记，再运行上述收发场景。

### 已打开视图的语言切换（UX-13）

用签名终端与签名图表的配对浏览器场景，在同一个已打开视图中中英文往返。核对 `lang`、图表标题或终端的无障碍名称、原输入仍在、iframe 地址保持，以及同一读端口确认切换后写入的新数据。收据的 `localeChanges` 记录视图实际使用的语言。使用已签发的 0.1.2 包复跑时设置 `SWB_TEST_BROWSER_LEGACY_VIEW=1`，同时核对应用已切换、旧视图继续使用打开时的语言与原读流。隔离桌面终端场景检查主窗口保存语言后，已打开的 Wry 壳应用新语言，并在同一视图确认后续字节。子窗口加载期间的语言切换仍需另外覆盖。

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

### 只读回放控制

用 `cargo test --locked -p serial-workbench-host --test replay_readonly --test capture_integrity` 复验 LOG-08。用可控时钟核对播放中切换倍率、暂停期间调整及跳转后的精确到期点。打开同一录制的两个 reader，检查断点只影响对应游标。核对单步保持暂停、未跨过下一条记录、大记录可按引用读回原始 JSON 和摘要，以及预算不足时游标保留。控制终态沿用原回执格式，单独查询状态不会推进游标。

用 `pnpm exec vitest run src/features/workbench/replay-panel.test.tsx` 和 `pnpm test:ui e2e/browser/replay-layout.spec.ts --workers=1` 复验界面。通过工作台的录制入口打开只读回放，检查原时序、最快、暂停和跳转。调整倍率，设置记录断点，读取至断点，再单步读取保留原始来源的下一条记录。恢复、清除断点和读取失败均检查当前 reader 的展示和精确会话代次。

### 独立录制格式

```sh
cargo run --locked -p serial-workbench-host --example capture_fixture -- --output <新fixture绝对目录>
node scripts/test-capture-container-independent.mjs --fixture <该目录> --result <新的外部结果绝对路径>
```

Node reader 不依赖 Rust parser/SDK/IPC，扫描全部卷核对字节、索引、水位、摘要和 partial/unknown。两个输出位置尚不存在，结果文件在 fixture 外。格式见 [Capture](./contracts/capture-container-v0.md)。

录制的结构化文本导出复用 `capture.export`。运行 `cargo test --locked -p serial-workbench-host --lib capture::text_export` 和 `cargo test --locked -p serial-workbench-host --test capture_api_host`，核对源字节定位、跨记录编码、CSV 往返、冲突与源变更时的原件。桌面为 CSV 和 JSONL 分别选择文件，恢复目标单独登记。参数与操作可用性通过 `pnpm exec vitest run src/features/workbench/capture-tools.test.tsx` 复验。格式见[录制容器契约](./contracts/capture-container-v0.md)。

## M3 契约冻结

以至少两个仅使用公开 SDK 的参考插件验证终端、协议事务、长脚本、网络和独占工具交接、合成 UART 波形及图表离屏导出。核对 schema 与类型、获准入口的结果、revision/epoch、撤权、取消、unknown、写盘恢复及未来格式。完成不兼容版本拒绝、实际 MCP 产品客户端、正式 Node 离线包、后台整套升级和故障回收后冻结 v1。

DIAG-08 的 M3 金样由 [签名 Host 用例](../crates/host/tests/client_parity/uart_gold.rs) 生成双通道 8N1 电平，再通过 [公开 SDK 示例](../packages/plugin-sdk/examples/uart-gold.ts) 读取字节、原始采样区间和相对纳秒偏移。用例核对两路共用的采样时钟、超过 JavaScript 安全整数的采样序号，以及获准客户端通过文件引用读回的实际结果。先按[签名运行时](#签名运行时与-sdk)准备 `SWB_NODE_RUNTIME_TEST_ROOT` 并运行 `pnpm plugin-sdk:fixture`，再按需选择 `cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_uart_gold_ -- --ignored --nocapture`。四目标 CI 的原生 runtime 检查包含该用例。VCD 和带采样率的 CSV 导入、校验位与 BREAK 在 M5 验收。

v1 候选在本机 IPC、HTTP、配对 WebSocket 和 LAN TCP 给 0.1 客户端返回 `PROTOCOL_UNSUPPORTED`。核对 `supportedProtocolVersions` 为 `["1.0"]`、`upgradeTarget` 为 `"1.0"`，并确认同一 Host 可随后接受 1.0 客户端。原签名扩展清单按 `hostProtocolVersion: "0.1"` 复验。

Windows 的 `windows-nsis-wire-v1` 运行时预检从已合入的 `ffff1fe` 构建旧套件，从当前候选构建新套件。测试密钥签名后执行实际桌面升级。两次 WebView 附着分别核对协议 0.1 与 1.0，以及相同 Host 身份、递增代次、原 profile 和卸载注册。收据记录两份源码提交、实际协商协议，以及旧 CLI 连接新 Host 时取得的版本拒绝和升级目标。正式发行签名按 T14 验收。

### 签名插件传输

按[签名运行时](#签名运行时与-sdk)准备固定 Node 及 `SWB_NODE_RUNTIME_TEST_ROOT`，然后用同轮源码构建 SDK 示例并运行实证。

```sh
pnpm plugin-sdk:fixture
cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_transport_ -- --ignored --test-threads=1 --nocapture
```

用例安装实际签名参考包，通过标准 Host IPC 对批准的插件设备执行打开、写入和关闭。独立本机 TCP 对端核对实际二进制字节，Raw 核对 Host 实例、会话代次和来源。未经授权的打开不能到达对端，撤销用户读取授权终止其 Raw 交付。显式关闭、重新打开的新会话代次和停用后的实际对端断开分别核对。故障用例单独签名测试包装，实际写入后在返回线路回执前退出所属 Node 进程。TCP 对端核对已到达的字节和关闭，Host 核对派发区间仍为 `unknown`、卸下设备目录条目并拒绝过期操作。四目标 CI 的原生运行时检查运行主动连接、侦听与进程退出三种用例。桌面参数输入、跨机适配和发行候选证据沿用各阶段的专项。

桌面参数入口运行 `pnpm test:ui e2e/browser/plugin-transport.spec.ts`，检查显式提交、失败保留输入和成功清理草稿登记。Host 参数校验和实际 TCP 对端继续通过签名传输用例检查。

TCP 参考包兼容原有的端口参数。添加 `role` 选择 `client` 或 `server`，可用 `host` 指定目标地址或要侦听的本机 IP。默认 `127.0.0.1`。侦听用例先核对未授权的请求未占用端口、无对端写入的回执无接纳或未知区间，再由独立对端核对双向二进制字节、Raw 会话代次、重开和停用。运行 `node --test scripts/reference-transport.test.mjs` 复验端口占用、取消打开和读取、不会接纳第二位对端以及先交付半关闭前已收到的字节。

首方 `swb.builtin.tcp` 0.1.0 与参考包共用 TCP 实现，归档摘要进入 Host 组件清单。隔离启动核对首次自动登记与同一 profile 重启。通过设备目录打开两种角色后，以独立 TCP 对端核对零字节、FF 和其他二进制字节及关闭。工作台 TCP 表单另以无头 Chromium 核对中英、明暗、宽窄、键盘、无效配置不提交、Host 拒绝保留草稿及唯一错误提示。

```sh
cargo test --locked -p serial-workbench-host --lib native_node_bundled_ -- --ignored --test-threads=1 --nocapture
node --test scripts/reference-transport.test.mjs scripts/components-build.test.mjs
pnpm test:ui e2e/browser/plugin-transport.spec.ts --workers 1
```

重建包时以 esbuild 针对 Node 26 打包 `reference-transport/builtin.ts`，使用 `sign_builtin_tcp <编译入口> <32 字节版本种子文件> <新归档> swb.product <版本专用 key ID>`。收到验签结果后登记归档、入口、清单摘要与来源公钥。正式发行与跨设备收发继续按 T11 和 T14 验收。

### 有序会话钩子

按[签名运行时](#签名运行时与-sdk)准备资源后，运行 `cargo test --locked -p serial-workbench-host --lib native_node_task_session_hooks_ -- --ignored --nocapture`。签名任务通过 Virtual Echo 核对原代次的打开、实际 RX、最终 TX 回执与关闭，并在回调失败时验证 reader 名额释放。运行 `cargo test --locked -p serial-workbench-host --test session_lifecycle --test stream_budget` 覆盖底层故障、未结算 TX、撤权重授与旧代次的收尾。 `node --test scripts/node-backend-cancellation.test.mjs` 复验迟到页、租约释放及缺口续读。

### 命令库变量与行尾（IO-05、IO-07）

在工作区命令库打开已保存的命令。`${name}` 代入指定值，`$${name}` 保留字面量。变量名区分大小写，以 ASCII 字母或下划线开头，后续可包含 ASCII 字母、数字、下划线、点和连字符。重复变量使用同一个值，替换值中的占位符保持原样。确认有显式空值选项，未赋值和超出草稿字节上限时无法载入草稿。

载入命令后核对发送格式、编码、覆盖行尾及恢复发送行尾的操作。由未绑定草稿连接设备时，确认正文和命令参数一起转入该会话。核对正文先按发送格式编码，接着追加行尾，最后追加校验。按校验设置分别核对计算范围是否包括行尾。对照最终预览与实际 TX，验证载入草稿时 TX 计数保持原值，替换后含非法 HEX 时发送不可用。软件回归使用 `pnpm test:ui e2e/browser/command-library.spec.ts`。实体串口与发行候选按各自阶段验收。

### 发送与命令库的编辑撤销（UX-12）

发送区沿用多行编辑器的撤销与重做。在命令库打开一个命令或分组后，名称、备注、正文、发送格式、编码和行尾按编辑顺序进入当前草稿的撤销栈。保留原始输入，撤销、重做不完整的自定义 HEX 行尾时同时恢复校验文本和保存可用性。连续输入按同字段的短时编辑合并，切换控件、粘贴和修改选项保留独立步骤。

```text
宽窗                                窄窗
名称 [Modem reset       ]            名称 [Modem reset]
备注 [恢复模组默认设置  ]            备注 [恢复模组默认设置]
正文 [ATZ               ]            正文 [ATZ       ]
格式 [文本]  编码 [UTF-8]  行尾 [LF]  格式、编码、行尾
[撤销编辑] [重做编辑]      [取消][保存] [撤销编辑] [重做编辑]
                                    [取消][保存]
```

复用两个同高的次操作按钮，宽窗在操作栏左侧，窄窗随空间换行。键盘可在当前表单用 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z，Windows 和 Linux 也可用 Ctrl+Y。保持焦点，动态宣告编辑结果。撤销到初始值后，关闭无需再确认丢弃。撤销后新编辑清空重做分支。切换编辑对象、取消或收到保存终态时结束该草稿的历史。保存失败保留草稿及历史。撤销和重做本身不提交命令库变更或串口写入。

无头验证命令字段跨控件撤销、键盘和按钮、窄窗换行、无保存副作用、新编辑截断重做、无效输入复原、保存结算及不同编辑对象隔离。发送编辑器回归同时核对正文、缩进、注释、选区和发送的字节。

### 命令库归档（IO-07）

从桌面命令库导出 `.swb-commands.jsonl`，再导入另一个工作区，核对分组、顺序、正文、备注、编码和行尾。目标已有相同 ID 时，确认原命令仍能读取，导入副本位于自己的分组。取消文件选择后复查命令库 revision。用截断文件、已存在的导出路径和过期 revision 核对失败。用满盘夹具复查导入事务回滚，原有记录和 revision 仍可读取。

运行 `cargo test --locked -p serial-workbench-host --test shared_documents_host command_archives` 核对真实 IPC 和落盘。存储用例 `cargo test --locked -p serial-workbench-host --lib command_archive` 对照跨页顺序和失败回滚。`pnpm test:ui e2e/browser/command-library.spec.ts` 使用无头浏览器核对选择、取消和终态刷新。Windows 原生桌面门禁使用同一应用窗口的打开与保存对话框，核对导入后列表、导出归档的正文、备注、编码和行尾。保存路径的写入授权可读取导出终态，读取归档正文仍需独立文件授权。该作业保留 `command-archive-roundtrip.json`，记录对话框归属、焦点归还、归档 revision、文件字节数和摘要。

### 通用分帧（PROTO-01）

通用分帧通过 `swb.reference.framing.scan` 动作读取获准会话代次的 Raw RX。`startEventSeq` 和 `endEventSeq` 选定左闭右开的已留存事件区间。返回的帧包含原始字节、起止事件及字节范围。`incompleteBytes` 统计范围内未组成完整帧的字节，包括噪声、超长候选和未闭合帧。

签名分帧包启用后，选择实际串口会话，从「工作区菜单」打开「协议分帧」。用「使用已接收范围」填入当前可见接收数据的区间，或手动填写事件序号。扫描提交时复核动作授权。成功后核对十六进制帧、事件和字节位置，结果有续页时可请求下一页。关闭面板停止等待，已接纳的操作由 Host 结算。手动安装与启用测试签名包用现有插件管理流程，正式随包分发按发行环境验收。

安装并发回归用固定 Node 触发已有包恢复，定点暂停恢复名额的归还。对另一签名包发起安装后，核对操作保持排队且尚未执行。解除恢复屏障后，核对原安装操作成功结算，新包仍待启用。用例为 `native_node_install_waits_for_other_package_recovery`，与正式 Host 首启后安装参考终端的 CI 场景互补。

正式 Host 的参考终端验收还检查共享 Node 的卸载保护。停用终端并撤销其来源后，分帧仍活动时卸载返回 `HOST_BUSY`，安装快照及分帧登记保持一致。通过本机管理入口停用分帧后，按新的安装 revision 卸载终端，再恢复原分帧包。验收核对同一归档和来源、重新登记及最终安装快照。

每次扫描最多处理 1024 个事件和 65,536 个 RX 字节，最多返回 128 帧。还有可返回的帧时，结果包含 `nextCursor`。下一次调用沿用原来的 `endEventSeq` 和分帧配置，把游标的 `eventSeq`、`byteStart` 分别传给 `startEventSeq`、`startByte`。未完成字节计数覆盖本次处理的区间，到下一帧起点为止。即使相邻帧在同一个 Raw 事件中，后续调用仍可从准确字节继续。

- 用 `fixedLength`、`delimiterBase64` 或 `lengthField` 选择主边界。长度字段按给出的偏移、位宽和端序读无符号整数，再加 `adjustment` 得到整帧原始字节数。
- 可添加 `headerBase64` 和 `footerBase64` 核对帧头帧尾。仅用帧尾时，它也是结束标记。指定独立分隔符时，帧尾紧邻分隔符之前。`escapeByte` 保护紧随其后的一个字节，输出保留原始转义。
- `idleTimeoutMs` 可独立分帧，也可结束其他模式的连续段。仅按静默分帧时，由同源接收时钟的下一次收块确认边界。换钟、来源精度变化、回退、缺口和未观测到后续收块的末段保留为未完成数据。

先按[签名运行时与 SDK](#签名运行时与-sdk)准备固定 Node 和 `SWB_NODE_RUNTIME_TEST_ROOT`，然后运行分帧的软件与原生验收。

```sh
node --test scripts/reference-framing.test.mjs
pnpm plugin-sdk:fixture
cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_reference_framing_ -- --ignored --nocapture
```

软件测试核对跨页字节、超长帧恢复、转义、缺口与同源静默。原生测试用本轮测试签名的清单安装并启用插件，以 Virtual Echo 返回一段包含无效长度的输入。通过真实 Host IPC 调用解析器，核对两帧的正文及来源和三字节未完成计数。独立设备上的线路静默和正式发行包按各自条件验收。

首方归档使用 `node --test scripts/product-framing.test.mjs` 对照 TypeScript 编译结果、清单和完整 ZIP 摘要。运行 `cargo test --locked -p serial-workbench-host --lib node_packages::product::tests` 核对签名、原子安装后的内容证明和外部安装入口的来源隔离。发行描述的 `bundledNodePackages` 记录包版本、归档摘要及承载它的 Host 组件。

在同一固定运行时环境执行 `cargo test --locked -p serial-workbench-host --lib native_node_bundled_protocol_ -- --ignored --nocapture`。用独立 profile 验证首次自动登记、真实 Node 解析器发布、重启后 Host 换代及安装 revision 保持。产品单测另验取消后重试、同 ID 本地包保持原信任，以及停用和卸载后继续尊重用户选择。断网安装、打开真实桌面和线路样本按发行与实机专项覆盖。

### 会话对比（PROTO-11）

运行 `pnpm exec vitest run src/features/workbench/session-comparison-model.test.ts`。使用相同帧长读取两段只读录制，以原始事件和字节界限核对数据。位置模式保留已知缺失帧的序号，前缀和多字段模式分别用插入帧、重复键、无法解码的键及乱序设备地址核对配对。字节差检查零基半开区间，字段差检查同字段的原值和解码值。右侧相对耗时减左侧相对耗时，跨时钟、采集缺口或非单调时间返回未知。夹具校对高位纳秒、跨接收块来源及两侧边界。打开两份只读回放，各读取需要对照的页，在字段图表输入已知帧起点和帧长。把第一份用作基准、第二份用作对照，再从回放工具栏打开「会话对比」。切换对齐键后重新计算，展开结果行核对原始 HEX、事件和录制序号，以及右侧相对时间减左侧相对时间。运行 `pnpm test:ui e2e/browser/replay-layout.spec.ts --grep "two recordings compare" --workers=1`，模拟 Host 对照两份样本并验证访问撤销后收回原始内容。通过当前有内容读取权限的会话调用字段包动作 `swb.reference.fields.compareSessions`。每侧传入有序的 `position` 和 `bytesBase64`，可提供精确纳秒和连续片段编号。首次读取核对全窗摘要，使用零基 `detail.rowIndex` 选择明细，分别用 `byteOffset` 和 `fieldOffset` 分页。运行 `node --test scripts/protocol-field-actions.test.mjs scripts/product-protocol-fields.test.mjs` 核对契约、签名包一致性及分页金样。原生固定 Node 用例 `native_node_bundled_protocol_registers_on_first_start_and_restart` 核对未授权拒绝、授权后读回原始差异与精确时差。对 0.1.0 和 0.2.0 分别核对启用、停用、卸载和重复启动后身份保持。

### 帧字段定义与报文构造（PROTO-02、PROTO-05、PROTO-07、PROTO-19）

在分帧结果选择一帧，然后选择 JSON 或 YAML，填写版本为字符串 `"1"` 的定义。`byteLength` 是整帧字节数。每个字段用 `id`、`kind`、`byteOffset` 和宽度或校验算法描述。字节偏移位于帧内，结果显示折算后的半开原始字节范围和实际 HEX。十进制比例 `scale` 与偏移 `bias` 使用字符串，枚举 `labels` 以原始整数为键，可选 `unit`。整数和位域使用指定端序与符号位。校验字段以 `coverageStart` 和 `coverageEnd` 选定计算区间。

在桌面工作台用「打开定义文件」选择 UTF-8 的 `.json`、`.yaml` 或 `.yml`，核对文件名、自动选择的格式和定义错误的行列。取消选择、文件超限或内容摘要不符时，先前草稿应保留。读取延迟期间继续编辑，再核对晚到的文件结果保留最新草稿。

选择「编辑字段值」后输入整数或浮点值，再点「预览报文」。未连接串口时可从全零字节开始。以捕获帧为底稿时保留定义之外的字节与位。预览核对整数宽度及浮点端序、HEX 字节、解码回读和从 0 开始的生成范围。输入溢出时定位字段，修改格式、定义或字段值后检查旧结果立即失效。将同一定义改用 YAML，核对解析、构造及不支持版本的路径和行列。

随包签名字段包提供 `swb.reference.fields.decode` 和 `swb.reference.fields.encode`。两者接收 `definition` 文本，`definitionFormat` 可指定为 `yaml`，缺省为 `json`。解码接收 `bytesBase64`，构造接收字符串映射 `values`，可用 `baseBytesBase64` 保留未定义位。对定义错误核对返回的 `path` 和 `position`，对字节或工程值错误核对 `path`。两个动作均沿用目标会话的读取授权。

运行 `node --test scripts/protocol-fields.test.mjs scripts/protocol-field-actions.test.mjs scripts/product-protocol-fields.test.mjs` 核对位宽、浮点、严格 UTF-8、独立物理位、64 位精确往返、校验依赖、定义错误、取消及归档来源。使用 `pnpm test:ui e2e/browser/framing-tool.spec.ts` 核对分帧结果上的字段值、原始字节绝对偏移、数值构造及 YAML 行列。用同一原生启动用例对照两个独立包的重启登记、会话授权、真实操作终态和文件结果。

### CRC 识别与验证（PROTO-03）

在工作台的「协议分帧」内展开「CRC 识别」。分别填写参与计算的 HEX 字节和从实物或样本读取的校验字节。可限定目录中的位宽或校验字节序，也可自动寻找同字节长度的候选。非整字节位宽右对齐填写。输入 `31 32 33 34 35 36 37 38 39` 与 `37 4B`，选择 16 位，核对列出低位字节在前的 CRC-16/MODBUS，并仍提示补充样本。重复该输入时不同样本计数保持为 1，给相同报文输入不同校验值时显示冲突。

添加 `01 03 00 00 00 0A` 与 `C5 CD`，核对同一目录候选与两条报文相符，多项式、初始值、输入与输出反射、末异或可读。切换为大端后核对没有匹配。另用 `00` 与 `00` 在 8 位目录核对多个候选可见。目录的范围由 104 个已列出模型定义。 [CRC 参数与金样](https://reveng.sourceforge.io/crc-catalogue/all.htm)

`swb.reference.fields.identifyCrc` 以目标会话为范围。输入 `samples` 中每项含 `bytesBase64` 与 `checksumBase64`，最多 16 项，每项覆盖字节最多 4096。可传 `width` 与 `order`。核对未授权拒绝、获准后读取实际结果引用、不同样本数、候选参数和补样本提示。运行 `node --test scripts/crc-recognition.test.mjs scripts/protocol-field-actions.test.mjs` 和上述分帧浏览器、原生启动用例。

### 总线负载（VIZ-10）

在实时或回放的字段工具完成分帧后，展开「总线负载」，选择 10、100 或 1000 ms 窗口。检查源时钟、最大时间刻度和观测范围。只统计 RX 字节区间及 TX 最终回执的已确认区间，发送意图与未知部分不进入已确认速率。分帧核对留存来源，以帧末时间入窗，启用字段定义后再核对协议错误率。跨源或缺口不能补成完整窗口，最后一个未观测完的窗口显示已知量。翻至分帧续页或从回放块内选定起点时，检查分帧范围不足的窗口仍保留已知原始吞吐，帧率和协议错误率留空。运行 `pnpm exec vitest run src/features/workbench/bus-load-model.test.ts` 核对边界、坏校验、部分发送和高位源时间。物理线路奇偶校验和帧错误待受控设备及独立仪器核对。

### 帧异常检查（PROTO-08）

在「协议分帧」扫描有权读取的会话范围，再在「协议字段」下打开「帧异常」。字段定义提供期望长度、校验字段和可选整数或位序号。填入序号字段、允许推断的最大缺帧数及帧间时限。相邻序号按字段位宽回绕。有限的向前缺失显示实收序号和预期序号，越过界限显示跳变。也可显式开启相邻完整字节重复检查。

用独立对端发送回绕、跳号、重复、错误校验和长度不符的帧，核对每条异常的原字节与事件区间。断开源事件或换时钟再比较，检查证据不足提示。最后一帧以后需有同源原始事件才能确认超时。运行 `pnpm exec vitest run src/features/workbench/framing-anomalies-model.test.ts` 和 `pnpm test:ui e2e/browser/framing-tool.spec.ts --grep "scans only visible"`。真实对端和发行实装按同一候选验证。

### 字段标定（PROTO-16）

字段可用 `calibration: {kind: "linear", revision: "probe-1", scale: "0.25", bias: "-1"}` 标识一组线性系数。原始码值 8 应显示物理值 1，结果保留码值 8、原字节及系数版本。已有 `scale` 和 `bias` 定义继续按原格式读写。

整数与位字段可用 `kind: "table"`、`revision` 和按原始码值递增的 `points`。每点含十进制字符串 `raw` 与 `value`。默认采用精确查表。选择 `interpolation: "linear"` 时，以单调标定点验证升序、降序与分段插值。表外应显示未映射并保留原始证据。构造须能反解至唯一原始码值。运行 `node --test scripts/protocol-fields.test.mjs scripts/protocol-field-actions.test.mjs` 和 `pnpm test:ui e2e/browser/framing-tool.spec.ts --grep "packet editor constructs"`。

字段签名包分别从 0.1.0、0.2.0 升至 0.3.0。每条路径在独立 profile 核对已启用、已停用和已卸载三种状态，重复初始化核对快照幂等。真实 Host 在有权会话中调用随包的构造与解码动作，检查标定版本、物理值和原字节同时命中。图表追溯、独立设备、发行实装与版本回退按同一候选继续专项验收。

### 字段图表 CSV（VIZ-13）

在实时分帧或回放字段图表绘制数值字段，点击「导出 CSV」。打开压缩曲线后核对 CSV 行数仍与当前范围的帧数一致。再选择「最近 32 帧」及 XY，核对 CSV 从原图表帧序号开始，包含同一帧的 X 和 Y、原始码值以及各自来源。已确认的采集缺口保留缺失帧数，校验失败和无法确认来源的帧标为无效。对跨收块样本检查事件和字节半开区间、录制序号及原始 HEX。取消系统保存对话框时界面不显示保存成功。

运行 `pnpm exec vitest run src/features/workbench/field-chart-model.test.ts` 和 `pnpm test:ui e2e/browser/replay-layout.spec.ts` 检查精确偏移、压缩及筛选、同帧配对与保存入口。原生对话框、离屏 PNG 的独立 CI 和 MDF4 继续专项验收。

### Modbus 报文模板（PROTO-04、PROTO-20）

工作台「协议分帧」的「Modbus 报文」支持 RTU、ASCII、TCP，方向明确选择请求或响应。以读取 10 个保持寄存器的请求为例，报文 JSON 使用 `{"unitId":1,"pdu":{"functionCode":3,"address":0,"quantity":10}}`。RTU 预览为 `01 03 00 00 00 0A C5 CD`，ASCII 预览为 `:01030000000AF2` 后接 CRLF。添加 `"transactionId":1` 再构造 TCP，预览为 `00 01 00 00 00 06 01 03 00 00 00 0A`。用同一面板回读并核对单元号、零基地址、数量和事务 ID。 [Modbus 应用协议](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf) · [串行规范](https://www.modbus.org/file/secure/modbusoverserial.pdf) · [TCP 实现指南](https://www.modbus.org/file/secure/messagingimplementationguide.pdf)

FC01/02 的独立响应保留装有位值和填充的 `bitBytes`，FC03/04 响应给出 16 位 `values`。FC05 使用布尔值，FC06 使用单个寄存器值，FC15/16 请求使用 `values`，响应回显地址与数量。异常响应保留基础功能码和 `exceptionCode`。串行单元 0 只接受写请求，TCP 单元 0 按普通标识解析。验收逐项核对校验损坏、字节计数、FC15 填充位、范围超限、错误 MBAP 协议号和长度。实时主从、字序映射、迟到响应和重试按事务专项继续核验。

随包动作 `swb.reference.fields.modbus` 接受 `transport` 和 `direction`。用 `mode:"encode"` 送入 `packet`，取回 `bytesBase64`，用 `mode:"decode"` 送入 `bytesBase64`，取回 `packet` 和 `broadcast`。运行 `node --test scripts/modbus-frame.test.mjs scripts/protocol-field-actions.test.mjs` 对照三个封装、八个功能码、异常和错误路径。原生启动用例仍核对具体会话读取授权，浏览器测试核对工作台预览与回读。

工作台选择「比对请求与响应」并载入示例，核对匹配后修改 TCP 单元标识，确认默认网关模式报告单元不符，直连模式仍要求事务 ID 一致。核对非零位填充、读数量、写回显、异常码、串行广播和响应留空的状态。响应损坏时定位到响应输入。随包动作使用 `mode:"compare"`、`transport`、`requestBase64` 和可选 `responseBase64`，TCP 直连传 `unitRouting:"direct"`。固定 Node 的隔离 Host 用例 `native_node_bundled_protocol_registers_on_first_start_and_restart` 核对缺会话读取授权时拒绝，授权后从结果文件读回匹配的设备异常。实际事务仍要在设备场景定时等待。

### Modbus 从站模拟（PROTO-17、PROTO-20）

在工作台「协议分帧」中展开「Modbus 从站模拟」。设备模型 JSON 包含 `unitId` 和 `tables`。可在 `coils`、`discreteInputs`、`holdingRegisters`、`inputRegisters` 中分别配置若干 `{"start":0,"values":[...]}` 块。线圈和离散输入使用布尔值，寄存器使用 0 至 65535 的整数。每表最多 16 块、2000 个地址，`start` 为协议零基地址。相邻块可连读，跨空洞的请求返回异常 2。设备模型可加 `faults`，以 `{"functionCode":6,"behavior":"exception","exceptionCode":6}` 模拟异常，或用 `behavior:"silent"` 模拟静默。

选择 TCP 并载入示例，执行 FC06 后将事务号改为 2 并用 FC03 读回地址 1。预期响应为 `00 02 00 00 00 05 01 03 02 01 02`。用 FC03 读未映射地址核对异常，随后恢复初始模型并再次读回初值。RTU 与 ASCII 的单元 0 只接受写入并保持静默。测试时还应核对目标单元错误、CRC/LRC 损坏以及一次跨空洞写入对模型的影响。

随包动作 `swb.reference.fields.modbusServer` 接收 `transport`、`requestBase64`、`model` 和可选的 TCP `unitRouting`。每次调用返回新模型，需要继续模拟时将其传给后续调用。正常或异常回复的线缆字节位于 `responseBase64`。运行 `node --test scripts/modbus-server.test.mjs scripts/modbus-frame.test.mjs`，并用固定 Node 的隔离 Host 验证授权、回显与返回的寄存器模型。 [应用协议](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf) · [串行规范](https://www.modbus.org/file/secure/modbusoverserial.pdf) · [TCP 实现指南](https://www.modbus.org/file/secure/messagingimplementationguide.pdf)

实时模式沿用当前地址模型。打开并选中可写会话，在同一面板设定 100 至 120000 ms 的接收时限、1 至 64 帧和 0 至 2000 ms 的应答延迟后启动。首方动作 `swb.reference.modbus.slave.serve` 从留存尾部读取 Raw，在 65536 字节预算及同一可续期事务租约内工作。连接建立与关闭由 Host 管理。RTU 现场接线使用无本地回显的链路，真实字符间静默和线路计时仍需独立对端和仪器确认。

先送分块 FC06，再在同一接收块附带 FC03。两次应答应由对端按原序收到，读取返回更新后的值，结果可查请求字节区间与发送确认。RTU 广播更新地址模型并保持静默。点击「请求停止」后核对操作真实取消与租约可重用。任务完成时回填返回的地址模型，取消时保留工作台上一次已收到的模型。运行 `node --test scripts/modbus-live-slave.test.mjs scripts/product-modbus.test.mjs` 校验组帧、广播、断档、发送不确定和签名归档，再用隔离 Host 原生用例与无头工作台验证授权、回执和入口。

### Modbus 主站事务参考动作（PROTO-09、PROTO-17、PROTO-20）

在生产启动配置的首次启动中核对 Host 自动登记首方 `swb.reference.modbus`，并在已打开且授予 `metadata.read`、`content.read` 和 `device.modify` 的会话调用 `swb.reference.modbus.transaction`。独立签名自动化参考包继续通过 `swb.reference.automation.modbus` 复验相同动作逻辑。参数为 `transport`、完整请求 `requestBase64` 和可选的 `startEventSeq`、`responseTimeoutMs`、`lateResponseWaitMs`。前置游标应位于当前留存范围。TCP 可指定 `unitRouting:"direct"`。默认只发一帧，串行广播按 `broadcastTurnaroundMs` 持有租约再完成。

`retryLimit` 可显式开启 1 或 2 次重发，仅用于 FC01—04 单播读取。串行重试要求 `lateResponseWaitMs` 至少 50 ms。所有尝试的发送终态和观察预算须适配 30 秒租约，并预留释放时间。每次只有完整发送且响应与迟到窗口内都未配对时才允许重发。写入、广播或超预算组合在获取租约前拒绝。既有匹配迟到帧、设备异常、来源变化或不完整帧会结束尝试。启用重试时 `attempts` 保留每个操作编号和结算结果，顶层返回最终尝试。TCP 重发递增并回绕事务 ID。串行重发后的帧可能来自之前任何一次尝试，保留 TX 和 RX 源时间并设置 `attemptAttribution: "indeterminate"`，省略 `elapsedNs`。

向受控对端发 FC03，先返回不同事务 ID 的完整帧，再将本次响应拆成两块。报告应跳过第一帧，返回配对的字节区间、同一源时钟的 TX 完成及末段 RX 时间和各自精度。让设备异常超出主超时但仍在迟到窗口内时，结果仍为超时，异常与原始帧保存在 `lateResponse`，随后不再发送。让对端丢弃事务 ID 65535 的首发，并在收到事务 ID 0 的重发后连续返回两条响应。结果包含两个发送操作，跳过首发的迟到帧，并将第二条响应定位到本次精确字节范围。实际用例为 `native_automation_modbus_matches_owned_tx_and_reports_a_late_exception`，使用隔离 Host 和受控虚拟对端。另用 `node --test scripts/modbus-transaction.test.mjs` 验证 RTU、ASCII 的尝试归属、重试上限、半帧与租约预算。RTU 目前按支持的功能长度与 CRC 配帧，线路静默精度、事务时序图和真实设备继续专项验收。 [串行规范](https://www.modbus.org/file/secure/modbusoverserial.pdf) · [TCP 实现指南](https://www.modbus.org/file/secure/messagingimplementationguide.pdf)

从工作台「协议分帧」展开「Modbus 主站时序」。已打开且可写的会话会核对目录中首方主站动作是否支持 `includeTrace`。在插件页停用该包后，工作台隐藏发送表单。选择封装，填入完整请求 HEX，设置超时、迟到窗口和读取重试次数后显式发送。关闭面板停止本地等待，由 Host 继续结算动作。单次操作持有独占事务租约。

本面板使用动作返回的 TX 事件和配对 RX 首尾事件绘制共同时间轴。核对各次发送的起点和应答时限，拆帧应分别显示首末接收偏移、分块跨度、源时钟、精度以及原始字节范围。相同请求与源时钟的首发成功样本至少两次时显示最近八次的耗时极差。该值来自 Host 观测。设备定时、串行线路采样、其他协议时序和正式安装包继续专项验收。

运行 `pnpm test:ui e2e/browser/framing-tool.spec.ts --grep "Modbus master timeline"`，核对实际工作台入口、错误请求不会发送、精确会话调用、超时与重发分行、共用轴和经摘要检查的结果文件。隔离 Host 另核对首发有确证 TX、分块 RX 首尾引用与重发的真实原始范围。`native_node_bundled_protocol_registers_on_first_start_and_restart` 核对随包登记、重启不改 revision、缺少会话写权限时拒绝及授权后 Virtual Echo 会话的实际 TX 终态。组件清单按 Host 记录包 ID、版本与归档摘要。

### Modbus 寄存器与监视（PROTO-10、PROTO-20）

在可写会话打开「协议分帧」中的「Modbus 寄存器与监视」。选择 RTU、ASCII 或 TCP，设置单元标识、地址基准、变量数和响应时限。保持寄存器读取使用 FC03，输入寄存器使用 FC04。核对零基地址 100 与一基地址 101 生成相同 PDU 地址。16 位格式每变量使用一字，32 位和浮点格式每变量使用两字。检查 AB、BA 及 ABCD、BADC、CDAB、DCBA 对照样本，核对表中原始寄存器字和变量值。 [Modbus 应用协议](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf)

以 250 至 60000 ms 间隔启动监视，核对每次读取在前次结算之后安排。停止监视后等待在途读取结算，核对调用数停止增长。对保持寄存器选择一个对齐地址，核对 FC06 或 FC16 与预览的线缆字，确认写回执和随后重新读取的表值。输入寄存器只提供读取。返回异常 2 或让响应逾时，核对异常或迟到范围并确认监视停止。运行 `pnpm exec vitest run src/features/workbench/modbus-register-model.test.ts` 和 `pnpm test:ui e2e/browser/framing-tool.spec.ts --grep "Modbus registers"`。实际设备按三种封装分别验证。

### NMEA 0183 报文模板（PROTO-04）

在工作台「协议分帧」中展开「NMEA 0183」，使用示例或粘贴带 XOR 校验的样本，每行一条，最多 32 条。GGA 核对定位质量、经纬度、海拔和大地水准面差。RMC 核对 UTC、日期、数据状态、航速和航向。GSA 核对十二个卫星槽位及 DOP，GSV 核对片号、卫星槽位和可选信号标识，VTG 核对真航向、磁航向和两种速度单位。空字段保持缺失，RMC 日期保留两位年。点击字段原文应选中对应行的字节区间，修改某行 XOR 后应能定位错误并继续查看其余结果。

随包动作 `swb.reference.fields.nmea` 接收 `text`，按原始行号返回字段、`invalid` 或 `unsupported`。运行 `node --test scripts/nmea.test.mjs` 核对五类报文、旧版与新版尾字段、扩展精度、无定位、错误范围和输入上限。隔离 Host 核对随包动作的会话读取权限和实际结果文件。实际接收器、真实串口数据和离线发行实装继续按 T12 验收。 [u-blox M10 接口说明第 2 章](https://content.u-blox.com/sites/default/files/documents/u-blox-M10-SPG-5.30_InterfaceDescription_UBXDOC-304424225-20395.pdf)

### AT 响应与主动上报模板（PROTO-04）

在「协议分帧」展开「AT 响应」，载入示例并核对 `AT+CREG?` 回显、`+CREG: 5` 主动上报、`+CREG: 2,5` 查询响应和 `OK` 结果。可留空命令独立浏览接收记录。在 ATV0 下用数字 `2` 与 `0` 核对来电和结束结果。另核对输入提示、`+CME ERROR`、`+CMS ERROR`、`CONNECT` 后数据和原始行号。只分析一条在途命令，使用 CR、LF 或 CRLF 分行，留空不将结果归给特定命令。

收到 SMS PDU 头时按声明长度验证后续十六进制行。文本短信或损坏 PDU 的正文边界无法确定时保留后续原文，并避免把其中的 `OK` 当成终态。粘贴的发送短信样本若混有输入提示之后的正文回显，先按采集边界选取设备响应。随包动作 `swb.reference.fields.at` 接收 `text` 及可选 `command`、`format`，`format` 缺省为 `verbose`。运行 `node --test scripts/at-response.test.mjs` 验证交错结果、PDU 边界和输入上限。实际调制解调器、不同厂商的专有上报与离线发行实装继续按设备及包件验收。 [ITU-T V.250](https://www.itu.int/rec/T-REC-V.250-200307-I) · [3GPP TS 27.007](https://www.etsi.org/deliver/etsi_ts/127000_127099/127007/18.07.00_60/ts_127007v180700p.pdf) · [3GPP TS 27.005](https://www.etsi.org/deliver/etsi_ts/127000_127099/127005/18.00.00_60/ts_127005v180000p.pdf)

### 接收区右键操作（UX-08）

在接收记录或准确的 HEX 字节选区打开上下文菜单。右键从指针打开，键盘从当前选区或聚焦的记录打开。菜单依次提供复制格式、发送选区预览、时间书签、在此分屏。失去选区或写入权限时，就近显示可用条件。

```text
宽窗                             窄窗
接收记录 [文本  |  HEX]          接收记录
右键 [复制为 ▸]                  [复制为 ▸]
     [预览发送选区]               [预览发送选区]
     [添加时间书签]              [添加时间书签]
     [在此分屏]                  [在此分屏]
预览：端口 / 原始字节 / 确认       预览：端口
                                  最终字节
                                  [确认发送]
```

复用共享菜单和对话框。确认前显示目标端口、会话原始事件及实际发送的十六进制字节。交互发送不替换现有草稿。换会话、换代、失去写权限或选区失效时重新选择。只读回放保留复制、书签和分屏。书签记录源事件引用和原时间，定位入口按实际留存数据跳转，不按会变化的显示行号跳转。分屏展开同一条记录的文本和 HEX。复验未确认无 TX、全量字节相符、焦点返回、清屏后书签不可用及回放写入拒绝。

### 发送历史（IO-06）

在工作台菜单打开「发送历史」，按端口、时间和会话搜索。固定一条留存记录，关闭桌面后重开同一窗口，或重载配对工作台的同一标签页，核对固定记录随窗口存档恢复。旧操作移出当前投影后按 ID 查询，验证撤权清除记录内容。选择多条并预览原请求字节，核对可写目标的端口、会话和代次。浏览记录、固定及预览期间 TX 接纳数应保持为零。重发按选取顺序，每条等待其新操作的完整写入回执。部分写入、未知终态、输入发生变化、撤销权限和停止等待均阻止后续项，已接纳的操作仍可在任务中核对。

用 `pnpm exec vitest run src/features/workbench/send-history.test.tsx` 验证输入撤权、字节变化和部分结算。用 `pnpm test:ui e2e/browser/workbench-tools-layout.spec.ts --grep "send history"` 核对完整工作台入口。Rust ClientState 测试核对桌面存档、窗口隔离与无效输入保护。实际串口及发行候选继续验证。

### 发送草稿转义（IO-03）

在文本草稿使用“将转义转为 HEX”展开 `\r`、`\n`、`\t`、`\0`、`\xNN`、独立的 `0xNN`、`\h(4F 4B)` 和 `<CR>`、`<LF>`。普通正文沿用选定发送编码，转义生成的字节直接保留，正文空白和另选行尾分别处理。核对草稿保留与选区、保存大小边界、转换后的预览和随后独立发送的字节。转换沿用现有草稿登记。

HEX 草稿或自定义行尾输入奇数个数字、非法字母及补充平面字符时，核对对应字段显示的字符位置。在该字段按发送快捷键，核对错误范围被选中和 TX 接纳数保持为零。补全字节后重新核对预览。

### 发送校验（IO-13）

在发送栏打开「发送校验」，选择 Sum-8、XOR-8、CRC-16/Modbus、CRC-16/CCITT-FALSE 或 CRC-32/ISO-HDLC。CRC 支持两种字节序，Modbus 默认低位字节在前。范围使用从零开始的编码字节偏移，包含起点、排除终点。起点和终点分别留空时使用开头和末尾。默认只计算正文，可将已配置的行尾纳入。校验值总是追加在正文和行尾之后。切换草稿或会话代次后需要重新选择校验。 [Modbus 串行规范](https://www.modbus.org/file/secure/modbusoverserial.pdf)

运行 `pnpm exec vitest run src/features/workbench/send-checksum.test.ts src/features/workbench/send-panel.test.tsx` 核对标准向量、两种字节序、UTF-16LE、行尾、非法偏移和会话隔离。用 `pnpm test:ui e2e/browser/send-conversion.spec.ts` 在中文窄窗口核对 `02 07 41 12`、范围错误阻止提交和关闭面板后的焦点。

### 快捷键速查（DIAG-05）

按 F1、从帮助菜单选择“键盘快捷键”，或在快捷操作中选择同名命令。用 `pnpm test:ui e2e/browser/smoke.spec.ts` 核对搜索焦点、按键与文本联合过滤、收发工作台的文本和 HEX 发送模式，以及 Escape 后的焦点恢复。注册命令共享按键时，速查显示冲突提示。发送快捷键仅在发送编辑区生效。

在速查中修改快速操作、设置、侧栏或全屏的绑定。核对冲突提示、应用新绑定、重新加载、取消与恢复默认键位。F1、Escape 和会话发送键沿用固定作用域。

### 桌面诊断包（DIAG-06）

在诊断页展开报告，核对 JSON 包的 `formatVersion`、采集时间、系统名称和架构、应用与 Tauri 版本、已提交配置修订和日志尾部。保存并逐字节比对预览。用独立 profile 的应用日志核对记录首行的配对码与凭据脱敏，以及截断半行和续行的排除。取消系统保存后可以重试，保存使用本次预览，源日志保持原样。真实对话框按桌面边界安排。

Windows 签名终端原生专项在独立 runner 的同一桌面应用中使用真实对话框保存诊断包。候选 `358265d` 已核对当前语言、格式版本、对话框归属、操作后焦点和预览字节。`diagnostics-export.json` 收据记录选择路径、长度和摘要。 [Windows 专项收据](https://github.com/YanChao001/serial-workbench/actions/runs/45180993433/artifacts/14822645595)

### 文件传输进度（XFER-04）

在可写会话打开「文件传输选项」，选定文件和范围，降低发送速率以观察多次累计更新。文件发送和任务面板的进度条均以 Host 确认的已接纳字节为分子，以请求字节为分母。对照块回执和实际写入量，设备确认单独读取协议结果。观察速率和预计剩余时间在进度增长后出现，超过五秒无新增或任务结算后停止显示估算。

显式取消发送，检查取消请求先沿用原操作 ID，再按实际终态保留已接纳和未知字节数。用 `pnpm exec vitest run src/features/workbench/transfer-progress.test.tsx src/features/workbench/transfer-options.test.tsx src/features/workbench/operation-panel.test.tsx src/features/workbench/operation-actions.test.tsx` 检查百分比、单调速率、估算失效及权限。用 `pnpm test:ui e2e/browser/transfer-progress.spec.ts --workers=1` 确认工作台通过操作订阅读到累计值和终态。在第二块写入未结算时观察已读量先于已接纳量，取消后再查询同一操作的封存回执。用 `cargo test --locked -p serial-workbench-host --test file_transfer --test file_api_host --test transfer_evidence_storage` 核对分块读取、取消、旧回执未知、撤权、过期回收和原子回滚。用真实对端记录实际接收量和确认，与 Host 写入回执分别对照。正式发行包沿用同一场景复验。

### 协议字节分色（DISP-08）

在分帧或只读回放的字段预览选择一帧。先显示完整 HEX，再显示可选字段及其说明。窄窗让十六进制段和字段按钮自然换行，详情置于字段之后。宽窄版均可用键盘选择字段，详情显示值、原始字节、绝对半开区间和适用的位范围。

定义中的校验类型与名称为 `header`、`address`、`length`、`payload`、`checksum` 的字段提供初始颜色。用户可为当前定义选定展示角色。任意名称的字段默认保留普通字节颜色。共享同一字节的字段可分别用字段按钮检查。解析失败后保留可读的完整原始 HEX。复验未覆盖字节、多个字段共用字节、明暗、错误定义、选择其他帧和只读回放。

### 接收选区导出（DISP-20）

从接收区的 HEX 或 ASCII 选取同一方向的连续原始字节。打开字节选区，确认方向、起止字节和总数，再选择 HTML 或 SVG。两种格式用同一份 HEX 和可打印 ASCII 展示数据。宽弹层将格式、主题和分页放在标签右侧，窄弹层按标签、选项与预览顺序纵排。保存按钮紧随预览，取消文件对话框保留当前选择。

HTML 保存完整范围，打印时按段分页。SVG 每页最多 64 个十六字节行，一次保存当前页，选择器标明页号，文件内保留该页和完整范围。浅色或深色由用户明确选择。ASCII 中的尖括号、引号和 `&` 只作为文字输出。复验 64 位字节偏移、跨事件连续选区、缺口拒绝、短末页、权限变化及键盘选择。配对浏览器沿用本章的 `e2e/paired-browser.mjs`。通过「查找字节」的「记录筛选」选择 RX，在 420 像素宽度下跨两条记录选取 4 字节。以独立 CLI 读取的 Raw 事件核对下载的深色 HTML 和浅色 SVG 的文件名、字节范围、HEX、ASCII 转义和背景。结果记录在 `receipt.json` 的 `selectionDownloads`。原生保存对话框和发行包按[桌面边界](./testing.md#桌面边界)验收。

### 多端口广播（IO-17）

在同一工作台的当前 Host 选择至少两个已打开的可写会话。预览一份最终发送字节并明确确认目标列表。宽窗让目标列表与字节预览并排，窄窗依次显示目标、字节、确认和逐目标状态。端口名自然换行，字节数和会话代次使用等宽数字。逐目标的停止及重查与该行状态相邻。

```text
宽窗                              窄窗
目标端口        │ 最终发送字节    目标端口
[ ] COM14      │ 53 54 41        [ ] COM14
[ ] COM15      │ 3 字节          [ ] COM15
[确认并行发送]                    最终发送字节
COM14  已接纳 [停止]              [确认并行发送]
COM15  终态                       COM14  已接纳 [停止]
                                  COM15  终态
```

并行送入各自的 Host TX 队列。验证两路相同字节、第三路拒权或配置修订变化、既有发送仲裁和独立完成顺序。接纳前取消不得投递。接纳响应在途时记录停止意图，收到确切操作 ID 后请求停止。检查部分、未知和失去观察的状态。重查只读取原操作。实际两设备、独立 Host 目标和正式发行分别记录已验证范围。

### 文件拖放发送（IO-18）

在可写的本机桌面会话打开「文件传输」，将单个普通文件拖到源文件字段。核对字段显示文件名和大小，范围按整份文件初始化。调整范围并检查 Host 到确认时才接纳发送。拖到字段外、同时拖入多个文件、切换窗口、重载或换代后使用旧票据，均不应将该文件带入预览。复用物理串口对端核对确认后的实际字节。用 `pnpm test:ui e2e/browser/transfer-progress.spec.ts --workers=1` 验证落点、代次和确认，桌面 Rust 单测核对票据归属、一次性、过期及多文件限制。三平台操作系统的实际拖放、配对浏览器文件交接和正式发行继续验收。桌面命令槽的专项场景见下文。

#### 浏览器交接草稿

配对浏览器打开与桌面共用的文件传输工具。只读配对显示当前权限和禁用原因。有操作权限时可选择一个文件或将它拖到源文件字段。字段显示可读取的完整文件名和大小，范围以原始字节计。样本区用等宽字显示所选范围开头的少量十六进制字节及实际偏移，窄窗在样本区内换行。选择或拖放只在浏览器更新预览。确认后显示交接进度与取消入口。提交接纳期间保留同一请求号，连接恢复后按原请求查回执。Host 接纳后显示设备写入进度和停止入口，等待停止结果后才显示实际终态。切换会话、换源或关页后，迟到结果归原请求。已接纳的任务可从任务列表按原操作继续查看。只在当前标签页保留待查的提交信封，信封按 Host 代次、配对身份和目标隔离。回执不明时先丢弃可能仍在的交接文件，再按原请求号查回执。没有接纳记录时恢复选取或确认入口。浏览器端保持共享文件字段、控件尺寸、表单边距和按钮层级。全文件名可键盘读取，字节预览限制为选区开头 16 字节。 常规页将大小放在源文件标签旁，偏移和长度并排，选区预览紧跟两个输入。速率与分块参数一起放进高级页，让矮窗同时能看到文件名、范围、预览和确认操作。

```text
宽窗                           窄窗
源文件 [firmware.bin][浏览]   源文件
范围   [起始][长度]           [firmware.bin][浏览]
选区字节数 / 选区开头         范围 [起始][长度]
高级 [速率与分块参数]         选区字节数 / 选区开头
                [确认发送]    高级 [速率与分块参数]
交接进度 [取消] 或停止发送                 [确认发送]
                               交接进度 [取消]
                               写入进度 [停止发送]
```

交接软测以真实配对连接和 Virtual Echo 比较范围对应的原始字节，分别触发接纳前关页、撤销、断开重连，以及接纳后停止和回执重查。检查第二个连接无法复用临时引用，失败和重启回收磁盘，用户确认前设备保持静默。

Host 分块交接运行 `cargo test --locked -p serial-workbench-host --lib --test browser_pairing browser_file -- --test-threads=1`，核对磁盘上的封存字节、SHA-256、错序、写失败、闲置回收、连接隔离、撤权后重新授权与撤销配对。封存 `00 FF 24 7B` 后选择偏移 1、长度 2，使用 Virtual Echo 的独立 Raw 读端核对恰好收到 `FF 24`。发起连接取得接纳回执后断开，从同一配对身份的另一个连接以原请求号查询同一操作。修改选区后复用请求号应拒绝，另起请求也无法再使用已转移或已丢弃的封存文件。完整配对回归另外覆盖只读权限、连接来源与通道边界。配对 Chromium 复验先运行 `pnpm build:web`，将 `SWB_TEST_BROWSER_TRANSFER_OUTPUT` 指向验收产物目录，再执行上述 `browser_pairing` 专项。测试由隔离 Host 服务 `dist-web`，经真实配对进入 Virtual Echo，在 420×610 和 1240×820 检查文件选取、拖放命中、长文件名、完整选区预览及硬盘文件交接前的静默。确认后核对同一调用信封、2 B 写入回执和独立 Raw 读端的 `FE 23`，保存宽窄截图和脱敏回执。物理串口、三平台系统拖放和正式发行继续专项验收。

#### 命令槽文件导入

浏览器与桌面共用正文标题、载入按钮及预览。宽窗在正文标题右侧放载入按钮，窄窗在各自容器内换行。预览展示完整文件名、字节数和开头的 HEX。已有正文时给出替换提示，取消将焦点还给载入按钮，确认将焦点移到正文。保存按钮沿用编辑器固定操作栏。

```text
宽窗                                      窄窗
命令正文  拖入一个文件          [载入文件]   命令正文           [载入文件]
[正文编辑区，文件只接受此区拖放]             拖入一个文件
文件名  字节数  HEX     [取消] [替换正文]    [正文编辑区]
                                    [预览文件名、字节数和 HEX]
                                           [取消] [替换正文]
```

浏览器只读取用户选择的单个非空文件，读取前检查正文预算。选取和预览在当前标签内完成。显式应用只写入本地命令草稿，保存时使用现有工作区修订合同提交正文。取消、关闭编辑器、切换命令或 Host 换代后，迟到的文件结果不能修改当前草稿。桌面仍通过当前窗口持有的票据读取并校验 Host 文件。

预定义命令槽从所选分组的命令编辑页接收单个文件。正文区使用同高的文件入口，可用键盘选择。把文件的原始字节填入 HEX 草稿，保留名称、备注、选定编码和命令行尾，并明确标出待保存状态。已有正文先提示替换，取消时保留原稿及焦点。正文预算按现有命令库序列化上限计算。空文件、超出预算和读取错误提示原因，原草稿可继续编辑。Host 换代后旧票据和迟到读取无法应用。保存沿用命令库的修订号和真实回执。之后可从命令库载入发送稿并走独立确认。

用中文窄窗和英文宽窗键盘完成文件选择、确认和取消。核对有效落点、多个文件、长文件名、任意二进制、空文件和边界尺寸。命令槽运行 `pnpm test:ui e2e/browser/command-library.spec.ts e2e/browser/transfer-progress.spec.ts --workers=1`。核对拖放落点和代次、键盘浏览、取消后焦点、HEX 替换和撤销、准确的最大长度、空文件与越界、关闭后忽略迟到读取、保存后再次打开还原相同 HEX。真实配对复用 `SWB_TEST_BROWSER_TRANSFER_OUTPUT` 场景，在浏览器新建命令分组，核对单文件落点、多文件拒绝以及 0、21,845、21,846 字节的边界。确认替换后保留备注，将 `09 FF 00 41` 随修订保存并重开确认。命令槽选取和应用期间无文件发送交接请求。真实系统拖放、独立设备及正式发行分别留存证据。

### 复现实验包（SESS-09）

从「工作区配置」进入「复现实验包」。按[宽窄草稿](./ui-design.md#复现实验包草稿)核对导出证据选择、脱敏预览、文件保存、导入依赖检查和配置替换。

Host 软件验收应核对一致修订、篡改与未来版本、源访问受限、解析器已禁用、录制缺失或摘要不符、空工作区、仅只读检查和导入后设备重新绑定。注入命令正文、USB 序列号、路径及错误详情作为样本，核对它们没有进入导出的 JSON。工作台验收另核对宽窄布局、稳定错误、键盘操作、保存取消、修改冲突和跨 Host 提示。

跨 Host 软件验收先运行 `pnpm build:web`，将 `SWB_TEST_EXPERIMENT_BROWSER_OUTPUT` 指向新的绝对证据目录，然后运行 `cargo test --locked -p serial-workbench-host --test capture_api_host experiment_browser::paired_browsers_exchange_experiment_between_two_hosts -- --ignored --exact --test-threads=1`。场景启动两个隔离 Host 和无头 Chromium。源端封存 Virtual Echo 录制，从配对浏览器下载脱敏包。目标端检查解析器缺失和异机录制，确认前保持工作区，确认后按修订保存。设备库只列出目标工作区 Host 上可供重新绑定的设备，用户确认后保留原线路配置并使用新设备身份。查看浏览器动作收据、Host 修订及截图。实体串口、不同机器与正式安装另按相应环境复验。

### 会话模板（SESS-03）

宽窗并排查看模板和当前连接的线路参数，窄窗按相同阅读顺序纵排。设备名可自然换行，线路值等宽显示。打开按钮沿用工具窗尺寸并置于状态提示后。无会话时仅显示模板参数。参数不同且已有会话时，两组值同时可见，提示先关闭当前连接。

```text
宽窗                             窄窗
会话模板 [AT 模组 ▾]              会话模板 [AT 模组 ▾]
目标设备与用途                    目标设备与用途
模板参数      │ 当前连接          模板参数
115200 / 8N1  │ 19200 / 8E1       115200 / 8N1
流控          │ 流控              当前连接
请先关闭当前连接                 19200 / 8E1
[按模板打开]                     请先关闭当前连接
                                 [按模板打开]
```

在工作台选择串口、PTY 或虚拟串口，从工作区菜单打开「会话模板」。STM32 调试和 AT 模组示例使用 115200 / 8N1，Modbus RTU 从站示例使用 19200 / 8E1。按设备文档核对线路参数后选择「按模板打开」。检查 Host 收到明确的配置，超时及重连间隔按原设备配置传入。打开已有会话时，切到线路参数不同的模板，核对仍显示原配置并要求先关闭。分别查看固件日志、载入 AT 示例，以及载入 Modbus 从站模型。只有显式发送、模拟请求或启动从站才执行对应操作。用 `pnpm test:ui e2e/browser/session-templates.spec.ts --workers 1` 核对两种从站动作可见性、参数和接线。

若从站动作缺失，从模板进入「管理插件」，用可信签名包启用或安装 Modbus Slave（`swb.reference.modbus.slave`），在工作台重新打开模板。检查目录已有从站动作，打开端口后以独立主站对照实际帧。STM32 接合适电平的串口设备读取启动日志，AT 模组按其实际设置核对命令回显、最终结果和异步通知。离线发行按同一签名候选分别复验首次启动和插件恢复。

### 故障向导（DIAG-02）

从工作区菜单打开「故障定位」，选择要检查的问题。分别验证以下四条路径。

- **打不开串口**。选中端口并制造系统拒绝、应用授权不足、设备离线或配置冲突。核对错误码与对应提示，切换连接栏设备后旧失败不应移到新端口。显式重试只能针对所选端口。
- **乱码**。从同一会话收到带 UTF-16 LE 字节顺序标记的样本，核对当前编码、候选、样本字节数及证据类型。应用候选后回到原视图核对文本，原始字节和发送量保持一致。改用只含 ASCII 的短样本时，界面应提示证据不足。
- **丢数据**。分别注入读端溢出和采集流缺口，核对两类记录计数。结束 Raw 时核对实际错误码，打开运行指标或返回十六进制查看。用独立对端的序号和校验对照实际链路丢包。
- **断连**。从 Host 会话断开设备，核对重连状态、尝试次数和错误码。槽位或设备身份变化时先确认目标，再显式重开。已接纳的写入按原回执结算。

运行 `pnpm exec vitest run src/features/workbench/diagnostic-panel.test.tsx` 和 `pnpm test:ui e2e/browser/troubleshooting.spec.ts e2e/browser/connection-notice.spec.ts --workers=1` 核对软件表现。物理断连与错误设备驱动使用正式候选验收。

## 安装与发行验收

Windows 更新准备的原生测试用 `cargo test --locked -p serial-workbench --lib updater::host::tests -- --test-threads=1 --nocapture`。用例在独立 profile 启动真实旧进程，观察正常退出、已释放锁时的等待和非零退出。关闭进程句柄后重试，检查原代次的失败仍会拒绝准备。

验证同协议的旧版与候选 Host 进程时，把 `SWB_TEST_UPDATER_LEGACY_HOST_BIN` 和 `SWB_TEST_UPDATER_CURRENT_HOST_BIN` 分别设为旧版和候选 Host 程序的绝对路径，选择 `desktop_install_recovers_through_current_host_after_legacy_shutdown` 并加上 `--ignored`。按 [Rust 与生成](./testing.md#rust-与生成)核对两份程序的构建与摘要。用例验证旧程序退出后提示重开工作台，再用候选启动同一 profile，核对新代次和正常关停。锁交接、替换与失败恢复须用两个实际安装包验证。

如果测试进程所在的 Windows Job 禁止自动启动独立 Host，保留原始结果，并设置 `SWB_TEST_UPDATER_MANUAL_HOST_START=1` 复验手动启动后恢复同一 profile。收据区分两种启动方式，自动启动仍需在允许独立 Host 启动的环境中验证。

Windows T14 同卷套件切换的软件专项用 `cargo test --locked -p serial-workbench-ipc --lib install_switch::tests -- --nocapture`。夹具使用独立 profile 和模拟的桌面、Host、CLI、MCP、Node 文件。核对写入意图受阻、归档旧套件后中断、新套件换入后提交前中断、处于 Windows 占用状态的目录无法移动、重新取得锁后可以恢复，以及摘要篡改。收据记录原身份、代次、profile 字节核对结果、两个套件的完整摘要及恢复结果。

`windows-nsis-switch` 运行时预检另在隔离 Windows runner 创建本轮专用卸载项，核对版本、安装容量和稳定注册字段。中断点位于新字段已落盘、套件意图尚未提交时，随后用同一操作收据恢复目录和注册表。`registry-recovery.log` 留存成功与回滚终态。旧版及发行候选的真实注册入口按发行范围核对。

安装协调进程先验证两套产物的完整摘要并记录操作 ID 和安装路径，经本机 Rust 接口 `InstallSwitch::open` 持有实例锁并核对旧 Host 退出，再调用 `replace`。重启后用同一操作 ID 和安装路径调用 `recover`。调用方负责在换入前排除其他程序写入安装目录，并在启动任何产品进程前完成恢复。当前用户版 NSIS 的暂存入口只接受同一条 `/S /SWB-STAGE` 参数组合，套件写入安装器自身的 `.swb-stage-<operation>` 目录。启动前该目录仅含协调进程已验签的安装器。实际接入须等待安装器退出，收回该份安装器副本并验证剩余目录摘要，再执行套件切换，覆盖注册表与快捷方式的提交和回滚。用两个真实安装包验证进程监督、锁交接和终态。

NSIS 暂存预检在[手动 CI](../.github/workflows/ci.yml)选择 `runtime_preflight=true`、`runtime_preflight_target=x86_64-pc-windows-msvc` 和 `runtime_preflight_suite=windows-nsis-stage`。隔离 runner 编译候选 NSIS，用相同工具链运行 `pnpm test:installer --interactive`。暂存夹具调用生产初始化函数，检查空操作目录写入、已有文件保护和错误目录名拒绝。实际安装器用一次性密钥签名，验证工具在调用暂存入口前拒绝常规签名、版本不符与内容篡改。成功后核对签名安装器副本已收回、Host/CLI/MCP 与 Node 的固定摘要，以及安装相关注册表项的前后状态。`installer-layout.log` 保留全套件、安装器、桌面程序、卸载器和各组件的摘要。正式签名、持锁换入、回滚与两个版本的实际升级各自验证。

候选 `efce804` 的隔离 Windows 收据覆盖 8.3 短名展开、重定向目录拒绝和真实安装器的组件摘要。 [Windows NSIS 暂存收据](https://github.com/YanChao001/serial-workbench/actions/runs/45162109634/artifacts/14812661628)

在同一预检入口选 `windows-nsis-switch` 可额外构建两个版本的实际 NSIS，以一次性密钥分别测量并签署完整套件摘要。普通暂存要求 v2 签名声明，安装器退出后重新计算摘要。仅有安装器和版本签名、有效签名声明了错误套件摘要的场景均须拒绝，且无换入收据。成功收据包含 `suiteVerified: true`。

独立验证进程先核对旧安装和新套件摘要，摘要不符时旧 Host 必须继续运行。正确摘要进入真实关停和持锁换入，按原操作 ID 核对已提交终态，并重新运行新套件的 Host。检查原 Host ID、递增实例代次、profile 数据、旧套件摘要及注册表前后状态，保存 `installer-layout.log`。此验收覆盖同源版本号递增的套件和独立 Host，发行密钥、桌面自动重启、安装注册切换及旧版升级仍按实装场景验收。

旧前台进程屏障用旧套件随附的 Node 进程作隔离夹具。错误创建时间或镜像路径会在旧 Host 关停前被拒绝。确认协调器已持有 Host 锁后，核对夹具仍运行、旧套件摘要仍可读。由测试关闭这个进程的 stdin，等待它正常退出，再核对换入收据。真实桌面退出和自动重启另按产品更新流程验收。

同一 Windows 专项把旧套件内实际桌面程序复制到独立目录，向协调模式送入不完整的请求，核对进程退出、Host 保持运行和安装文件保持原样。产品端到端还需用已注册的当前用户版 NSIS，从桌面设置发起签名更新，核对就绪回执、旧进程退出和新桌面自动启动。

产品路径选择 `windows-nsis-desktop-update` 与 Windows x64 运行时预检。隔离 runner 构建两个实际 NSIS 版本，用一次性签名密钥和回环 HTTPS 发布候选。正常注册旧版安装后，通过旧桌面「应用更新」页检查、下载并确认安装。核对原进程正常退出、新进程自动启动、目标版本实际呈现、安装文件摘要、Host 身份与代次以及注册项稳定字段。收据放在 `artifacts/windows-desktop-update`。此夹具覆盖正常完成路径，中断恢复和正式发行凭据另行验收。

Host 未换代时，收据记录新旧桌面的进程号及 Host 发现代次。按新桌面进程号查看 `desktop-startup.log` 中的接入阶段和固定错误码。启动配置只记录来源类别，接入日志仅含状态和代次等字段。

专项使用隔离 runner 内的原生启动夹具，让旧桌面、升级协调器和自动重启后的新桌面继承同一个受控 Windows Job。该 Job 允许生产 Host 启动入口显式申请独立运行。收据使用实际旧桌面 PID 和它的退出状态，随后核对新版桌面及 Host 代次。

隔离 Windows 环境中，准备 Tauri 的 NSIS 编译器缓存后运行 `pnpm test:installer --interactive`。暂存夹具嵌入生产入口，在新目录执行并核对套件文件。已含其他文件和命名不符的目录都必须拒绝，保留原文件和安装器副本。此场景不写入已安装程序和注册信息。

M6 用发行候选在预先未安装 WebView2 Runtime 的独立 Windows x64 环境验证 NSIS。将本轮发行候选的安装包和同源验收材料转移到环境中，记录 WebView2 的系统和当前用户注册信息、网络状态及安装前后的版本。断网状态下实际安装并首次启动，使用已安装的程序运行三个签名参考场景。记录系统版本、安装退出码、组件摘要、首次打开窗口及用例结果。M2 和 M3 验证 Windows 安装包内置的离线 Runtime、固定 Node 安装布局和软件参考场景。最低系统和正式发行签名按 M6 矩阵验收。 [Microsoft 离线部署](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#offline-deployment)

Ubuntu x64 的实际 Debian 离线安装可在[手动 CI](../.github/workflows/ci.yml)选 `runtime_preflight=true`、`runtime_preflight_target=x86_64-unknown-linux-gnu` 和 `runtime_preflight_suite=linux-offline-installer`。作业在线构建同源 `.deb` 和签名参考包，进入仅有停用 loopback 的隔离网络后执行 `dpkg --install`。无外网环境中以普通用户运行现有参考包用例。终端使用安装后的 Host、CLI 与 MCP，图表和自动化使用安装后的 runtime 和客户端。收据保留 `.deb` 与安装组件摘要、隔离观察、三个签名包签名回执和测试输出。此专项用于 T14 的 Ubuntu 离线软件验收，原生窗口、最低系统和发行安装器另行验收。

macOS 使用 `runtime_preflight_suite=macos-offline-installer`，目标选择 `aarch64-apple-darwin` 或 `x86_64-apple-darwin`。作业检查 Seatbelt 实际拒绝 IPv4 和 IPv6 连接，保留本机 Unix socket。在同一规则下挂载实际 DMG，把 `.app` 复制到本轮独立安装目录，卸载映像后使用副本运行现有三个参考场景。记录系统、架构、进程隔离、映像与安装组件摘要。签名与公证按正式发行验收执行。

进入 M6 时，按[验收场景映射](./requirements.md#附件验收方案与功能映射)核对纳入需求在前序阶段应完成的软件验证。例如 T04 此时已有能力与配置回执，接线与仪器结果留在 M6 实测。PERF-08 的实际 72 小时在本阶段完成。T14 在 M2 验证离线包，在 M3 验证后台升级，M6 用发行候选核验 Windows 断网实装和最终产物。退出 M6 时逐项核对适用的软件、硬件和发行证据，排除或推迟项沿用账本中的范围决定。

安装升级前先按变更选择数据验证：CAS 冲突、未来格式拒写、读/写/备份失败、替换竞态及中断恢复均核对原件和最终状态。隔离恢复同时检查暂存、明确重启、归档及回滚；只读 fixture 或成功返回不足以确认恢复正确。

按实际系统覆盖安装、首次/重复启动、卸载、系统 WebView、协议关联、自启动与窗口恢复；更新使用两个不同版本核对下载/验签、工作协商、安装、重启和失败恢复。Windows portable 单独验证，macOS 签名/公证、Linux 包格式分别记录。

按[平台目标](./requirements.md#平台目标)在最低支持系统核验安装与运行。Windows 实测目标芯片、接线、流控、BREAK、拔插与休眠，并用两台物理机在 IPv4/IPv6 下互换 LAN 角色。macOS/Linux 做实现与虚拟设备验证。三平台各自用固定 release 和典型负载实际运行 72 小时，记录机器、完整进程树、吞吐、队列、CPU/RSS 和控制延迟。

初始软件参考负载为单会话 11,520 B/s、四会话各 100 KiB/s、八会话各 1 MiB/s 压力；M1/M2 实测后固定机器、预算及阈值。3/6/12 Mbps 使用确实支持的适配器和对端；百万点/60FPS 记录通道、可见范围及降采样，满队列保留缺口或停止原因。
