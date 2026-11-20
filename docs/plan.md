# 路线与进度

**当前接续点（2026-11-21）为 M2 LAN 双 Host。** M2 B、C 和配对浏览器已分别经 [PR #49](https://github.com/YanChao001/serial-workbench/pull/49)、[PR #50](https://github.com/YanChao001/serial-workbench/pull/50) 和 [PR #51](https://github.com/YanChao001/serial-workbench/pull/51) 合入 `main`。逐项软件、硬件和发行状态见[需求账本](./feature-status.json)。

## 当前执行与下一步

1. **B / 14.3–14.4 已验收。** 同一候选 `9090867` 通过自审、本机综合检查、无头 UI 203 项和完整四目标 CI。四个原生桌面均验证同连接的目录恢复与关窗录制，重开补读的三段 RX 与 69 字节录制一致。Windows 实际打开和保存对话框均返回同一窗口焦点，两种 macOS 架构完成进程回收。打开中的插件实时更新语言仍待交付，UX-13 保留为部分软件进展。[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44681253676)
2. **C / 14.5 已合入 `7befd10`。** 同源候选 `bfd37d6` 通过本机综合检查、203 项无头 UI 和完整四目标 CI 的 13 项作业。四个原生桌面核对关窗录制、重开补读和撤权。Debian x64 与 macOS arm64/x64 的实际断网安装通过三个签名参考场景。图表证据覆盖采样值与原始字节区间，界面交叉定位仍在 M3 到 M4 验收。[PR #50](https://github.com/YanChao001/serial-workbench/pull/50) · [四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44705059778)
3. **Windows 断网实装移至 M6。** `bfd37d6` 的未签名 Windows x64 NSIS 已确认内置 WebView2 离线安装程序、固定 Node 和三个伴随程序。Microsoft 安装程序的 Authenticode 验证有效。用户确认用 M6 发行候选，在未安装 WebView2 的独立 Windows x64 环境实际断网安装及首次启动。此前的安装材料和失败记录保留。[M6 安装验收](./testing.md#安装与发行验收)
4. **配对浏览器已合入 `d504166`。** 同一候选 `92f0d5f` 通过本机综合检查、205 项无头 UI 和四目标 CI 的 13 项作业，两项专项预检按运行模式跳过。Windows 原生桌面通过实际配对及接管，所选 MCP 失去当前串口的写入权，另一身份在同一会话继续收发。[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44770530228)
5. **M2 剩余出口为 LAN 双 Host。** 在持口端验收共享、权限和写入仲裁，在使用端验收应用路由、MCP 与会话恢复。完成本阶段的软件出口后进入 M3。

**FUT-08 配对浏览器（工作树，Windows）。** Host 提供显式启用的 loopback 页面与 WebSocket 入口。真实回环测试通过 Host 与 Origin 校验、一次性配对、专属普通身份附着和控制连接关闭后的 Raw 清理。复审后改用浏览器独立随机生成的重连凭据，拒绝用已消费的配对码重连、重新绑定凭据或冒用桌面身份。复验也核对了未读完静态下载时关停及重开同一 profile。无头启动器可通过受保护的继承管道接收配对码。真实 Host 通过三项定向检查，真实 Chromium 在另一个浏览器上下文重用配对码被拒绝。证据见 `.cache/evidence/m2-browser-pairing/browser-review-auth-host-retest.log` 与 `browser-review-exact-20261120-221938/`。

同一真实 Host 提供生产构建的工作台。无头 Chromium 拒绝错误配对码，经本地 CLI 显式授权后配对，从界面打开 Virtual Echo 并收到回显。CLI 读取到浏览器保存的布局与语言。刷新后重用配对、恢复布局，显式打开视图后仍在同一会话 ID 与代次收发，Host 正常退出。定向用例见 [paired-browser.mjs](../e2e/paired-browser.mjs)，源码与产物摘要、收据和截图见 `.cache/evidence/m2-browser-pairing/browser-workbench-verified/`。

**已运行 Host 的配对与撤销（工作树，Windows）。** 本机用户控制连接可设置只读或操作权限。普通 IPC 与浏览器均无法管理入口。真实 Host 用例验证只读浏览器获得原串口的 Raw 游标且不可发送，撤销关闭浏览器控制与 Raw 连接，原桌面身份仍可在同一串口会话发送并读回成功回执。无窗口桌面桥验证当前连接代次、配对、状态查询和撤销，窄窗口 Chromium 用桥接替身查配对码、撤销及焦点。Tauri 构建复制的 57 个工作台文件与同轮前端构建一致，10 项便携布局与资源复用检查通过。证据见 `.cache/evidence/m2-browser-pairing/` 中的 `live-browser-host-verified.log`、`live-browser-desktop-bridge.log`、`live-browser-ui-verified.log`、`live-browser-resource-copy.json` 和 `live-browser-portable.log`。原生窗口全程、实际安装产物、绑定窗口的 MCP 跟随、暂停及接管继续验收。

用当前 Host 和 CLI 直接提供 Tauri 构建目录中的浏览器资源，无头 Chromium 复验通过配对、共享设置和工作区、刷新与同会话收发。收据、程序摘要和源码入口见 `.cache/evidence/m2-browser-pairing/live-browser-resource-e2e/`。

**FUT-03、FUT-08 命名 MCP 客户端跟随（工作树，Windows）。** 工作台「活动」可选择要跟随的 MCP 客户端。实际 stdio MCP 与 Rust Host 核对两个名字对应两个 actor，同一个查询重用活动记录，动作重试沿用已接纳的操作。生产前端用无头 Chromium 配对到同一个 Host。重复查询及未选客户端的新查询均不触发跳页，选中客户端的新查询只带回绑定窗口。目录为设备、工作区、串口参数及控制、传输、录制和活动等工具声明面板。实际 `device.list` 查询验收通过，绑定窗口在草稿移开焦点后打开设备面板，另一窗口留在设置，重复轮询未重开面板，草稿保留。暂停后 MCP 在原会话仍能发送并收到 Virtual Echo。目录生成、类型检查、构建和 97 项前端回归通过。源码、程序摘要、双窗口收据及截图见 `.cache/evidence/m2-browser-pairing/mcp-panel-real-workbench-20261120-213505/`，早期证据保存于父目录。真实桌面窗口及插件贡献视图的定位仍需验收。

**FUT-03 本机人工接管（工作树，Windows）。** 在「活动」面板按所选 MCP 客户端和当前串口代次提交接管。真实 Host 与无窗口桌面桥确认普通身份和旧窗口代次的请求被拒绝。本机用户操作结算成功后，所选客户端失去原串口写入权，另一身份仍有写入权，原串口和桌面连接代次均保留。三个 Host 用例分别验证撤权期间的未接纳请求、排队写入、在途结果、其他串口继续执行及无法确认时的隔离。207 项前端定向检查通过，覆盖保留草稿和等待终态的反馈。日志见 `.cache/evidence/m2-browser-pairing/` 下的 `takeover-scoped-admission.log`、`takeover-control-state.log`、`takeover-desktop-bridge.log` 和 `takeover-frontend.log`。

同轮生产前端及重新构建的 Host、CLI、MCP 复验配对、同会话收发、双窗口跟随及暂停。桌面绑定与生成默认值校验通过。源码、程序和测试收据对应关系见 `.cache/evidence/m2-browser-pairing/takeover-browser-regression-20261120-204505/`。

**FUT-03、FUT-08 浏览器请求接管（工作树，Windows）。** 真实 Host 的三项 `browser_pairing` 检查通过。浏览器不能自行批准，拒绝及断开保留原写入权。批准后两端收到同一操作，结算成功后所选 MCP 失去该会话写入权限，另一身份仍可发送。生产浏览器工作台用真实 Host、CLI 与 MCP 发起接管，CLI 读回与请求匹配的串口会话代次及 MCP 客户端。关闭发起请求的窗口后，待确认项清除，原 MCP 仍有发送权限。无头桌面 UI 用桥接替身核对请求文案及确认命令参数，并通过 190 项前端定向回归。证据见 `.cache/evidence/m2-browser-pairing/` 下的 `browser-takeover-host.log`、`browser-takeover-real-workbench-20261120-212109/`、`browser-takeover-approval-ui-retest.log` 和 `browser-takeover-frontend-regression.log`。待验收真实桌面窗口全流程及 LAN 双 Host。

Windows 独立桌面在 `f40bc2d` 通过实际配对和确认接管。所选 MCP 失去发送工具，另一身份仍在原会话完成回显。停止浏览器访问后仍可继续串口工作。原生打开、保存和焦点返回通过，签名终端回放核对 69 字节 RX 与 9 条容器记录。该轮托管无头用例在点击确认后立即读取 IPC 记录，首跑和重试均读到空数组。本机及上一轮托管无头结果保留，测试按现有异步等待原则改为观察精确确认调用，无头和四目标最终候选待复验。[Windows 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44763714623/job/136383999839) · [Windows 产物](https://github.com/YanChao001/serial-workbench/actions/runs/44763714623/artifacts/14644740514) · [无头失败](https://github.com/YanChao001/serial-workbench/actions/runs/44763714623/job/136383999371)

复审补齐了开始顺序和撤权证据。真实 Chromium 在保持草稿焦点时收到两项 MCP 活动，离开输入框后依次打开设备与工作区面板，重复查询从原活动更新。真实 Host 在浏览器只丧失指定串口写入权时清除该串口的待确认请求，许可恢复后可重新请求，并实际拒绝已被接管 MCP 的发送。证据与同轮程序摘要见 `.cache/evidence/m2-browser-pairing/browser-review-exact-20261120-221938/` 和 `browser-review-auth-host-retest.log`。

配对浏览器候选的 Windows 本机检查包括 `pnpm verify --jobs 1`、`pnpm test:ui --workers=1` 的 205 项无头用例、Host 契约与 IPC 绑定校验，以及 Host 与 MCP 等相关 Rust 包的 Clippy，均通过。本机候选指纹、托管作业结论和真实桌面收据位于 `.cache/evidence/m2-browser-pairing/` 的 `browser-candidate-*`、`browser-reviewed-*`、`ci-44770530228-terminal.json` 与 `ci-44770530228-win-native/`。

**LAN-01（独立工作树，Windows）**。两份独立 Host profile 的本机测试验证 TLS 1.3 身份、IPv4/IPv6 角色互换、越权拒绝、重启识别及撤销旧握手。A 通过现有 Rust RPC 客户端发现 B 共享的会话，在真实 Virtual Echo 上收发 5 个含 NUL、CRLF 和 FF 的字节，远端与 B 本地 IPC 的数据及 TX 回执一致。重连查询到原终态。同编号同参数返回原操作，改参数返回冲突，复查原始事件确认只有一次发送。解除配对关闭远端两个通道，本地读取保持可用。重连拒绝更换 A 的配置或在 B 重新配对后沿用旧身份。4 项 LAN、23 项 Rust 客户端及 12 项本地 IPC 回归通过。证据见 [LAN 收发用例](../crates/host/src/lan/rpc_tests.rs) 和主工作区 `.cache/evidence/m2-lan-host/lan-rpc-client-20261121-001704/`、`.cache/evidence/m2-lan-host/visible-shares-20261121-002336/`、`.cache/evidence/m2-lan-host/bound-reconnect-20261121-002603/`。两台 Windows 物理机的实际 USB 串口场景留在 M6。

**LAN 本机管理（独立工作树，Windows）**。常规 Host 启动默认关闭监听。本机用户控制连接可绑定、停止监听，设置共享和解除配对。定向用例以真实 TCP 对照普通本机及远端连接的管理拒绝，并确认停止监听关闭现有远端通道。实际 CLI 在两个独立 Host 进程上分别设置对端，验证显式启停及 B 重启换代后配对和身份保留，最后正常停止两个进程。4 项 LAN、2 项 CLI 检查、Host 与 CLI Clippy、契约与桌面绑定检查以及 TypeScript 检查通过。收据及首轮诊断见主工作区 `.cache/evidence/m2-lan-host/local-lan-management-20261121-003644/`，真实进程收据在 `cli-retry-1795193652944/checkpoint.json`。桌面管理入口、A 的应用路由、客户端身份转发、并发写入和断线租约恢复仍待验收。

LAN 工作树已迁到 `d504166`。本地 IPC、配对浏览器和 LAN 共用请求处理，各自管理附着凭据。本机管理命令仅由本地控制连接接入。Windows 复验通过 4 项 LAN、3 项配对浏览器及 58 项 Rust 客户端和 IPC 用例。两项受控子进程由父用例调度。Host 与 CLI Clippy、Host 契约、桌面绑定、TypeScript、文档和 247 项账本校验通过。源码补丁与收据见 `.cache/evidence/m2-lan-host/combined-main-20261121-010555/checkpoint.json`。

**LAN 客户端身份转发（独立工作树，Windows）**。A 用本机认证过的两个客户端打开 B 的真实 LAN 通道。B 保持共享授权由配对管理，操作主体按来源区分。两个客户端使用相同请求编号，分别得到实际 TX 回执。首个客户端重连后读回原操作，改参数重试仍发生冲突。Raw 拒绝把甲的附着令牌交给乙，解除配对关闭两者的 Control 与 Raw，本地读取继续。4 项 LAN、13 项授权及 3 项配对浏览器检查和 Host Clippy 均通过，首次编译诊断已归档。证据见 `.cache/evidence/m2-lan-host/forwarded-actor-20261121-012506/checkpoint.json`。

**LAN 应用路由（独立工作树，Windows）**。实际 CLI 与 MCP 通过 A 的本机 IPC 使用 B 的 Virtual Echo，两个 Host 使用独立进程与配置。CLI 在获准后收发相同的 5 个二进制字节，重新附着后查询终态和重复请求均返回原操作，Raw 与 B 本地读取一致。MCP 用相同请求编号执行独立发送，B 记录实际来源名称。A 撤销 CLI 的路由权限后，MCP 继续读；A 解除配对后 MCP 的现用路由失效，B 保留原会话。两个 Host 均正常退出。[进程验收入口](../e2e/lan-route.mjs)，证据见 `.cache/evidence/m2-lan-host/app-route-20261121-013907/processes-1/receipt.json`。桌面接入、A 端观看跟随、写入仲裁和断线租约恢复仍待验收。

同一工作树通过 83 项 Windows 定向回归、Clippy、Host 契约、桌面绑定和 TypeScript。两项受控子进程由父用例调度。首次 Rust 测试编译报告旧连接夹具缺少字段，补齐后复验通过。源码补丁、程序摘要和各条日志见 `.cache/evidence/m2-lan-host/app-route-20261121-013907/checkpoint.json`。

**LAN 桌面桥（独立工作树，Windows）**。无窗口用例以两份独立 Host 配置和真实 TCP 验证授权前拒绝、原连接保留、授权后发布新代次及 B 的实际收发。切换到 B 后仍从 A 读取本机配对配置，本机浏览器特权操作受限。B 连接失效后同一窗口文档按原选择重连，保持转发身份。返回本机释放旧路由，B 原会话继续运行。37 项桌面桥回归通过，类型检查和生成绑定一致。两次编译诊断与最终收据见 `.cache/evidence/m2-lan-host/desktop-route-20261121-020157/`。工作台入口和远端共享投影仍待接线，本机偏好与远端串口应分别保持原归属。

**LAN 共享设置和设备目录（独立工作树，Windows）**。桌面设置提供复制和粘贴配对信息、为已打开的串口选择共享权限、启停监听及解除配对。完成配对后用精简状态与「更换对端」代替粘贴框。窄窗 Chromium 验证实际渲染、焦点和桌面 IPC 参数，LAN 与配对浏览器的 3 项无头用例通过。真实 TCP 用例确认仅共享会话时 B 提供该串口名称和能力，隐藏硬件身份字段，收回共享后设备列表为空。5 项 LAN 与目录检查、Host Clippy、前端类型和 lint 通过。源码、截图、复验及首轮测试现场见 `.cache/evidence/m2-lan-host/lan-settings-20261121-021849/checkpoint.json`。A 的工作台连接入口、会话展示与活动跟随仍在接入。

**LAN 桌面连接归属（独立工作树，Windows）**。桌面桥保留同一窗口文档的本机连接，并独立管理远端路由、Raw 与订阅预算。真实双 Host 用例验证切换失败保留 A、切到 B 后用 A 的原连接读取共享设置、B 执行实际收发、B 的重连身份不变。返回 A 仍使用原代次，回收旧远端连接，B 的串口会话继续运行。桌面桥回归 70 项通过，4 项签名参考包用例需要准备独立运行材料，本轮跳过。生成绑定与本机收据见 `.cache/evidence/m2-lan-host/desktop-local-preferences-20261121-024503/checkpoint.json`。

**LAN 工作台连接入口（独立工作树，Windows）**。已配对的 A 可从工作台菜单使用 B 的连接信息，打开 B 已共享的串口，并从同一入口返回本机。设备和会话查询在 B，工作区与设置继续由 A 管理，窗口草稿沿用本机保存。真实双 Host 用例拒绝未配对目标和未经桌面明确连接授权的路由，随后验证合法授权、收发及返回本机。无头 Chromium 用受控 IPC 验证地址失败后重试、从设备列表立即打开共享会话、接收数据显示和切换时保存草稿。证据见 `.cache/evidence/m2-lan-host/desktop-lan-workbench-20261121-025711/checkpoint.json`。原生窗口专项待验。

**LAN MCP 活动跟随（独立工作树，Windows）**。B 发布精确会话代次的活动。实际 CLI 通过 A 的独立 Host 读到实际 MCP 的活动，与 B 本机记录使用同一身份和活动编号。真实 TCP 用例验证另一客户端收到增量，拒读 B 的全局活动，撤回共享后关闭订阅。无头工作台选择命名客户端后自动打开对应共享视图，下一项活动打开串口参数。证据见 `.cache/evidence/m2-lan-host/shared-session-activity-20261121-032551/checkpoint.json`。

**LAN 写入仲裁与断线租约（独立工作树，Windows）**。双 Host 通过真实 TCP 路由写入 B 的 Virtual Echo。A 停止后，B 按自身时钟使事务租约到期。两笔在后端派发前的交互写入结算为拒绝且没有写入字节，A 和 B 各自的独立写入完整结算，原始回显保持整帧。重启 A 后沿相同身份读回原回执，重复请求不重发。随后 B 撤销共享，A 已接纳的独立写入在后端派发前取消，新请求被拒绝，B 本机任务正常结算。此软件证据覆盖 LAN-01、NET-07 与 NET-11 的相关范围。见 `.cache/evidence/m2-lan-host/lan-lease-recovery-20261121-034007/checkpoint.json`。

**LAN 按客户端接管（独立工作树，Windows）。** 双 Host 用真实 TCP 和 B 的 Virtual Echo 验证 `session.takeover`。B 收回所选客户端在当前会话代次的写权，派发前的任务以零写入结算。同一对端的另一客户端和 B 本机均正常写入。所选客户端保持读取，重连后仍拒绝写入。B 重新授权后原编号返回取消回执，新编号成功发送。覆盖 LAN-01、NET-07 与 NET-11 的本次软件范围。证据见 `.cache/evidence/m2-lan-host/takeover-scoped-20261121/checkpoint.json`。原生桌面入口和四目标阶段 CI 待验。

**LAN 原生候选（PR #52）。** 首轮四目标原生作业在重启检查中把会话快照和活动投影计为两个会话，当时未执行 Windows LAN 桌面步骤。断言已改为定位同一会话快照。自审另修复设备共享后新会话缺少权限，以及 A 重新授权时旧路由沿用新许可。双 Host 定向验收通过远端打开后收发、按客户端接管和断线恢复，授权回归确认撤权重授后旧许可失效。[PR #52](https://github.com/YanChao001/serial-workbench/pull/52) · [首轮 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44812324987) · [运行与收据](./testing.md#桌面边界)

`e44c572` 的 Windows 预检通过重启场景、配对浏览器接管及 LAN 持口端接管。使用端已在原生窗口打开共享会话并完成收发，参数操作因测试夹具漏传会话 revision 被拒绝。夹具现用 MCP 读回的 revision 提交变更。本机两份实际 Host 经真实 MCP 核对同一会话两端均读回 `19200`。原生 Rust 缓存命中，构建从 460 秒降至 159 秒，pnpm 缓存本轮未命中。首轮 Apple Silicon 的签名任务用例把迟到调用混入就绪轮询，可能在处理器仍接受子动作时多写一笔。现使用只读探针检测子任务已接纳并开始，在取消结算后单独尝试迟到调用，Windows 本机固定 Node 定向复验通过。两条路径的本机收据见 `.cache/evidence/m2-lan-host/node-task-admission-20261121/`，原生与四目标 CI 待复验。[Windows 预检](https://github.com/YanChao001/serial-workbench/actions/runs/44816021908/job/136564449388) · [Apple Silicon 原始失败](https://github.com/YanChao001/serial-workbench/actions/runs/44812324987/job/136551772603)

`b59a0b8` 的 Windows 使用端原生用例通过配置操作接纳，随后在发送草稿聚焦时等待自动跟随超时。原生截图与编辑期间暂缓跟随的规则一致。用例明确核对聚焦草稿时的保护，移开焦点后再核对参数面板和读回值。Apple Silicon 的原始 SQLite 记录确认第二个子动作在取消接纳前 42 毫秒进入，两个子动作后来均取消。原件与只读时间线保存在同一证据目录。[Windows 使用端原始结果](https://github.com/YanChao001/serial-workbench/actions/runs/44818496752/job/136572950817)

`4e47108` 通过本机综合检查和两项 LAN 无头场景。原生预检在持口端读取参数时因 CLI 夹具未提供必需参数文件停止，焦点释放场景尚未运行。原生和本机双 Host 用例共用带目标及参数文件的查询构造，继续核对实际 CLI 回执。[Windows 读回原始结果](https://github.com/YanChao001/serial-workbench/actions/runs/44820406344/job/136579537215)

`6e7e4a6` 通过本机综合检查。Windows 原生用例完成了双 Host 收发、持口端接管、两端参数读回和移出草稿后的自动定位，返回本机时停在正常的「保存未完成工作」提示。用例现显式保存草稿，并在返回后查本机草稿和持口端会话。下一轮完整四目标 CI 执行这一原生流程。[Windows 跟随与返回原始结果](https://github.com/YanChao001/serial-workbench/actions/runs/44821990624/job/136584915400)

`93170d6` 通过本机综合检查和 207 项无头 UI 检查。Windows 原生用例在已选中命名助手后，因发送 Escape 未关闭「活动」面板而停止，尚未到达参数与返回断言。该用例改用面板已有的关闭按钮。Apple Silicon 签名终端在选择包后丢失本地 Host 控制连接，应用提示无法加载插件，Host 仍可接受独立 CLI 的正常关停。客户端日志只记录了帧读取失败。候选为 Host 私有日志补充输出失败和事件入队失败原因，继续定向复验。[Windows 原生记录](https://github.com/YanChao001/serial-workbench/actions/runs/44823571873/job/136590361674) · [Apple Silicon 原生记录](https://github.com/YanChao001/serial-workbench/actions/runs/44823571873/job/136590362066)

`0a5c6ad` 的 Windows 实际桌面完成接管、自动定位、保存草稿及返回本机，CLI 确保持口端原会话保持打开。真实打开与保存对话框均恢复主窗口焦点，签名终端回放 3 个 RX 事件共 69 字节。Apple Silicon 本次完成包安装和录制启动，主窗口确认首条 21 字节回显，独立视图确认 TX 后主动停止，未确认 RX。视图发布下一批响应前先释放读者锁，消除 WebKit 立即发起后续请求时可能遇到的锁竞争。测试记录壳的停止原因，收到停止事件时直接报告失败。具体停因与新实现待定向复验。[Windows 通过记录](https://github.com/YanChao001/serial-workbench/actions/runs/44826391351/job/136599976127) · [Apple Silicon 失败记录](https://github.com/YanChao001/serial-workbench/actions/runs/44826396611/job/136599991868)

签名终端的桌面 E2E 构建使用 `pnpm e2e:build --with-node-runtime` 准备同源测试程序及固定 Node。资源与程序一起写入构建收据。Windows 无窗口构建和 Host 接线结果记录在 `.cache/evidence/m2-node-backend/native-terminal-build-20261119/checkpoint.json`。独立环境或约定的前台时段使用 `--terminal-manual` 完成实际文件选择、关窗和重开。runner 保存签名输入和进程日志，退出后按本轮 Host 回放核对录制。窗口观察另留证据。

**Windows 签名终端原生流程（工作树）**。实际 ZIP 选择、桌面确认执行信任、显式启用、关闭终端窗、同会话继续录制、重开补读、撤权停止视图和退出均有记录。预授权录制的三个 RX 事件逐字节回放一致，共 69 字节，九条容器记录均验证完成。候选、截图、两次录制和退出日志见 `.cache/evidence/m2-node-backend/native-terminal-foreground-20261119/checkpoint.json`。首次录制在同一桌面身份运行中追加目标读取权后结算为失败，保留未完整容器。重新启用后曾需重新附着主窗口才恢复视图入口，保留待复查。此轮更新 LOG-01、AUTO-13、PERF-02、SEC-03、SEC-07、SEC-12 和 FUT-07 的本机软件证据。

**桌面目录恢复（工作树，Windows）**。修复桌面桥丢弃 `catalogChanged`。嵌入式和正式 Host 均在同一桌面连接验证显式启用、撤销执行信任及重新启用的通知与目录可见性。前端回归验证旧窗口通知和晚到目录页不会覆盖新结果。原生窗口复查仍待安排。见 `.cache/evidence/m2-node-backend/catalog-reactivation-20261119/checkpoint.json`，覆盖 AUTO-13 和 SEC-07 的软件部分。

**录制期间追加读取权（Windows）**。真实 Host 复现同一身份追加目标文件读取权导致录制以 `PERMISSION_DENIED` 结束。修复后，Host 录制绑定实际使用的源读取与目标写入权限。回归从本地控制入口追加文件读取权，再发送并回放核对 3 个 RX 字节。撤销任一录制权限都使空闲录制失败结算，立即重授仍拒绝原绑定。证据见 `.cache/evidence/m2-node-backend/capture-grant-20261119/checkpoint.json`，属于 LOG-01 和 SEC-12 的软件部分。托管 `2371213` 用原生保存框启动录制，`active-read-grant.json` 记录追加目标文件的 `content.read`，`active-read-settlement.json` 记录授权成功后录制仍为 `running`。同一运行后续校验 69 字节，覆盖开窗、关窗及重开三段 RX。[Windows 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44644885767/job/135984830398) · [产物](https://github.com/YanChao001/serial-workbench/actions/runs/44644885767/artifacts/14587179936)

**同源候选复审（工作树，Windows）**。固定 Node 候选通过终端、图表和自动化的四项真实 Host 用例。正式 Host 的终端流程通过实际 CLI、MCP 和 Claude Code，后者核对 69 个 RX 字节及撤权。`pnpm verify` 通过。全量无头 Chromium 通过 202 项，草稿输入 p95 为 106.2 毫秒，超过 100 毫秒门槛。三次单独复测中一项通过，两项失败。复审确认录制入队与撤权存在竞态，并发现原生迟到窗口和四目标签名场景的覆盖缺口。构建收据、失败样本和复审见 `.cache/evidence/m2-node-backend/capture-grant-candidate-20261119/checkpoint.json`。录制授权修复后须重新构建并验收同源候选。

**活动录制批次的撤权边界（工作树，Windows）**。在真实 Virtual Echo 的第二组 RX 入队前撤销源读取权。旧实现终态报 `PERMISSION_DENIED`，但文件仍包含第二组数据。修复后终态一致，校验实际卷只读到撤权前的 RX。录制单元及 Host 集成筛选通过 16 项，录制 API 集成通过 14 项，固定 Node 交叉场景通过 6 项。历史饱和关停用例单独复测通过，三种停止方式耗时 4.01 到 4.39 秒，整体候选复测仍待完成。关联 LOG-01 和 SEC-12 的软件部分，保留原软件状态。见 `.cache/evidence/m2-node-backend/capture-revoke-queue-20261119/checkpoint.json`。

**插件窗口的显示边界（工作树，Windows）**。窗口先隐藏初始化，显示前复核发起文档和当前 Host 连接。真实 Host 桥接回归保留同一个发起文档并更换连接，验证旧请求返回 `EPOCH_MISMATCH`，并验证连接移除与最终显示使用同一边界。桌面 Rust 库检查通过 181 项，4 项签名包专项由独立入口运行。关联 SEC-07 的软件部分。实际 WebView 显示、关闭和重新打开仍需对应平台观察。构建与本机记录见 `.cache/evidence/m2-node-backend/node-view-publication-20261119/checkpoint.json`。

**插件安装和授权界面（工作树，Windows）**。已安装列表显示名称、版本和状态，展开行查看来源与操作。「管理来源」默认收起。授权弹窗显示签名来源、工作台能力和本机执行风险。无头 Chromium 用受控桌面 IPC 核对选择签名来源、安装、信任后显式启用、撤权和安装失败提示，覆盖英文暗色与中文窄窗口。嵌入式 Rust Host 用实际签名终端包复核安装回执与列表的名称和版本、撤权后重新启用和 69 字节录制连续性。原生文件选择和新版原生窗口仍待复验。AUTO-13 和 SEC-07 的此次软件证据见 `.cache/evidence/m2-node-backend/plugin-install-ui-20261119/checkpoint.json`。

**C 图表实时采样和留存视图（候选，Windows）**。签名包将 Virtual Echo 的拆分 RX 发布为 `1.25`、`-2`、`3.5` V，保留三段原始字节范围。桌面桥可在取样任务运行中打开视图，先等待输入，再读到两个样本，任务结算后在同一视图读到第三个。重开、CLI 和实际 MCP 读页对照同一数值、会话代次及来源范围。撤权后禁止视图读页。图表和终端可以在工作台已占用 Raw 通道时打开。无头 Chromium 验证隔离视图显示缺口和样本。修复前拒绝打开及复验见 `.cache/evidence/m2-node-backend/chart-live-sampling-20261120/checkpoint.json`，视图原验证见 `.cache/evidence/m2-node-backend/reference-chart-view-20261119/checkpoint.json`。这次覆盖 AUTO-13 和 VIZ-16 的软件部分。

**C 原生图表窗口（`bfd5767`）**。Windows WebView2、Linux WebKitGTK 和 Apple Silicon WKWebView 分别通过签名安装与实际隔离窗口场景。工作台发送的第一项 `1.25` V 在开窗时由 iframe 确认，关窗后发送的两项在重开时一并读出。切换工作台与插件页后仍使用同一采样任务，各自两次窗口都正常关闭。三份 `chart-window.json`、构建收据和原始日志见 `.cache/evidence/m2-node-backend/native-chart-window-20261120/checkpoint.json`。这是 AUTO-13 和 VIZ-16 的软件证据。此轮运行图表专项，四目标候选与实机继续按阶段验收。[Windows](https://github.com/YanChao001/serial-workbench/actions/runs/44633063233/job/135944487697) · [Linux](https://github.com/YanChao001/serial-workbench/actions/runs/44634041074/job/135947868169) · [Apple Silicon](https://github.com/YanChao001/serial-workbench/actions/runs/44634047514/job/135947888641)

**连接失效后的插件窗口（`3595b2b`，Windows x64）**。签名图表重开后读到同一任务的 `1.25`、`-2`、`3.5` V。runner 实际停止旧 Host，重开的原生窗口随旧连接销毁。新 Host 使用同一身份及更高代次，两次 Host 退出正常。本机桥接回归确认同一主窗文档的旧连接结束能通知旧视图，新连接保有独立的寿命。这是 SEC-07、AUTO-13 的 Windows 软件证据。收据和原始窗口事件见 `.cache/evidence/m2-node-backend/host-view-retirement-3595b2b/checkpoint.json`。[原生图表预检](https://github.com/YanChao001/serial-workbench/actions/runs/44648236146/job/135996248761)

**签名终端慢读者与大帧（候选，Windows x64）**。视图队列曾与在途额度共用 512 KiB，正常订阅遇到协议允许的 128 KiB TX 事件时无法分配编码空间，恢复时返回 `NOT_FOUND`。队列改用 Host 宣告的每读者预算，在途额度继续单独限制。签名包用例暂停确认期间通过 Virtual Echo 写入 2,490,368 字节，验证实际缺口范围及后续 RX，并逐字节核对 131,072 字节 TX 意图。原录制场景回放 69 字节通过。无头 Chromium 使用实际可信壳和公开 SDK 终端组件核对中文缺口提示及恢复后的正文。相关 AUTO-13、PERF-02 软件证据及首轮失败见 `.cache/evidence/m2-node-backend/signed-terminal-slow-reader-20261120/checkpoint.json`。

**C 自动化后台参考包（候选，Windows）**。公开 SDK 提交同一会话的发送子动作，按实际发送回执和 RX 来源范围核对每步应答。实际签名包在嵌入式 Rust Host 上通过双步骤匹配。应答不符、收到前缀后超时、等待应答时取消都只执行首步。取消用例先等真实 RX，再核对取消接纳回执和父动作终态。Virtual Echo 录制回放逐字节核对 32 字节和会话代次。实际 MCP 程序随后执行一步，CLI 读到同一结果字节和来源。Host 目录现能按会话读取授权公布结果读取工具，撤权后 MCP 无法调用，CLI 的独立授权继续有效。覆盖 IO-10、AUTO-05、AUTO-13 和 SEC-12 的软件部分。首轮目录错误和三项定向复验见 `.cache/evidence/m2-node-backend/automation-client-parity-20261120/checkpoint.json`，录制原证据见 `.cache/evidence/m2-node-backend/reference-automation-20261119/checkpoint.json`。窗口、三平台离线安装及完整 C 场景继续验收。

**C Debian 离线安装（`904ed8c`，Ubuntu 22.04 x64）**。在无 IPv4/IPv6 地址和路由的独立网络命名空间实际安装 `0.1.0`。安装后保留私有 `libatomic.so.1` 相对链接。普通用户通过安装版 Host、CLI 和 MCP 执行签名终端，回放 69 字节并确认 Host 正常退出；图表和自动化用已安装 runtime 与客户端通过实时采样、结果一致和录制用例。三个用例用时 27.88 秒，Rust 与 pnpm 缓存均命中。这是 T14、AUTO-13、SEC-01 和 SEC-11 的 Ubuntu 软件证据。首轮在归档路径查找时失败，第二轮安装成功后 Host 拒绝被解引用的私有库链接。两个失败和最终安装收据见 `.cache/evidence/m2-node-backend/debian-offline-installer-20261120/checkpoint.json`。原生窗口、其他安装包格式和正式发行安装器继续按阶段验收。[Ubuntu 离线预检](https://github.com/YanChao001/serial-workbench/actions/runs/44618907763/job/135895042980)

**C macOS DMG 离线安装（`73afcdc`，15.8.2 arm64 / 15.7.9 x64）**。两种架构均确认 Seatbelt 拒绝 IPv4 和 IPv6 连接并保留本机 Unix IPC。实际挂载 `0.1.0` DMG，确认仓库内置许可证，复制应用并卸载映像。各自的三个伴随程序摘要与组件收据相符。签名终端由安装版正式 Host 执行，回放 69 字节并确认退出；图表和自动化使用已安装 runtime 和客户端通过实时采样和 32 字节录制场景。各三个用例分别用时 28.75 和 28.27 秒，两轮 Rust 与 pnpm 缓存均命中。Intel 的组件编译、桌面编译、测试程序编译分别用时 236、322、267 秒。首轮缺少用于组件收据的 `.app`，次轮在内置许可证提示处取消。修正后先完成安装，再用实际安装目录的映像编译测试程序。T14、AUTO-13、SEC-01 和 SEC-11 的本次软件证据见 `.cache/evidence/m2-node-backend/macos-offline-installer-20261120/checkpoint.json`。原生窗口、最低支持系统、正式签名和公证继续验收。[Apple Silicon 离线预检](https://github.com/YanChao001/serial-workbench/actions/runs/44625635016/job/135918712553) · [Intel 离线预检](https://github.com/YanChao001/serial-workbench/actions/runs/44627559546/job/135925452105)

**四目标签名包用例（工作树）**。在现有四目标 CI 的原生 runtime 验收步骤中加入图表和自动化，三种参考包共用一次签名工具构建。任务分别保留签名包、签名收据与实际用例日志。Windows 本机用已构建的 runtime、正式 Host、CLI 和 MCP 复跑了三包签名与四个真实 Host 用例。首次本机复跑的伴随程序路径配置失败也已保留。见 `.cache/evidence/m2-node-backend/reference-ci-recheck-20261119/checkpoint.json`。四目标托管 CI 仍待运行。

**本机 B 候选（工作树，Windows）**。窗口与录制授权修复的同源候选通过 `pnpm verify`、203 项无头 Chromium 及四项签名包专项。草稿输入 p95 为 84.6 毫秒，保留旧候选的失败样本。实际 Windows ZIP 选择、签名提示、运行授权、显式启用通过。前台运行在录制前超时，已核对测试进程退出和临时任务删除。证据见 `.cache/evidence/m2-node-backend/node-view-publication-20261119/checkpoint.json`。

**四目标桌面签名场景（候选）**。原生工作流复用固定 Node 构建，在原有桌面用例之外运行签名终端自动化。Windows 真实窗口通过签名安装、运行授权、显式启用及录制中追加读取权，授权结算后录制仍运行。随后重返插件页触发读取失败，原生终端未打开。无头回归按 Host 的两个共享读取槽复现列表与详情并发失败，改为各自顺序读取后通过。修复后的实际文件选择、关窗重开和撤权仍待复验。候选已集中提交，最新本机综合检查与四项签名 Host 专项通过。收据、失败截图和正式 Host 的 69 字节回放见 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/checkpoint.json`，关联 LOG-01、AUTO-13、SEC-07 和 SEC-12 的软件部分。[草稿 PR #49](https://github.com/YanChao001/serial-workbench/pull/49)

**大草稿输入（候选，Windows）**。全量无头 Chromium 的两轮草稿输入 p95 分别为 184.9、109.1 毫秒，均超过 100 毫秒。性能追踪定位到粘贴期间的布局开销。编辑框布局隔离的三组本机对照中，p95 中位数由 77.2 降至 66.0 毫秒，输入框测得的矩形一致。加入布局隔离后全量复测通过 202 项，草稿输入 p95 为 110.7 毫秒。保持原门槛、CPU 降速和样本量。关联 PERF-02 的软件部分，原始采样和失败保存在同一证据目录。

**首轮四目标 CI（候选）**。前端综合检查、IPC 绑定检查以及托管无头 Chromium 的 203 项用例通过，草稿输入 p95 为 80.3 毫秒。Windows x64 和 Linux x64 的真实桌面作业均通过，签名终端录制回放同一会话的 69 字节，并观察到重开补读、撤权中止和读者预算归还。两个 macOS 架构的 Clippy 与原生构建均因未声明的日志库失败，已改用 Host 的标准错误诊断。Windows 和 Linux 的 Clippy 发现签名终端测试中的冗余克隆，改为用借用切片断言后本机复查通过。保留各目标的失败和产物，完整四目标继续复验。[首次 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44483357907)

**合并桌面验收构建（候选）**。首轮 CI 中的独立签名工具构建重复编译 Windows 的 91 个和 Linux 的 85 个 crate，分别耗时 121 秒和 65 秒。Windows 本机实跑验证一次 Tauri 构建可同时产出桌面程序、签名工具和录制核对工具。四目标流程已改为复用这批工具，收据同时核对两个工具的路径和摘要。下一轮记录工具编译、缓存和桌面各阶段耗时。原桌面测试、签名流程和录制回放门槛均纳入本轮复验。

**第二轮四目标 CI（`d5eaa63`）**。无头 Chromium 203 项通过，草稿输入 p95 为 68.6 毫秒。Windows x64 和 Linux x64 原生桌面复跑通过。桌面与签名准备总耗时分别由 518 秒降到 356 秒、由 338 秒降到 232 秒，两台 runner 均命中 pnpm 缓存，Rust 桌面缓存未命中。两种 macOS 架构的单元测试发现本地 IPC 和插件资源夹具经临时目录别名访问被拒绝，测试改用已解析的临时根。两种架构的原生签名终端均在撤权步骤失败，Host 报无法确认 Node 退出。arm64 产物确认录制中追加读取权和关窗回收已通过，Host 关停超时。`artifacts/e2e` 收据、截图和私有日志保留到本地证据目录。针对 XNU 对仅留 zombie 的进程组可能返回 `EPERM` 的行为，修正停止判定并增加待实际运行的回归。继续核对两种架构的撤权及正常退出。[第二轮 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44493616201)

同轮 Ubuntu x64 的 workspace、离线六场景含 600 秒负载和 11 项固定运行时用例通过。Rust 作业随后达到 60 分钟上限。日志在终止前标出了初始图容量回收和签名升级后保存 Schema 重放两项失败，用例的完整断言仍待取得。产物见 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/second-host-offline-linux/` 和同目录的 `repaired-ci-rust-linux.log`。

**Windows 新版真实文件选择（`d5eaa63`）**。在已安排的本机前台，以普通桌面权限和独立 Host profile 打开真实 ZIP 对话框。返回主窗后已确认插件名称、版本和等待授权状态。随后连接 Virtual Echo 时 Windows 报主窗未响应，录制保存对话框未到达。截图、Host 日志和退出记录见 `artifacts/e2e/signed-terminal-limited-kE5a0S` 和 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/checkpoint.json`。随后发现并终止仍在占用内存的测试诊断 PowerShell，系统可用内存由约 4.0 GiB 恢复至 18.3 GiB。测试应用、Host 和临时启动任务已退出。窗口未响应的原因仍待复验。

**自动化任务取消（第二轮 CI）**。Windows 正式运行时中的签名参考包通过匹配、不匹配和超时场景，等待应答时的取消被记为 `NODE_ACTION_FAILED`。同版本 Node bootstrap 用受控私有帧复现 Raw `CANCELLED` 回执先到、取消控制帧尚未到达的情形。修复前回报 `action_failed`，修复后回报 `action_cancelled`。Host 仍核对是否已接受实际取消，保留等待真实终态和已经发生的晚成功。原生 Raw 回归现要求任务信号先于拒绝可见。日志见 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/repaired-ci-rust-windows.log` 和同目录的 `raw-cancel-red.log`、`raw-cancel-green.log`，关联 AUTO-05、AUTO-13。完整参考包和多平台回归待同一候选通过。[第二轮 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44493616201)

**第三轮四目标 CI（`2d81948`）**。四个目标的签名终端原生桌面场景均通过，确认录制中追加读取权、关闭与重开、撤权、正常关停，以及各自同一会话的 69 字节回放。无头 Chromium 203 项通过，草稿输入 p95 为 51.7 毫秒。四目标桌面 Rust 缓存均命中，Windows 和 Linux 的桌面构建与签名准备分别耗时 171 秒和 97 秒。Windows 的 `device_runtime` 单元测试发现上一轮正在结束的枚举可能满足较新的手动刷新，得到旧 COM 号。目录刷新按请求开始时的枚举代次等待新结果，保留单一枚举线程。新增夹具暂停已取得旧编号的枚举并等待复验，关联 CONN-02 的软件证据。完整运行时专项和 Windows 原生文件保存对话框仍需复验。[第三轮 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44502225790)

**设备刷新与 Ubuntu CI（候选）**。`6fb7fd7` 的 Windows `device_runtime` 17 项通过，包含固定旧枚举与新请求顺序的回归，日志见 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/device-refresh-runtime.log`。第二轮 Ubuntu 的 workspace 测试、离线负载、未签名构建分别耗时 358、616、214 秒，原生运行时检查又运行 2036 秒后被作业上限中止。Linux x64 的 108 项 `verified_backend_` 用例移到独立必跑作业，同时保留原测试顺序、断言和作业上限。门禁用例核对漏跑或失败会拒绝候选，远程实际执行、覆盖及耗时待验证。

**原生后台重新启动耗时（候选）**。第三轮 macOS arm64 的失败日志及 SQLite 收据确认，容量释放后的启用在等待期限内仍为 Running，兼容升级已经提交且新运行时代次仍为 Starting。Intel macOS 与 Ubuntu 也记录同名用例失败。两条路径在首个后台 owner 释放后均重新走固定 Node 校验。在 Windows 对同一份 100,097,864 字节文件各测六次，优化 `sha2 0.10.9` 后摘要耗时中位数从 1.852 秒降到 0.082 秒，逐次摘要一致。仅调整开发及测试构建的该依赖优化等级，原资源校验顺序和用例等待期限继续适用。Windows 固定 Node 的两项原生用例复跑通过，容量释放后重新启用成功，升级后保存 Schema 仍可重放。现场、测量和复跑见 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/` 下的 `combined-runtime-arm64-failures`、`runtime-sha-and-arm64-profiles.json` 与 `optimized-runtime-package-windows.log`。实际 Linux 和 macOS 启用及升级耗时待同一候选验证。

**同源复审（候选）**。`2aa8d85` 的 Windows `pnpm verify --jobs 1` 通过。复审发现 macOS `libproc` 的零返回也可能携带真实错误。读取进程组现在清除旧 `errno`，并让本次查询错误阻止回收确认。新增 macOS 用例直接核对内核查询错误，待两种架构实跑。新增脚本回归用真实 Node bootstrap 固定数据回执先到的顺序。同一用例用 `d5eaa63` 的 bootstrap 得到 `action_failed`，用当前 bootstrap 得到 `action_cancelled`。原生 Host 仍须核对已接受取消后的实际结算。原始日志为同目录的 `runtime-sha-exact-verify.log` 和 `raw-cancel-tracked-test-{red,green}.log`。[Apple libproc 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.81.4/libsyscall/wrappers/libproc/libproc.c#L41-L77)

**独立 Linux 签名后台作业首跑（`d69ebea`）**。108 项均执行完毕，用例总耗时约 39 分钟，106 项通过。容量释放后启用仍停在 Running，兼容升级后注册仍停在 Starting。该作业取自摘要优化前的候选。失败日志保存为同目录的 `split-ci-linux-backend.log`，优化后的同源候选仍须通过这两项及完整四目标门禁。[独立 Linux 作业](https://github.com/YanChao001/serial-workbench/actions/runs/44510694314/job/135519288809)

**Ubuntu 原生清理夹具（候选）**。`d69ebea` 的 Ubuntu 核心作业通过离线六场景与 600 秒负载。在 worker 原生清理用例里，子进程返回时还未写出启动标记，随后断言超时，作业未完成余下用例。夹具在 Linux 通过活动进程的 `/proc/<pid>/exe` 引用同一个密封 Node 映像，并在子进程提前返回时记录状态和结束等待。Windows 固定 Node 定向用例通过，确认真实回收、操作终态和重放，Ubuntu 原生结果待复验。日志为同目录的 `split-ci-rust-linux.log` 和 `worker-native-cleanup-windows.log`。[Ubuntu 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44510694314/job/135519288903)

**本机综合及无头 UI（`8cbc7e7`）**。Windows `pnpm verify --jobs 1` 通过。无头 Chromium 202 项通过，草稿输入 p95 为 100.4 毫秒，未达原 100 毫秒门槛。两次超阈值均出现在大段插入，纯原生文本框对照也出现一次 272.9 毫秒尖峰。保留各次样本和截图，继续定位应用开销及帧调度。当前远程 Ubuntu 签名后台、Rust、桌面、绑定及浏览器作业在下载依赖时退出，对应测试未运行。证据为同目录的 `runtime-supervision-exact-{verify,ui}-result.json`、`runtime-supervision-exact-ui-failure` 及五份 `runtime-supervision-*-first.log`。[同源四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565)

**草稿输入全文读取（候选）**。两轮无头诊断均测到 40 次输入触发 120 次文本框全文读取。输入事件已获得原生正文，复用该值后两轮均为 80 次。外部草稿切换、清空及格式转换继续同步到文本框。草稿与工作台 67 项相关测试通过。带读取探针的 p95 样本为基线 78.3、69.9 毫秒及候选 77.0、70.4 毫秒，留作诊断；100 毫秒门槛继续用于原全量 UI。诊断日志为同目录的 `composer-draft-read-{baseline,candidate}.log`。

**定向及完整候选结果**。`a9993db` 的 Linux 原生预检中，108 项签名后台和 73 项原生 Host 用例通过，确认实际回收 Node 及其子进程。摘要优化后的 Windows 后台 108 项通过，套件耗时由 847.08 秒降至 212.49 秒；macOS arm64 后台 109 项通过，两端原有启用及升级异常均复验通过。原生后续阶段仍有 Windows 恢复夹具连接关闭、macOS arm64 派生动作等待超时及 Intel macOS 安装布局启动失败。`b244f58` 本机综合校验通过，全量无头 UI 202 项通过，草稿输入 p95 为 116.8 毫秒，原生对照为 36.9 毫秒。保留同目录 `composer-read-exact-ui-failure` 的完整样本。[Linux 预检](https://github.com/YanChao001/serial-workbench/actions/runs/44524927406) · [四目标候选 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565)

**恢复夹具在途查询（候选）**。Windows CI 恢复测试报告本地连接关闭。客户端禁止在请求帧部分写入后继续复用连接，夹具现在保留竞争中未完成的查询，继续检查旧恢复与新启用的顺序、实际代次与重放。改动前本机短测另有一次等待超时，保留的 SQLite 记录显示该启用随后成功。修订后本机定向复跑三次均通过，完整候选待验。见同目录的 `recovery-query-baseline-profile.json` 与 `recovery-query-preserved-result.json`。[Windows 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565/job/135550786712)

**macOS 两处失败复验（候选）**。Intel 的安装布局收据为 `NODE_RUNTIME_INTEGRITY_FAILED`，原因 `processSignature`，未读到签名状态和代码目录摘要，已回收子进程。补记两次系统调用的各自错误码到私有诊断。arm64 失败数据库显示并发发布已结算，随后用于验证留存和游标过期的 66 次顺序发布仍在运行。增加分段进度并保留对应失败日志。Windows 定向场景通过，66 次耗时 3.108 秒，因缺少伴随二进制跳过本次 CLI、MCP 分支。5 秒等待期限及原有断言继续适用。原始摘录及本机日志见同目录的 `intel-startup-excerpt`、`arm64-derived-excerpt` 和 `derived-retention-timing-windows.log`，两个 macOS 目标待定向复验。[Intel 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565/job/135550786626) · [arm64 原生作业](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565/job/135550786477)

**草稿事件分段诊断**。同一生产浏览器产物、同一文本框，以单 worker 交替测量正常事件与仅保留原生编辑。正常路径的事件处理 p95 为 16.0、23.9 毫秒，输入到下一帧为 72.6、76.2 毫秒。仅保留原生编辑时测得 77.6、123.1 毫秒。绕过事件处理后仍出现慢帧，继续测量浏览器布局与帧等待。原始结果为同目录的 `composer-dispatch-{1,2,3,4}.log`；绕过应用事件的测量只用于诊断。

**Windows 实际文件对话框（候选）**。在独立 Windows 原生预检保留原签名终端夹具，并另外用系统对话框运行同一场景。辅助程序观察已持有的应用 PID、窗口所有者以及对话框关闭后的实际前台焦点。安装和保存路径、录制、重开与撤权由该次场景核对。此入口待托管 Windows 实跑。本机前台观察和缩放验收仍按原记录核对。

**macOS 定向预检结果（`6078e4d`）**。Intel 的安装布局、签名运行和回收本轮通过，运行时单项 9 项、签名后台 109 项通过。随后 73 项原生 Host 套件在 25 分钟作业时限到达前未全部完成。Apple Silicon 首次排队 15 分钟后被取消，未获得 runner，已重试同一提交。关键收据和日志见同目录的 `intel-preflight-6078e4d-receipts`、`intel-preflight-6078e4d.log` 与 `mac-arm-preflight-cancelled-job.json`。[Intel 预检](https://github.com/YanChao001/serial-workbench/actions/runs/44534980614) · [Apple Silicon 预检](https://github.com/YanChao001/serial-workbench/actions/runs/44534992880)

**预检构建与派生页（候选）**。Intel 预检单独构建探针用时 336 秒，再构建 CLI 和 MCP 用时 145 秒，两个步骤重复编译了 `core`、`ipc` 和 `client`。三个入口合并后，Intel 托管构建用时 222 秒，三个依赖在构建步骤各编译一次。提前设置两入口路径，让原生 Host 用例实际执行读页分支。本机同源 CLI 与官方 MCP SDK 读到相同的四个派生样本和完整事件、字节来源，66 次留存用发布耗时 3.151 秒，录制回放仍逐字节匹配。此轮覆盖 VIZ-16 的派生来源部分，原字节、字段和曲线界面联动继续按 M3/M4 验收。日志及样本见同目录的 `runtime-preflight-combined-build-windows.log`、`runtime-preflight-combined-derived-pages.log`、`runtime-preflight-combined-derived-pages` 和 `intel-combined-preflight-c847aa5.log`。[Intel 合并构建预检](https://github.com/YanChao001/serial-workbench/actions/runs/44542888095)

**Windows 托管对话框首次实跑（`4ab7c75`）**。原有桌面和签名夹具场景通过，录制回放验证完成。新增实跑取得所属应用的实际前台打开对话框，控件匹配失败，未选择 ZIP，也未到达保存。修订用原生控件 ID 和可访问编辑控件定位，并在失败时保留控件信息。原始日志与产物见同目录的 `windows-native-picker-preflight.log`、`windows-native-picker-first-artifact`。[首次 Windows 预检](https://github.com/YanChao001/serial-workbench/actions/runs/44540563836)

**平台定向复验（候选）**。Windows 再次取得实际打开对话框，文件名控件定位仍失败，未选择 ZIP 或到达保存。补查 `FileNameControlHost` 及容器的 ValuePattern，继续检查窗口所属进程及前台焦点。Intel 的安装布局和故障场景通过，签名后台运行 643 秒后为 108 项通过、1 项 `processSignature` 失败。后台启动补记签名系统调用错误码到私有日志，认证和回收照常执行。Apple Silicon 的原生 Host 套件为 71 项通过、2 项失败。派生留存的第 16 至 48 次发布平均约 83 毫秒，5 秒到期时还在发布。另一项自动恢复在探测时尚未取得新代次注册。夹具改为等待现有断言要求的代次和已签名归档。旧记录见同目录 `windows-native-picker-second-artifact`、`intel-combined-preflight-c847aa5.log`、`arm64-preflight-6078e4d-attempt2.log` 和 `arm64-attempt2-excerpt`。[Windows 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44543984091) · [Apple Silicon 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44534992880)

**私有管道性能复测（候选，Windows）**。改为入队与结果就绪唤醒，Unix 等待管道可读写。Windows 两轮同场景的 66 次留存发布由 3.180、3.221 秒降至 0.176、0.163 秒，均检查 Raw、控制、录制及实际 CLI/MCP 读页。Host 与 Node 自动恢复各通过一次，Raw 四名额压力和撤权后实际回收分别通过。保留 5 秒 Operation 等待和 100 毫秒无头输入门槛。记录见同目录 `derived-pipe-baseline-windows-{1,2}.log`、`derived-pipe-wakeup-windows-{1,2}.log`、`owner-restored-generation-windows.log` 和 `raw-wakeup-and-revocation-windows.log`。后续先在实际架构分别运行 Host 管道和 macOS 签名定向套件，再复验完整四目标门禁。

**定向预检结果（`353df06`）**。Apple Silicon 的派生、Raw 及两项自动恢复均通过，66 次留存发布耗时 0.108 秒。Intel 的签名后台单项通过，安装布局探针查询进程签名状态和代码目录均返回 `ESRCH`，探针确认已回收。Windows 基础桌面用例通过，签名终端在关窗持续录制、重开及停止录制后未能展开撤权菜单，实际文件对话框分支未运行。本机单 worker 的无头草稿输入 p95 为 117.7 毫秒，原生文本框对照为 112.1 毫秒，每组各有两个 100 毫秒及以上样本。保留失败收据、截图及 `focused-ci-353df06-checkpoint.json`。[Apple Silicon](https://github.com/YanChao001/serial-workbench/actions/runs/44549651778) · [Intel macOS](https://github.com/YanChao001/serial-workbench/actions/runs/44549659285) · [Windows](https://github.com/YanChao001/serial-workbench/actions/runs/44549668063)

**录制工具还焦与验签退出状态（候选）**。嵌入式 WebDriver 在发出 DOM 点击后才请求焦点，旧版录制工具会把先前获得焦点的元素作为还焦目标。本机同样的无头点击已复现还焦失败。录制工具现直接记住打开它的按钮，原生用例等待还焦后再进入插件页，核对「更多操作」按钮已获焦且菜单展开再撤权。新版浏览器产物通过录制和插件页的 10 项相关用例。macOS 监护通过已有私有通道补记恢复运行前观察到的退出原因，探针保留首个 I/O 错误与回收诊断。仍按原门槛复验签名和真实桌面。源码、截图及结果见同目录 `capture-focus-baseline.log`、`capture-focus-baseline`、`capture-focus-build.log` 与 `capture-focus-candidate.log`。

**新版定向复验（`c28e1bf`）**。本机 `pnpm verify --jobs 1` 通过，192.1 秒。受限环境首轮有两项自有进程终止脚本失败并挂起，已保存 `.cache/verify/run-FqGcc0` 并确认自有测试树退出。Intel 的签名后台单项、原生安装布局和诊断场景通过，本轮未复现 `ESRCH`。Windows 基础桌面和原生签名终端通过，实际回放 69 字节；额外的真实打开对话框取得了确认控件，但 UI Automation 未提供文件名 ValuePattern，未选择 ZIP，也未执行真实保存。备用路径仅枚举已确认的所属对话框的子窗口，在已知文件名控件下用 Win32 写入并读回路径，仍检查确认前后的实际前台窗口。证据见同目录 `capture-focus-c28e1bf-verify-native-process.log` 和 `windows-c28e1bf`。[Windows 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44555182966) · [Intel macOS 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44555191954)

**无头 UI 与 Windows 真实文件名（`dab02d5`）**。本机无头 Chromium 203 项通过，输入 p95 为 96.4 毫秒。托管 Windows 基础桌面和签名终端复跑通过，再次逐字节验证 69 字节回放。真实对话框已通过原生编辑框写入和读回 ZIP 路径，确认后未同时观察到对话框关闭和所有者复得前台焦点，真实保存未执行。候选补记对话框可见性与前台所有者，并为原生编辑框使用同一对话框的原生确认按钮。证据见同目录 `dab02d5-headless-ui.log`、`dab02d5-headless-ui` 和 `windows-dab02d5`。[真实对话框复验](https://github.com/YanChao001/serial-workbench/actions/runs/44557849724)

**Windows 实际文件对话框（`405e584`）**。本机 `pnpm verify --jobs 1` 通过，184.1 秒。托管真实打开和保存均取得原生收据，焦点回到同一所有者窗口。录制实际写到保存框预填的默认 `.swb` 文件，指定的录制目标未生效。修订向保存框发送逐字符输入、读回文本后再确认，由 Host 继续核对实际登记的录制路径。原有选择夹具场景的 69 字节回放通过；真实保存路径、同轮回放和四目标候选仍待验收。证据见同目录 `windows-405e584/signed-terminal-CEPdfL` 与 `405e584-verify.log`。[托管复验与产物](https://github.com/YanChao001/serial-workbench/actions/runs/44562449533)

**Windows 原生控件复验（`534bbd5`）**。本机 `pnpm verify --jobs 1` 通过，185.5 秒。托管选择夹具场景的 69 字节回放通过，真实打开的辅助进程到 30 秒上限未返回，未执行保存输入。移除 UI Automation 查询，沿用已观察到的 Win32 原生编辑框和确认按钮，记录找窗、控件、输入与确认的进度及子进程退出原因。保留原超时、所有者焦点及 Host 实际录制目标校验。证据见同目录 `windows-534bbd5` 与 `534bbd5-verify.log`。[托管复验与产物](https://github.com/YanChao001/serial-workbench/actions/runs/44564679118)

**Windows 辅助进程启动（`659c43f`）**。本机 `pnpm verify --jobs 1` 通过，190.5 秒。托管选择夹具场景的 69 字节回放通过，真实打开的辅助进程在 30 秒后被终止，初始化后的首条进度未出现，真实保存未执行。候选将对话框辅助程序提前编译并在桌面构建前自检，打开和保存通过已有 Win32 路径直接调用同一程序，便于定位准备与实际窗口操作。本机确认可编译出辅助程序，原生行为待托管复验。证据见同目录 `windows-659c43f/signed-terminal-uJ7TBb` 与 `659c43f-verify.log`。[托管复验与产物](https://github.com/YanChao001/serial-workbench/actions/runs/44567109656)

**Windows 文件名输入（`30fac96`）**。托管辅助程序编译和自检通过，打开进程能找到真实对话框、核对编辑框文字并提交确认。确认后对话框仍可见，保存未执行。原生选择夹具场景再次逐字节回放 69 字节。候选改用系统键盘输入，操作前核对实际编辑焦点，录制仍按 Host 登记的真实目标校验。本机 `pnpm verify --jobs 1` 通过，169.2 秒。无头 UI 202 项通过，草稿输入第二慢值 102.8 毫秒，未过原门槛，两次超时分别为按键和大段插入，最邻近秩为 96.4 毫秒。日志与样本见同目录 `windows-30fac96/signed-terminal-59EWyX`、`30fac96-verify.log` 和 `30fac96-headless-ui`。[托管复验与产物](https://github.com/YanChao001/serial-workbench/actions/runs/44571922710)

**Windows 键盘焦点（`13fcf45`）**。选择夹具场景再次回放 69 字节。真实打开定位到原生编辑框和确认按钮，要求编辑框获得焦点的步骤失败，未输入路径。候选沿用英文系统文件对话框的文件名快捷键，并核对焦点是否落到该编辑框或其所属组合框。真实文件选择及同一会话回放仍待复验。日志见同目录 `windows-13fcf45/signed-terminal-f2Kc6p`。[托管复验与产物](https://github.com/YanChao001/serial-workbench/actions/runs/44574640101)

**发送字节编码（候选）**。权限预检和真实发送共用同一 Base64 编码路径。支持原生方法的浏览器直接编码字节，旧版 WebView 分段生成字节字符串。360,464 字节样本的 Node 微基准中，原权限预检转换中位数 11.8 毫秒，原生路径约 0.05 毫秒。两条路径与旧编码字节一致，112 项相关单元用例和类型检查通过。同条件单 worker 无头输入定向对照的 p95 为 150、45.5 毫秒，原生对照也有慢帧。作为定向证据保存，完整无头 UI 仍须复验。见同目录 `draft-base64-{focused,browser-baseline,browser-candidate}.log`。

**Windows 真实文件与录制（`2505273`）**。实际选中签名 ZIP、保存到 `terminal.swbcap`，两次均还焦到同一所有者窗口。关窗录制、重开和撤权通过。回放核对同一会话的 3 个 RX 事件和 69 个字节。收据见同目录 `windows-2505273/signed-terminal-KFOjf8`。[Windows 原生预检](https://github.com/YanChao001/serial-workbench/actions/runs/44576692235)

**同源综合与四目标 CI（`2505273`）**。本机 `pnpm verify --jobs 1` 通过，用时 156.5 秒。无头 Chromium 本机通过 202 项，输入 p95 为 106 毫秒。托管通过全部 203 项，输入 p95 为 38.9 毫秒。常规套件现只测实际编辑器，原生对照按需运行。两种模式定向实测分别得到 40 与 80 次采样，应用 p95 分别为 100.2 毫秒（失败）及 95.8 毫秒（通过），保留 `composer-control-opt-*`。托管前端综合测试同步读取异步通知失败，改为等待提示显示后继续原断言，本机相关 62 项通过。Intel 原生桌面在启用终端时记录 `CLD_STOPPED` 后误走退出回收，保留 `intel-2505273/signed-terminal-4Ew4s6/host-0.log`、失败截图和退出记录，候选仅按退出事件收尾，待同架构验证。[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44578128661)

同轮 Windows Rust 在传输进度订阅的 500 毫秒夹具期限退出。候选将首块之后的发送排到观察窗口之外，收到已持久化的首块进度后立即取消，仍验证订阅在传输进行期间发布。本机 `operation_visibility_host` 的 8 项均通过。[失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44578128661/job/135751108268)

两种 macOS 的签名后台各通过 108 项，均在退出报告缺少私有动作异常文本时失败。`a738621` 在收尾时读完 Unix 非阻塞管道中的诊断，再结束读取线程。Apple Silicon 同源复验通过全部 109 项，包括该动作异常用例，实际 Host 专项另通过 73 项。Intel Rust 仍待同源确认。[失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44578128661/job/135751108276) · [Apple Silicon 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44583914686)

**Intel 复验及已有参考包证据**。`ce603c4` 在 Intel macOS 完成签名终端启用、关窗录制、重开与撤权，回放同一会话的 69 字节，收据在 `intel-ce603c4/signed-terminal-6fGcRO`。`2505273` 的 Apple Silicon 和 Linux 桌面也完成 69 字节回放。该提交的 Linux 安装布局通过两个终端、一个图表及一个自动化的真实 Host 用例，三包签名 ZIP 和日志保存在 `linux-2505273-runtime/artifacts`。其余架构须完成同源验证。[Intel 原生复验](https://github.com/YanChao001/serial-workbench/actions/runs/44582705913) · [Linux runtime 验收](https://github.com/YanChao001/serial-workbench/actions/runs/44578128661/job/135751108305)

**本机候选与 Windows 缩放**。`4222ccb` 的 `pnpm verify --jobs 1` 用时 157.7 秒，无头 UI 203 项全部通过。应用输入 p95 为 98.9 毫秒，最慢一次为 183 毫秒，样本见 `4222ccb-headless-ui`。下一候选将 Windows 隔离视图缩放快捷键与主窗口对齐，桌面编译检查通过，实际焦点与可读性待原生观察。完整四目标的 Windows 作业在既有桌面构建中执行真实文件对话框场景，复用上轮通过的测试入口。编译收据见 `windows-plugin-zoom-check.log`。

**Windows 原生键盘缩放（`2371213`）**。托管 Windows x64 的主窗和独立签名终端窗分别通过系统键盘放大与恢复，WebView2 实测为 100% → 110% → 100%。插件窗确认收到了关窗前和关窗期间的 RX 后拍摄，两张图中的同一终端正文均清楚可读。实际打开和保存回到同一所有者窗口，撤权及 69 字节录制回放通过。这是 UX-02、UX-10、UX-14 的部分软件证据。首轮文件名夹具错选控件和次轮加载中截图均保存在 `.cache/evidence/m2-node-backend/windows-terminal-zoom-20261120/checkpoint.json`。最后一轮定向作业省去上一轮耗时 84 秒的基础桌面步骤，签名场景为 31 秒，两轮 pnpm 与 Rust 均命中缓存。最低系统和多 DPI 实机仍按平台矩阵验收。[失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44641778880/job/135974360604) · [定向验收](https://github.com/YanChao001/serial-workbench/actions/runs/44644885767/job/135984830398)

**合并 Windows 桌面验证（`4b66269`）**。一次构建完成系统对话框完整场景，实际打开和保存均还焦到同一所有者，录制回放校验 69 字节。收据在 `windows-4b66269/signed-terminal-1l4mCP`。本机 `pnpm verify --jobs 1` 通过，159.4 秒，无头 UI 203 项通过，输入 p95 为 98.4 毫秒。托管首跑 125.9 毫秒，自动重试 79.1 毫秒，报告一项不稳定，原始样本在 `hosted-4b66269-browser`。Apple Silicon 桌面因未分配托管 runner 而取消，用例未执行。[四目标运行](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155)

同轮 Windows Rust 的来源撤权先通过撤权、安装中断及权限错误检查，终态之后的字节计数受调度影响而失败。移除四项集成用例重复检查的归档读取字节数，继续验证权限、终态及安装结果。分块取消仍由受控读取用例验证。本机这五项定向用例通过，日志为 `cold-proof-stop-regressions.log` 和 `cold-proof-block-cancellation.log`。[Windows 失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790851900)

同轮 Intel Rust 通过 109 项签名后台和 73 项 Host 专项，监护故障用例在准备后原生屏障就绪前超时。安装布局根是 Cargo release 目录，夹具曾整体复制该目录，失败产物约 1.27 GB。`b692f6e` 只复制验证器实际读取的 `runtime/`，同架构预检通过 109 项签名后台、73 项 Host 专项及 2 项 CLI/MCP。三项监护与回收用例均通过，共用时 18.6 秒。[Intel 失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790852222) · [Intel 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44598756495)

同轮 Apple Silicon 的 H14/H15 用例先通过了撤权停止排队发送、拒绝新键和保持水位的断言，随后在父任务终态断言失败。旧夹具在授权提交回执后放行父任务，Node 可能先返回成功。`86ba3af` 等待 Node 实际收到合作取消，再放行父任务并核对中断、`PERMISSION_DENIED`、无父结果和全部子发送断言。Windows x64 和 Apple Silicon 都验证了新次序，Apple Silicon 的 109 项签名后台和 73 项原生 Host 用例均通过。完整四目标仍待同源候选验收。本机收据见 `.cache/evidence/m2-node-backend/h14-h15-cancel-order-20261120/checkpoint.json`，原实验在 `terminal-desktop-automation-20261119/h14-h15-narrow-revocation.log` 和 `h14-h15-proposed-acceptance.patch`。[原失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790852361) · [Apple Silicon 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44655815906/job/136021731644)

**安装等待、饱和关停与 Node 故障隔离。** `4b66269` 的四目标 Rust 作业均通过饱和关停。Windows 的 `8cbc7e7` 和其余三目标的 `4b66269` 均通过签名包安装后的动态 Schema 预算用例。原本机超时时安装收据已提交，但测试未观察到终态，原样保存在 `.cache/m2-node-actions-schema-generated-reference-scope-restored.log` 和 `.cache/evidence/m2-node-backend/schema-cache-install-timeout-diagnosis.json`。四目标的同组实际 Node 用例还分别验证了单个 worker 自身异常时兄弟任务和另一个包可用，以及旧 Node 进程实际退出至新进程恢复期间 Virtual Echo、Raw 和录制连续。按 PERF-02、SEC-09 记录软件部分。下次在同源候选中复验这些已覆盖场景及整轮门禁。[Windows](https://github.com/YanChao001/serial-workbench/actions/runs/44520104565/job/135550786712) · [Linux 签名安装](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790851529) · [Linux Rust](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790852095) · [macOS arm64](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790852361) · [macOS x64](https://github.com/YanChao001/serial-workbench/actions/runs/44589360155/job/135790852222)

**同源候选 `2a26df5`。** 本机 `pnpm verify --jobs 1` 与全量无头 Chromium 203 项通过。四目标桌面产物均确认追加读取权后录制仍在运行，关窗释放读者、重开后撤权，以及同一会话三段 RX 共 69 字节的回放。Windows 系统打开、保存和焦点恢复通过，其他目标用了文件选择夹具。日志和校验记录在 `.cache/evidence/m2-node-backend/four-target-2a26df5/`。

四目标 CI 用时 40 分 51 秒。Windows 和 Linux Rust 作业通过，两个 macOS 的 Rust 作业失败。Apple Silicon 注册截止用例看见 PID 文件后读到空内容，改为完整写入后原子发布。修订在 Windows 定向验证成功与超时两个分支，首跑的初始启用等待失败也已保留。Intel macOS 的两个无头签名终端用例经系统 `/var` 别名访问临时私有目录，被 IPC 路径校验拒绝。夹具改用已解析的根，保持原权限校验。两项修订待原失败平台复验。[四目标运行](https://github.com/YanChao001/serial-workbench/actions/runs/44659098133) · [Apple Silicon](https://github.com/YanChao001/serial-workbench/actions/runs/44659098133/job/136032595061) · [Intel macOS](https://github.com/YanChao001/serial-workbench/actions/runs/44659098133/job/136032595174)

**macOS 定向复验（`0b65023`）。** Apple Silicon 的注册截止用例在超时分支实际回收 owner，在及时注册分支保留同一进程代次。Intel 实际 DMG 离线安装后的三个签名参考包全部通过，IPv4 和 IPv6 探针均被拒绝，终端由实际安装的 Host 回放 69 字节并退出。[Apple Silicon](https://github.com/YanChao001/serial-workbench/actions/runs/44665649841/job/136054213475) · [Intel 离线](https://github.com/YanChao001/serial-workbench/actions/runs/44665696657/job/136054389179)

**同源桌面候选（`ea78367`）。** 本机 `pnpm verify --jobs 1` 和单 worker 无头 Chromium 203 项检查通过。四个原生套件的运行产物逐一确认撤权关闭旧视图、重新信任并启用后使用同一桌面连接，新窗口补读的三段 RX 与 69 字节录制回放一致。Windows 实拍英语深色与中文浅色，并用系统对话框核对选择和焦点。Intel 的实际图表窗口重开后补读原采样任务的三个点，Host 实际换代后旧图表窗回收。完整运行的桌面产物已归档至 `.cache/evidence/m2-node-backend/four-target-ea78367/`。[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44669249898) · [Windows 实拍](https://github.com/YanChao001/serial-workbench/actions/runs/44667360387/artifacts/14599075883) · [Intel 原生图表](https://github.com/YanChao001/serial-workbench/actions/runs/44667562545/artifacts/14598393142)

同轮 Windows、Linux 和 Apple Silicon 的 Rust 作业通过。Ubuntu 隔离网络内完成六个 Host 软件场景，T06 实跑 600.071 秒，快读者与录制分别核对 6,911,649 字节，控制查询 p99 为 1.275 毫秒。原始样本在 `four-target-ea78367/host-offline-linux/`。[Ubuntu 软件验收](https://github.com/YanChao001/serial-workbench/actions/runs/44669249898/artifacts/14600246045)

Intel Rust 的监督进程失效用例在发出故障信号前读到空 PID 文件。Node 签名夹具共用原子发布逻辑，用于存在性就绪检查后读取的进程标记、worker 完成状态和持久子动作收据。原退出、取消和时长断言继续执行。Windows 复验覆盖 4 项签名后台和 7 项 Host 用例，均已通过。Intel 本轮在此步骤停止，后续签名参考用例以离线预检证据单独记录。[Intel 失败作业](https://github.com/YanChao001/serial-workbench/actions/runs/44669249898/job/136065996585)

**原生夹具复验（`08f1906`）。** 本机综合检查和全量无头 Chromium 203 项通过。Intel macOS 原失败的监督用例已通过，同批签名包用例 109 项全部通过。预检触及 25 分钟作业时限，剩余原生 Host 用例未跑完。完整矩阵的四个 Rust 目标均在 Clippy 发现同一问题，离线验收示例引用的签名包模块包含未使用的测试常量。原子标记移入原生测试共用模块，示例继续使用签名包辅助代码。[Intel 专项](https://github.com/YanChao001/serial-workbench/actions/runs/44674949590/job/136084539520) · [四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44679817658)

## 验证基线

| 范围                                     | 可据以继续开发的事实                                                                                                                                                                                                                                            | 不代表                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 已合入：M1b 和工作台修复                 | [M1b](https://github.com/YanChao001/serial-workbench/pull/40)、[界面](https://github.com/YanChao001/serial-workbench/pull/42)、[串口与启动修复](https://github.com/YanChao001/serial-workbench/pull/47)；用户在 `f1504de` 报告 COM5/COM14 各 10000 字节回环通过 | 全部设备、双端口并行、字体/DPI 或屏读验收               |
| 已合入：基础 A（14.1/14.2、14.3 安装库） | [PR #48](https://github.com/YanChao001/serial-workbench/pull/48)，合入 `2d450af`；[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/43714434338) 12 项必需任务通过，含固定 runtime 原生自检与 Ubuntu 离线六场景、实际 600 秒              | 最低系统、最终安装器断网运行、正式签名或 B 的四目标结果 |
| 已合入：M2 B（14.3–14.4）                | [PR #49](https://github.com/YanChao001/serial-workbench/pull/49) 合入 `118bc40`，通过可信插件管理、监督、公开 SDK 和 GUI/CLI/MCP 参考场景。[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44681253676)                                 | M3 契约冻结、M6 Windows 断网实装及实机长稳              |

LOG-08 的 M1 软件证据覆盖已合入的只读回放，M4 还需验证变速、单步和断点。AUTO-13 在 14.4 已有后台作者示例、CLI、实际 MCP 产品、桌面桥、原生窗口和无头 iframe/Raw 证据。v1 冻结在 M3。两项均按完整需求更新账本。

B 的合入证据见 `.cache/evidence/m2-node-backend/candidate-9090867/checkpoint.json`。早期 14.3 与 14.4 定向收据仍在 `.cache/evidence/m2-node-backend/` 的 `exact-matrix-local-progress.json`、`dynamic-mcp-local-progress.json` 和 `node-sdk-local-progress.json`。对应收据及备份保留了失败、源码快照和程序摘要。

**桌面管理切片（工作树，Windows）：** 原生桥接测试确认普通桌面身份不能认可来源，独立用户控制连接可以提交，业务连接可以读取终态回执。签名终端包通过实际安装、普通 MCP 身份的目录隐藏与确认请求拒绝、本机确认和显式启用，撤销执行信任后运行状态回到 `inactive`。文件选择使用夹具，MCP 身份直接连接 Host。无头 Chromium smoke 通过 3 项，覆盖插件导航及预览中的桌面要求。ZIP、程序摘要及首轮目录回执夹具失败见 `.cache/evidence/m2-node-backend/terminal-management-632b0246c226464e863b80436173ad26/checkpoint.json`，归档 SHA-256 为 `055735e6cfe205b1a4a7e580b823b487a8f99039791ead5a46ea3607c983e05a`。AUTO-13、FUT-07、SEC-07 和 SEC-12 按完整需求继续追踪。真实桌面、iframe、关页录制及三入口数据对照仍待验收。

**视图资源切片（工作树，Windows）：** 同一签名 ZIP 在实际 Virtual 会话上完成视图打开，并按回执读取 Host 校验的包内入口。无头用例覆盖未登记视图、非法路径、无权读取、精确授权和撤权、其余读者继续，以及重启插件后旧回执失效。分段测试验证后段同长度篡改被拒绝。源码与验收记录见 `.cache/evidence/m2-node-backend/terminal-view-assets-20261118/checkpoint-boxed.json`。

**隔离终端切片（工作树，Windows）：** 重新构建并签名终端包，归档 SHA-256 为 `8d77b92b14b42847edc16f3345dca2e0e74ea90ef4079b66368bd373cb214491`。无头桥接测试用实际 Virtual 会话和 Raw reader 验证快照、实时数据、关闭后重开的留存数据、信任撤销。回放完整录制，逐字节核对 reader 关闭前、中、后的 69 个 RX 字节及同一会话代次。首轮缺少录制输出的读取授权，补充同一输出的精确授权后通过。无头 Chromium 以实际壳脚本和终端包代码验证 opaque iframe、批次确认和重载回收。收据、失败日志和源码摘要见 `.cache/evidence/m2-node-backend/terminal-renderer-20261118/checkpoint.json`。完整四目标 CI 已加入此无头签名测试，候选尚未运行。

**同包三入口对照（工作树，Windows）**。实际 CLI 和官方 MCP SDK 连接到桌面桥验收的同一 Host。`stream.read` 和 `capture.tail` 返回与录制回放一致的 RX 事件，包括会话代次、序号和字节范围。撤销 MCP 的会话与录制内容权限后，目录隐藏两项工具，该身份直连 Raw 查询也返回 `PERMISSION_DENIED`，CLI 仍读到同一数据。同一签名包也通过桌面桥停用、撤销来源密钥和卸载，停用后旧视图资源拒绝读取。

**正式 Host 固定 runtime（工作树，Windows）**。同源 Host 程序使用独立 profile，从无关目录、无 PATH 的环境启动。签名终端经正式资源定位实际启动 Node，通过桌面桥、CLI 和官方 MCP SDK 对照关读者前后同代次的 69 个录制 RX 字节，并完成停用、来源撤销和卸载。实际 CLI 发起停机，验收进程等待 Host 成功退出。`pnpm app:build --no-bundle` 已生成桌面及伴随程序，使用这组 release 程序和固定资源复跑嵌入式、正式进程两项均通过。四目标 CI 已接入此断言，实跑结果待候选。软件证据关联 AUTO-13、FUT-07、SEC-07、SEC-12，源码、程序、签名及原始输出见 `.cache/evidence/m2-node-backend/formal-terminal-20261119/checkpoint.json`。

**实际 MCP 客户端（工作树，Windows）**。Claude Code 2.1.314 用独立配置与本地预设模型响应，通过实际 MCP stdio 在同一 release Host 和 Virtual 会话上发现并调用签名终端动作。Host 核对接纳身份、插件归属和实际成功终态。客户端取得同一完成录制的操作引用，`capture.tail` 结构化正文与 CLI 和官方 MCP SDK 一致。撤销读取授权后以同一身份重新连接，签名动作和录制正文工具已从目录隐藏，按原操作 ID 再查录制引用返回 `PERMISSION_DENIED`，CLI 的独立读取权仍有效。这是 AUTO-13、SEC-07 和 SEC-12 的 Windows 软件证据；源码、逐轮客户端事件和程序摘要见 `.cache/evidence/m2-node-backend/terminal-product-20261119/checkpoint.json`。

Windows `pnpm verify` 通过，前端 2558 项通过，脚本 353 项通过、4 项条件跳过。无头 Chromium 全量首轮 198 项通过、2 项因旧导航断言失败。修正断言使其同时检查工作台、插件入口及设置页页脚，两项复跑通过。首轮截图、trace 和日志保留。原生窗口仍待独立环境验收。

**Node 任务 Raw 读取（工作树，Windows）**。真实 Node 后端在四个 Raw 请求占用额度时返回 `HOST_BUSY`。暂缓交付一页原始数据期间，Node 控制读取仍取得已完成的 TX 回执，独立 Raw reader 与 Capture 同时推进。取消后插件停止等待，读取工作完成后才归还 Host 内存。三段 Virtual 输入和回放的 46 个 RX 字节相符。用例也覆盖精确会话代次和无效入参。日志、源码与程序摘要见 `.cache/evidence/m2-node-backend/node-raw-lane-20261118/checkpoint.json`。这是 SEC-09 与 PERF-02 的软件切片。

**Node 派生发布与读取（工作树，Windows）**。签名测试包以真实 Raw 事件生成派生样本，Host 核对事件和字节范围，记录处理器版本与规范化配置摘要。四个发布请求占满额度时，第五个获得 `HOST_BUSY`，控制回执和 Raw 读取仍可用，三段输入的 58 个 RX 字节与同代次的录制回放一致。两路读者保持独立位置，慢读者获知最早留存位置。撤权后拒绝读页，取消后未提交的样本不可读，实际工作结束才归还名额。源码、日志和失败记录见 `.cache/evidence/m2-node-backend/node-derived-lane-20261118/checkpoint.json`。SEC-09、PERF-02 软件继续进行，T06 固定负载、GUI 派生消费及长稳仍待验收。

实际 CLI 与官方 MCP SDK 读取了签名测试包的同一生产 Operation。四个样本、来源字段和页位置与直接 Host 查询全部一致。另验证了无对应生产任务的请求返回 `NOT_FOUND`，MCP 的派生连接在已有 Raw 连接时成功附接，随后 Raw 查询仍返回同一会话的数据。

**Windows 基座软件场景（工作树，2026-11-19）**。同源 Host、CLI、MCP 及 harness 通过 T01、T03、T04、T05、T06、T08 的 18 项软件断言。T06 实跑 600.064 秒，采样 602 次；发生器、快速读者和录制各核对 6,914,368 字节。慢读者报告缺口，控制 p50/p95/p99 为 4.013/7.388/10.876 ms。源环、读者和录制队列峰值分别为 16,879,922、5,935,176、4,415,084 字节。Host 与验收客户端合计 RSS 峰值为 173,711,360 字节。详细收据见 `.cache/evidence/m2-node-backend/node-derived-lane-20261118/host-software-windows/result.json`，自有进程均已退出，程序摘要见同阶段 checkpoint。Node 解析组合负载、实机及 72 小时验收仍按原门槛执行。

**Windows Node 组合负载（工作树，2026-11-19）**。复跑通过六场景的 18 项软件断言。T06 实跑 600.052 秒，采样 602 次。发生器、快速 Raw 读者、签名解析器和录制回放的 6,911,297 字节 SHA-256 一致。快读者收齐 596 个派生样本，慢读者在 `CURSOR_EXPIRED` 后从位置 533 恢复。控制 p99 为 11.209 ms。派生留存和读页的计账峰值分别为 790,528 和 1,576,960 字节，页排空后读页占用归零，仍留存 790,504 字节。实际 CLI 停止负载 Host 后确认 Node 进程退出。签名 ZIP、逐秒遥测、样本和前次运行索引见 `.cache/evidence/m2-node-backend/t06-derived-memory-20261119/checkpoint.json`。这是 PERF-02、PERF-07 与 SEC-09 的 Windows 软件证据，辅助进程资源和 72 小时实机组合负载仍待验收。

同一工作树的 Windows `pnpm verify` 复跑通过，前端 2591 项通过，脚本 353 项通过、4 项条件跳过。首轮的 Windows CIM 和测试子进程清理权限失败已保留。全量无头 Chromium 测试 200 项通过，已确认剩余的测试 Vite 预览退出。相关日志与退出记录见本阶段 checkpoint。

隔离视图需验证平台注入行为。锁定的 Tauri 将初始化脚本标记为主 frame 专用，Wry 文档记录 Windows 会把这些脚本注入子 frame。Tauri 文档也记录了 Linux 嵌入 frame 的 IPC 来源识别限制。视图验收须验证各目标上的实际授权边界和 Tauri 全局隔离。参见 [Wry 初始化脚本](https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html#method.with_initialization_script_for_main_only)和 [Tauri 权限](https://v2.tauri.app/security/capabilities/#remote-api-access)。

原生平台验收使用独立环境或安排好的前台时段。检查实际 WebView 隔离、Tauri 全局、子 frame 导航、旧端口投递与关窗资源回收，并核对焦点、语言、主题和缩放。参见 [锁定版 Wry 的 WebView 构建接口](https://docs.rs/wry/0.57.0/wry/struct.WebViewBuilder.html)和 [HTML 消息端口](https://html.spec.whatwg.org/multipage/web-messaging.html#message-channels)。

**性能验收与诊断。** 候选上的全局 CPU 和完整进程树峰值 RSS 仍待测。`4b66269` 托管首跑和复跑的 32 个按键样本均低于 100 毫秒，8 次大段插入分别有 3 次和 1 次达到门槛。原生文本框对照也有一次大段插入达到 130.5 毫秒。依据用户确认，常规 CI 继续验证草稿完整性，4 倍 CPU 降速和 100 毫秒参考值改为按需诊断，连续按键和大段插入分别报告。T06 按现有固定负载和阶段预算验收。原样本在 `.cache/evidence/m2-node-backend/terminal-desktop-automation-20261119/hosted-4b66269-browser` 和 `composer-control-opt-in`。[测试入口](./testing.md#前端与脚本)

## 阶段路线

| 阶段   | 交付边界                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0–M1b | 新体系契约与基座；独立 Host、系统串口/PTY/Virtual、基本收发、录制回放、工作区和 GUI/CLI/MCP 的软件切片。跨阶段需求仍按 ID 验收。                                                                              |
| M2     | 可信 Node、Web UI、worker、离线 runtime 和三个参考包。浏览器配对到真实 Host，验证跟随、暂停和人工接管。随后用两个 Host 验证 [LAN-01](./requirements.md#新增用户场景局域网端口共享) 的持口、授权、断网与恢复。 |
| M3     | 用公开 SDK 和真实参考场景冻结 v1 契约、协商、预算、升级与故障恢复，见[冻结前验收](./testing.md#m3-契约冻结)。                                                                                                 |
| M4     | 终端、协议、图表、自动化、传输网络及诊断内置包。                                                                                                                                                              |
| M5     | 专业设备、烧录和分析插件，市场收录分发与离线工具。M4/M5 按需求 ID、首批变种、独立对端和失败/取消条件拆分。                                                                                                    |
| M6     | 入口核对纳入需求在 M0–M5 应交付的软件证据。出口逐项核对完整需求及 [T01—T14](./requirements.md#附件验收方案与功能映射) 的适用场景，包括[实机、长稳与发行候选验收](./testing.md#安装与发行验收)。               |

如需追溯某个 M1 Task 与需求 ID 的对应关系，查阅 `git show 2d450af:docs/plan.md`，不再维护已交付任务的平行矩阵。

平台与适配器以[需求的平台目标](./requirements.md#平台目标)为准。Windows portable 当前仍使用用户目录；UX-11 的程序目录模式须另验只读目录、移动介质、换机凭据及升级。
