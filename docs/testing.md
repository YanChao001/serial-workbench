# 测试与验收

按改动选择检查，通过后即可交付；新增变化、失败或明确疑点出现时再补验证。命令从仓库根目录运行，结果记录源身份、平台、命令及影响判断的未测范围。当前失败见[进度](./progress.md)。

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

测试验证用户行为和模块边界。fixture 提供可控输入和失败，不替代真实 Host/系统能力；删除功能同时清专属测试。低影响可逆改动选择直接核验，避免镜像实现的断言或重复运行未变全集。

Host 脚本化夹具的 Operation 等待保留五秒门槛，数据库读取在阻塞 worker 中执行，超时只报告最后已读状态及后端进展，不在失败路径追加同步查询。默认新建 profile 在 panic 时保留到 `artifacts/rust-failures/`，CI 失败时上传；外部传入目录原地保留，通过时沿用 TempDir 常规清理。授权到期使用可控时钟，先建立 reader 等待再推进，并独立观察后台监视器释放预算；BREAK 持续时间从业务 Asserted 屏障后推进。饱和关停区分首轮有界未完成报告与最终责任退出，测试总预算不放宽生产的关闭/关停预算，完整核对操作归属和证据。

`pnpm test` 汇总应用代码、Host 客户端和 Rust 导出契约，参数化输入分别计数。格式与数值边界集中在契约或纯函数测试，界面选择代表性交互；同一行为重复覆盖时合并。样式以浏览器实际布局、可读性和无障碍验证，避免用源码扫描器、CSS 类名或配置文本复刻实现。

## 前端与脚本

```sh
pnpm exec vitest run <受影响文件>
pnpm typecheck
pnpm lint
node --test <相关脚本.test.mjs>
pnpm verify --jobs 1
```

verify 的实际步骤见 [verify.mjs](../scripts/verify.mjs)，本轮日志写入 `.cache/verify/`。浏览器、预览端口和报告目录不并发运行；Cargo/生成任务共用 target 时顺序执行。

组件测试 mock `@/lib/tauri`，门面契约测试再 mock 底层 Tauri API。脚本/进程测试使用自建临时目录和持有的进程，Host 使用独立 profile；测试失败保留必要现场，不触及真实用户数据。

## 桌面边界

日常 UI 使用无头浏览器。真实应用窗口、测试 exe、原生截图和安装器测试仅在独立 CI/虚拟机或用户安排的前台时段运行；隐藏子进程控制台不能阻止 GUI 抢占焦点。

`pnpm e2e:build` 只构建测试程序；`pnpm test:installer --interactive` 会启动原生测试 exe，也遵守此前台边界。

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:ui
```

此入口构建生产 `dist-web/` 并运行 `e2e/browser/`，检查子路径资源、工作台/设置、键盘、无障碍、CSP 与运行时错误。视觉改动核对明暗、透明背景、减少动效、窄窗口和焦点；必要时实际查看生成截图。

真实桌面通过 `pnpm e2e:build` 与 `pnpm test:e2e --interactive --skip-build` 运行 `e2e/specs/`，使用测试配置和 WebDriver。构建包含相邻同源 Host/CLI/MCP，收据校验源码、target/profile 与程序哈希；runner 使用独立 Host profile、持有 PID、正常 CLI 认证及实际退出，失败保留现场。工作台场景在同一窗口内请求 runner 重启其持有的 Host，核对旧实例退出、新 epoch、显式重新附着、订阅及未发送草稿。

设置场景分别读取 Host SharedSettings 和 Native ClientState，按字符串 revision 保存并等待 Operation 终态。媒体场景仅在测试 feature 中用 suite 固定 PNG 替代系统选择对话框，后续仍经过正式文件检查、登记、授权和媒体票据；这不验证系统选择对话框本身。I5/I7 接线尚待完整四目标 CI 复验，不在本机启动真实窗口。

同一 Native 阶段串行复用 profile 和界面状态；首个失败后停止该阶段并保留截图/日志，避免后续依赖状态的连锁超时。成功候选仍执行全部阶段和场景。授权恢复定向检查覆盖多个终态无 ACK、正常/应急容量及实际回收、连续授权、恢复查询再次遇到授权变化、真实撤权拒绝，以及旧 reader 回调隔离；恢复只查询和订阅，不重放发送动作。退休检查还验证普通 RPC、订阅及设置副作用不会隐式附着或启动 Host，明确附着后才允许新代次访问。

原生桥接库回归用真实 Host 暂停旧订阅关闭，连续投递 300 个晚帧并 ACK 另一活跃订阅，核对旧帧不会耗尽建立队列；建立请求失败/取消会释放早帧，合法建立请求的共享条数/字节溢出仍拒绝。IPC 回归区分零字节撤权/epoch 失效与部分帧中断；接纳剪贴板动作后，通过真实 writer 零字节撤权及 `operation.get` 核对 Failed/错误码、无伪造回执及连接继续可用。会话测试用线程退出屏障区分 completed、Closed、关闭操作及实际 join，不以增加等待上限修正断言。

原生链路故障先本机定向复现并收齐本轮 CI 的实际失败，再手动运行 `ci.yml` 的 `native_preflight=true`；`native_preflight_target` 默认 Ubuntu x64，可选择实际失败的 Windows x64、macOS arm64/x64，执行与完整检查相同的 fresh、persisted、centered 三阶段。通过后，对冻结候选以 `native_preflight=false`、`desktop_e2e=true` 运行完整四目标门禁。预检结果单独命名，不计里程碑验收；两种模式均保留原生收据和测试日志。原生驱动的 DOM 点击与真实指针事件有差异，菜单可使用产品提供的键盘入口；标签切换须等待选中状态及对应草稿完成渲染，不复用切换前的元素快照。不得通过直接修改应用状态绕过交互。

预检并发按 ref/target 隔离，完整模式仍按 ref 串行。Linux Native 安装使用非交互与 `--no-install-recommends`，显式保留 Xvfb/xauth、CJK 字体、调试符号及媒体解码包；环境准备预算 12 分钟，测试预算不变。安装超时和未获得 runner 的取消单独记录，未执行的场景不能计为软件失败或通过；同候选的预检偶发通过也不能覆盖完整模式的实际失败。

## Rust 与生成

无头包可直接 `cargo test --locked -p serial-workbench-core`；根默认成员不包含桌面。桌面检查先 `pnpm build` 准备 dist，再选择包：

```sh
cargo test --locked -p serial-workbench --lib
cargo fmt --all -- --check
```

用户正在运行开发程序时，可为无头检查显式指定 `--target-dir .cache/local-acceptance-target`，例如 `cargo test --locked --target-dir .cache/local-acceptance-target -p serial-workbench --lib`。独立目录保留缓存；仅设置 `--target` 仍会争用默认根目录锁。

包含桌面的里程碑运行 `cargo test --locked --workspace` 与 `cargo clippy --locked --workspace --all-targets -- -D warnings`。独立后端 Clippy 显式选择 core/ipc/host/client/cli/mcp，生成命令见[功能接线](./development.md#契约与功能接线)。

CLI、MCP、HostClient 交叉测试先构建同一 target 的 Host/CLI/MCP，再运行 `cargo test --locked -p serial-workbench-host --test client_parity`。测试读取该 target 的程序；独立产物可用 `SWB_TEST_CLI_BIN` / `SWB_TEST_MCP_BIN` 绝对路径。核对临时 profile、真实程序身份和自有进程回收。

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

Ubuntu 手动 CI 在联网安装/构建后运行 `scripts/test-host-offline.mjs`，以独立 network namespace、原 runner UID/GID 执行同一六场景。前后核对命名空间、仅未启用 lo、无 IP/双栈路由及父环境不变，并从外部上传原始证据。失败不回退联网；本地单元测试只验证接线。

### 独立录制格式

```sh
cargo run --locked -p serial-workbench-host --example capture_fixture -- --output <新fixture绝对目录>
node scripts/test-capture-container-independent.mjs --fixture <该目录> --result <新的外部结果绝对路径>
```

Node reader 不依赖 Rust parser/SDK/IPC，扫描全部卷核对字节、索引、水位、摘要和 partial/unknown。两个输出位置尚不存在，结果文件在 fixture 外。格式见 [Capture](./contracts/capture-container-v0.md)。

## 持续集成

`.github/workflows/ci.yml` 与 audit 仅手动触发；大节点完整检查累计源范围，未设置 push/PR/定时自动运行。四目标为 Windows x64、Ubuntu x64、macOS arm64/x64，具体 runner 读取工作流。

每轮包含前端/脚本、浏览器、Rust fmt/Clippy/workspace、生成绑定和未签名构建。desktop_e2e 默认开启；关闭时只允许该类 job 跳过，其余失败、缺失、取消或跳过均使质量门槛失败。Ubuntu 正式离线场景保持 600 秒及隔离/上传门槛。

最低系统、真实硬件、72 小时、LAN 双机、实际 MCP 产品客户端、签名与公开发行分别验收；runner 软件通过记录到其适用范围。

## 安装与发行验收

安装升级前先按变更选择数据验证：CAS 冲突、未来格式拒写、读/写/备份失败、替换竞态及中断恢复均核对原件和最终状态。隔离恢复同时检查暂存、明确重启、归档及回滚；只读 fixture 或成功返回不足以确认恢复正确。

按实际系统覆盖安装、首次/重复启动、卸载、系统 WebView、协议关联、自启动与窗口恢复；更新使用两个不同版本核对下载/验签、工作协商、安装、重启和失败恢复。Windows portable 单独验证，macOS 签名/公证、Linux 包格式分别记录。

硬件按 2026-11-09 用户确认的 Windows 范围覆盖目标适配器与接线，记录驱动、芯片、OS、速率、流控、BREAK、拔插和休眠；LAN 在两台 Windows 物理电脑上交换角色。macOS/Linux 进行实现与虚拟测试。性能用固定 release 与参考机器，记录完整进程树、吞吐、队列、CPU/RSS 和控制延迟，典型负载进行实际 72 小时长稳。

初始软件参考负载为单会话 11,520 B/s、四会话各 100 KiB/s、八会话各 1 MiB/s 压力；M1/M2 实测后固定机器、预算及阈值。3/6/12 Mbps 使用确实支持的适配器和对端；百万点/60FPS 记录通道、可见范围及降采样，满队列保留缺口或停止原因。

M3 契约冻结前，以至少两个仅使用公开 SDK 的参考插件验证终端、图表导出、自动化、网络/工具交接和合成 UART 波形；覆盖跨入口 revision/epoch、撤权、取消、unknown、写盘恢复及未来格式，并完成实际 MCP 产品客户端、正式 Node 离线包、后台升级和故障回收。通过后才进入完整功能包集成。

## 依赖审计

`pnpm audit` 与 `cargo audit --file Cargo.lock` 使用当前锁文件；手动 audit workflow 保留。请求失败记为未完成，实际风险、升级和暂缓原因写入 PR，不将工具不可用记作通过。
