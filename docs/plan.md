# 路线与进度

**当前接续点（2026-11-19）为 M2 / Task14.4 的 B 候选验收。** Windows 原生签名终端已通过实际文件选择、执行信任、关窗录制、重开补读及撤权观察。实际 MCP 客户端已在同一正式 Host 上验证签名动作、录制引用和撤权。签名 Node 组合负载已在 Windows 实跑 600 秒。继续 B 的窗口环境、已发现问题和候选出口，C 图表的派生视图可并行验收。逐项软件、硬件和发行状态见[需求账本](./feature-status.json)。

## 当前执行与下一步

1. **B / 14.3–14.4**　继续[终端参考包验收](./testing.md#终端参考包验收)的目录恢复、录制中追加读取权、连接失效时的窗口回收、语言、主题、缩放、慢读者及其他平台原生观察。处理草稿输入延迟，核实 Windows 主窗与隔离插件窗口的缩放行为。候选验收保留安装准备和关停压力的未决记录。
2. **B 的出口**　同一候选完成管理与监督、SDK 和三入口复审、本机综合检查、无头 UI 及完整四目标 CI。补齐四目标桌面流程的签名包管理、视图接线和录制检查，实际文件对话框及独立渲染器保留对应平台的观察证据。两个 macOS 架构均须实际编译、运行并回收原生监护进程。
3. **C / 14.5**　在同一个终端包上补齐剩余场景，加入图表与自动化包。三个正式包均经离线安装、公开 SDK 和获准入口验收，并覆盖 Node/worker 故障时 Rust 串口及录制连续性。Task14 退出后依次推进浏览器连接与跟随、LAN 双 Host。

签名终端的桌面 E2E 构建使用 `pnpm e2e:build --with-node-runtime` 准备同源测试程序及固定 Node。资源与程序一起写入构建收据。Windows 无窗口构建和 Host 接线结果记录在 `.cache/evidence/m2-node-backend/native-terminal-build-20261119/checkpoint.json`。独立环境或约定的前台时段使用 `--terminal-manual` 完成实际文件选择、关窗和重开。runner 保存签名输入和进程日志，退出后按本轮 Host 回放核对录制。窗口观察另留证据。

**Windows 签名终端原生流程（工作树）**。实际 ZIP 选择、桌面确认执行信任、显式启用、关闭终端窗、同会话继续录制、重开补读、撤权停止视图和退出均有记录。预授权录制的三个 RX 事件逐字节回放一致，共 69 字节，九条容器记录均验证完成。候选、截图、两次录制和退出日志见 `.cache/evidence/m2-node-backend/native-terminal-foreground-20261119/checkpoint.json`。首次录制在同一桌面身份运行中追加目标读取权后结算为失败，保留未完整容器。重新启用后曾需重新附着主窗口才恢复视图入口，保留待复查。此轮更新 LOG-01、AUTO-13、PERF-02、SEC-03、SEC-07、SEC-12 和 FUT-07 的本机软件证据。

**桌面目录恢复（工作树，Windows）**。修复桌面桥丢弃 `catalogChanged`。嵌入式和正式 Host 均在同一桌面连接验证显式启用、撤销执行信任及重新启用的通知与目录可见性。前端回归验证旧窗口通知和晚到目录页不会覆盖新结果。原生窗口复查仍待安排。见 `.cache/evidence/m2-node-backend/catalog-reactivation-20261119/checkpoint.json`，覆盖 AUTO-13 和 SEC-07 的软件部分。

**录制期间追加读取权（工作树，Windows）**。真实 Host 复现同一身份追加目标文件读取权导致录制以 `PERMISSION_DENIED` 结束。修复后，Host 录制绑定实际使用的源读取与目标写入权限。回归从本地控制入口追加文件读取权，再发送并回放核对 3 个 RX 字节。撤销任一录制权限都使空闲录制失败结算，立即重授仍拒绝原绑定。证据见 `.cache/evidence/m2-node-backend/capture-grant-20261119/checkpoint.json`，属于 LOG-01 和 SEC-12 的软件部分。原生窗口仍待复验。

**同源候选复审（工作树，Windows）**。固定 Node 候选通过终端、图表和自动化的四项真实 Host 用例。正式 Host 的终端流程通过实际 CLI、MCP 和 Claude Code，后者核对 69 个 RX 字节及撤权。`pnpm verify` 通过。全量无头 Chromium 通过 202 项，草稿输入 p95 为 106.2 毫秒，超过 100 毫秒门槛。三次单独复测中一项通过，两项失败。复审确认录制入队与撤权存在竞态，并发现原生迟到窗口和四目标签名场景的覆盖缺口。构建收据、失败样本和复审见 `.cache/evidence/m2-node-backend/capture-grant-candidate-20261119/checkpoint.json`。录制授权修复后须重新构建并验收同源候选。

**活动录制批次的撤权边界（工作树，Windows）**。在真实 Virtual Echo 的第二组 RX 入队前撤销源读取权。旧实现终态报 `PERMISSION_DENIED`，但文件仍包含第二组数据。修复后终态一致，校验实际卷只读到撤权前的 RX。录制单元及 Host 集成筛选通过 16 项，录制 API 集成通过 14 项，固定 Node 交叉场景通过 6 项。历史饱和关停用例单独复测通过，三种停止方式耗时 4.01 到 4.39 秒，整体候选复测仍待完成。关联 LOG-01 和 SEC-12 的软件部分，保留原软件状态。见 `.cache/evidence/m2-node-backend/capture-revoke-queue-20261119/checkpoint.json`。

**插件窗口的显示边界（工作树，Windows）**。窗口先隐藏初始化，显示前复核发起文档和当前 Host 连接。真实 Host 桥接回归保留同一个发起文档并更换连接，验证旧请求返回 `EPOCH_MISMATCH`，并验证连接移除与最终显示使用同一边界。桌面 Rust 库检查通过 181 项，4 项签名包专项由独立入口运行。关联 SEC-07 的软件部分。实际 WebView 显示、关闭和重新打开仍需对应平台观察。构建与本机记录见 `.cache/evidence/m2-node-backend/node-view-publication-20261119/checkpoint.json`。

**插件安装和授权界面（工作树，Windows）**。已安装列表显示名称、版本和状态，展开行查看来源与操作。「管理来源」默认收起。授权弹窗显示签名来源、工作台能力和本机执行风险。无头 Chromium 用受控桌面 IPC 核对选择签名来源、安装、信任后显式启用、撤权和安装失败提示，覆盖英文暗色与中文窄窗口。嵌入式 Rust Host 用实际签名终端包复核安装回执与列表的名称和版本、撤权后重新启用和 69 字节录制连续性。原生文件选择和新版原生窗口仍待复验。AUTO-13 和 SEC-07 的此次软件证据见 `.cache/evidence/m2-node-backend/plugin-install-ui-20261119/checkpoint.json`。

**C 图表后台和留存视图（工作树，Windows）**。签名包将 Virtual Echo 的拆分 RX 发布为 `1.25`、`-2`、`3.5` V，保留三段原始字节范围。真实桌面桥、重开视图和 CLI 读取同一完成任务的样本，撤权后禁止读页。图表和终端可以在工作台已占用 Raw 通道时打开。无头 Chromium 验证隔离视图显示缺口和样本。证据见 `.cache/evidence/m2-node-backend/reference-chart-view-20261119/checkpoint.json`，后台原验证见 `.cache/evidence/m2-node-backend/reference-chart-20261119/checkpoint.json`。VIZ-01 软件已开始。原生图表、实时采样、实际 MCP 产品与三平台离线安装继续验收。

**C 自动化后台参考包（工作树，Windows）**。公开 SDK 提交同一会话的发送子动作，按实际发送回执和 RX 来源范围核对每步应答。实际签名包在嵌入式 Rust Host 上通过双步骤匹配。应答不符、收到前缀后超时、等待应答时取消都只执行首步。取消用例先等真实 RX，再核对取消接纳回执和父动作终态。Virtual Echo 录制回放逐字节核对 32 字节和会话代次，覆盖 IO-10、AUTO-05 和 AUTO-13 的软件部分。见 `.cache/evidence/m2-node-backend/reference-automation-20261119/checkpoint.json`。窗口、多入口与三平台离线安装仍待验收。

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

## 验证基线

| 范围                                     | 可据以继续开发的事实                                                                                                                                                                                                                                            | 不代表                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 已合入：M1b 和工作台修复                 | [M1b](https://github.com/YanChao001/serial-workbench/pull/40)、[界面](https://github.com/YanChao001/serial-workbench/pull/42)、[串口与启动修复](https://github.com/YanChao001/serial-workbench/pull/47)；用户在 `f1504de` 报告 COM5/COM14 各 10000 字节回环通过 | 全部设备、双端口并行、字体/DPI 或屏读验收               |
| 已合入：基础 A（14.1/14.2、14.3 安装库） | [PR #48](https://github.com/YanChao001/serial-workbench/pull/48)，合入 `2d450af`；[四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/43714434338) 12 项必需任务通过，含固定 runtime 原生自检与 Ubuntu 离线六场景、实际 600 秒              | 最低系统、最终安装器断网运行、正式签名或 B 的四目标结果 |
| 工作树：14.3                             | Windows 定向验证覆盖安装/升级/卸载、来源与执行信任撤销、激活/恢复、父子动作去重与取消、worker/Node 退出及同会话 Raw/Capture 连续性。H13—H16 收据源码 `0a01c2a9`                                                                                                 | 逻辑七天不算实际长稳，Virtual TX 不算硬件；未验收整个 B |
| 工作树：14.4                             | Windows 动态 CLI/MCP 收据源码 `e7611e9e`；后台 [SDK 编译示例](../packages/plugin-sdk/README.md) 收据源码 `b7720eb5`。真实签名包经 CLI 和官方 MCP SDK 验证调用、重放、窄撤权和结果读取                                                                           | 完整 SDK、实际 MCP 产品客户端、GUI、iframe 或流         |

LOG-08 的 M1 软件证据覆盖已合入的只读回放，M4 还需验证变速、单步和断点。AUTO-13 在 14.4 已有后台作者示例、CLI、实际 MCP 产品、桌面桥和无头 iframe/Raw 证据。原生窗口继续在 B 验收，v1 冻结在 M3。两项均按完整需求更新账本。

基线表中的 14.3 与 14.4 收据采集于 `feature/m2-node-backend` 提交前。候选验收跟进 [PR #49](https://github.com/YanChao001/serial-workbench/pull/49)。本机原始收据位于 `.cache/evidence/m2-node-backend/` 下的 `exact-matrix-local-progress.json`、`dynamic-mcp-local-progress.json` 和 `node-sdk-local-progress.json`。对应收据及备份保留了失败、源码快照和程序摘要。

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

**仍需观察：** 安装准备超时和关停压力失败尚未确认修复；保留原门槛，在重新复现或候选验收时调查，不用单项重跑覆盖整组失败。大草稿输入即便单轮通过，也曾在同一场景十轮中三次超过 100 ms；保留四倍 CPU 降速、40 样本和原重试策略，不据此提升性能需求状态。schema 逻辑额度和 Node 采样也不证明全局 CPU 或完整进程树峰值 RSS；仍需在候选上测量。

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
