# 路线与进度

本页维护当前接续点、阶段出口和验收证据入口。需求范围以[需求矩阵](./requirements.md)为准，逐项结果见[需求账本](./feature-status.json)。247 个 ID 中，244 项纳入，移动端 FUT-10、CONN-19 排除，NET-13 留给零安装 Web Serial 专项。

## 当前执行与下一步

**当前阶段为 M3。** 本轮交付包括版本协商、签名 UART 金样、SVG 离屏导出和更新前关停。后续交付从最新 `main` 接续，完成下表所列的 HTTP、公开 SDK 和整套升级验收后冻结 v1。 [PR #55](https://github.com/YanChao001/serial-workbench/pull/55)

PR #55 的验收包括 IPC、Client、Host 和桌面的定向 Clippy，确认原失败项后，对同一候选完成 `pnpm verify`、全量无头 UI、专项验收和四目标 CI。完整模式设置 `desktop_chart=true`，让 Windows 桌面作业复用同一次构建运行签名终端和图表。候选及验收结论从 PR 和 CI 追溯。 [首轮四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44869976974)

| M3 事项                        | 已有证据与下一步                                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本协商与签名 UART（DIAG-08） | 工作树提供版本不兼容指引。Windows 真实 Host 用公开 SDK 签名夹具验证双向 UART 波形、原始区间和超出 JS 安全整数的采样序号。继续同源矩阵复验。VCD/CSV、校验位和 BREAK 按 M5 验收。                                                                                                   |
| 图表离屏导出（VIZ-13）         | `f053fdb` 的 Windows 独立桌面使用真实保存对话框落盘 SVG，验证焦点返回、曲线和 Host 换代。无窗口原生测试验证 MCP 结果与磁盘文件字节一致。继续同源矩阵复验，其余格式按 M4/M5 验收。 [Windows 专项](https://github.com/YanChao001/serial-workbench/actions/runs/44871141751)         |
| 后台升级（T14）                | Windows 已验证实际进程退出、非零退出在重试中保留、取消等待后继续持锁。旧 Host `3492986` 正常退出，手动启动候选 Host 在同一 profile 从代次 1 恢复到 2，两次安装准备通过。本机 Windows Job 限制了自动启动。独立环境的自动启动、安装器持锁交接、整套替换、重启和安装失败恢复仍待验。 |
| 网络 API（AUTO-12）            | 配对 WebSocket 和双 Host TCP 已有独立认证与权限过滤的软件证据。交付外部程序 HTTP 控制入口，并验证三种入口的版本协商、游标、来源和授权。 [PR #51](https://github.com/YanChao001/serial-workbench/pull/51) · [PR #52](https://github.com/YanChao001/serial-workbench/pull/52)       |
| 公开 SDK 合约                  | 签名事务已合入，实际 Claude Code stdio MCP 使用签名终端的本机证据已取得。还需验证长脚本、独占工具交接、四类扩展点及对应故障恢复。按 [M3 契约冻结](./acceptance.md#m3-契约冻结)核对后冻结 v1。                                                                                     |

本机证据入口均相对主工作区的 `.cache/evidence/`。UART 查 `m3-uart-gold-20261121/`，图表查 `m3-contracts-20261121/f053fdb/windows-chart/checked-chart.json`，两版本恢复和中止的 Clippy 查 `m3-contracts-20261121/updater-exit-recovery/refreshed-worktree-build/`，本轮复验查 `m3-contracts-20261121/resume-20261121-180211/`，MCP 产品和 Windows T06 查 `m3-transaction-20261121/`。

## 验证基线

| 已合入范围          | 可复用的证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0–M1b              | 独立 Host、GUI/CLI/MCP、基本收发、工作区、录制与只读回放已有软件证据。现场 COM14 回环是开发版定向复测。 [基座](https://github.com/YanChao001/serial-workbench/pull/40) · [现场复测](https://github.com/YanChao001/serial-workbench/pull/44) · [工作台修复](https://github.com/YanChao001/serial-workbench/pull/47)                                                                                                                                                                                                                                                                                         |
| M2 A 与 B           | 正式包、固定 runtime 布局、可信安装与执行信任、运行监督及公开 SDK 已交付。四目标真实桌面验证签名终端关窗持续录制、重开补读和撤权。Windows 通过真实打开、保存和焦点检查。 [A](https://github.com/YanChao001/serial-workbench/pull/48) · [B](https://github.com/YanChao001/serial-workbench/pull/49) · [B 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44681253676)                                                                                                                                                                                                                |
| M2 C                | 终端、图表和自动化三个签名参考包通过四目标验证。实际 Debian x64 与 macOS 两种架构在断网环境安装，并用安装后的程序运行三包。 [PR #50](https://github.com/YanChao001/serial-workbench/pull/50) · [四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44705059778) · [Debian](https://github.com/YanChao001/serial-workbench/actions/runs/44618907763/job/135895042980) · [macOS arm64](https://github.com/YanChao001/serial-workbench/actions/runs/44625635016/job/135918712553) · [macOS x64](https://github.com/YanChao001/serial-workbench/actions/runs/44627559546/job/135925452105) |
| M2 配对浏览器与 LAN | 真实配对浏览器验证活动跟随、暂停、接管和授权边界。双 Host 验证会话共享、按客户端接管、断线结算、重连取回执，以及 Windows 原生双端读回与草稿归属。M2 软件出口完成。 [PR #51](https://github.com/YanChao001/serial-workbench/pull/51) · [PR #52](https://github.com/YanChao001/serial-workbench/pull/52) · [LAN 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44829397705)                                                                                                                                                                                                          |
| M3 签名协议事务     | 验证独立租约、竞争写入、取消、按源时钟归属迟到应答及 GUI/CLI/MCP 的录制一致性。Ubuntu 在隔离网络运行六个软件场景和 T06 的 600 秒负载。Windows 本机另有签名解析器、快慢 Raw 读者和录制并行的 T06 证据。 [PR #53](https://github.com/YanChao001/serial-workbench/pull/53) · [四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44853898708)                                                                                                                                                                                                                                             |
| 串口监听参考包更新  | 同一签名来源的 `0.1.1` 到 `0.1.2` 原地升级保留启用及执行信任，正文直接显示收发数据。 [PR #54](https://github.com/YanChao001/serial-workbench/pull/54) · [四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44859539929)                                                                                                                                                                                                                                                                                                                                                               |

### 验收边界与未决问题

- Windows x64 NSIS 已核对内置 WebView2 离线安装程序、固定 Node 和伴随程序。用户确认缺 WebView2 的独立环境断网实装与首次启动安排在 M6。该环境尚未就绪。 [安装与发行验收](./acceptance.md#安装与发行验收)
- Windows 两台物理机在 IPv4/IPv6 互换 LAN 角色、目标设备、最低系统、正式签名和三平台各 72 小时长稳均待 M6。既有回环、虚拟设备和组合负载证据沿用各自范围。完整进程树峰值 RSS 与全局 CPU 仍按候选和适用负载收集。
- 已打开的插件视图实时更新语言（UX-13）、只读回放的变速/单步/断点（LOG-08）、图表与原始数据的交叉定位以及 Windows portable 程序目录模式（UX-11）继续按各自阶段验收。
- Windows 10 22H2 的产品目标仍适用，正式发行前保留对 Node 上游支持冲突的确认。 [分发契约](./contracts/runtime-distribution.md#windows-10-的供应商支持冲突)

## 阶段路线

| 阶段   | 交付边界                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| M0–M1b | 契约与独立 Host 基座，系统串口、PTY、Virtual、三入口收发、录制回放和工作区。                                              |
| M2     | 可信 Node、Web UI、worker、离线 runtime、三个参考包、配对浏览器与 LAN 双 Host 软件验收。                                  |
| M3     | 用公开 SDK 和真实参考场景验证协议协商、预算、升级和故障恢复，冻结 v1。 [冻结前验收](./acceptance.md#m3-契约冻结)          |
| M4     | 交付终端、协议、图表、自动化、传输网络与诊断内置能力。                                                                    |
| M5     | 交付专业设备、烧录和分析插件、市场收录分发与离线工具。M4/M5 按需求 ID 选择独立对端及失败、取消场景。                      |
| M6     | 入口核对前序软件证据。出口逐项通过 [T01—T14](./requirements.md#附件验收方案与功能映射) 的适用实机、平台、长稳与发行验收。 |

平台和适配器见[需求的平台目标](./requirements.md#平台目标)。公开部署、公开发布及会自动公开 Release 的触发条件见[交付检查](./development.md#交付检查)。已完成切片的逐轮记录从 Git、对应 PR 和 CI 回看。
