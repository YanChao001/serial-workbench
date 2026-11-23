# 路线与进度

本页维护当前接续点、阶段出口和验收证据入口。需求范围以[需求矩阵](./requirements.md)为准，逐项结果见[需求账本](./feature-status.json)。247 个 ID 中，244 项纳入，移动端 FUT-10、CONN-19 排除，NET-13 留给零安装 Web Serial 专项。

## 当前执行与下一步

**M3 契约收尾与 M4 功能并行。** `main@7c24c50` 已合入签名参考场景、有序 SDK 会话钩子、配对图表、设备参数和 Windows 套件恢复。产品自动升级专项与 M3 契约冻结继续验收。 [PR #57](https://github.com/YanChao001/serial-workbench/pull/57) · [PR #58](https://github.com/YanChao001/serial-workbench/pull/58) · [四目标 CI 的 13 项必跑作业](https://github.com/YanChao001/serial-workbench/actions/runs/45191611700/attempts/2)

两轮已合入候选均通过本机综合验收、208 项无头 UI 和完整四目标 CI 的 13 项必跑作业。Windows 真实图表保存与两轮 Intel macOS 首轮失败、同源复验均可从各自 CI 追溯。 [PR #55 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44893314699) · [PR #56 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44904815981)

| M3 事项                        | 已有证据与下一步                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本协商与签名 UART（DIAG-08） | 四个 Rust 目标通过版本不兼容引导与签名公开 SDK 的双向 UART 金样。VCD/CSV、校验位和 BREAK 按 M5 验收。                                                                                                                                                                                                                                                                                                                                        |
| 图表离屏导出（VIZ-13）         | Windows 真实保存对话框核对焦点返回、曲线和 Host 换代，签名参考场景核对 MCP 文件结果。其余格式按 M4/M5 验收。 [Windows 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44893314699/artifacts/14702887521)                                                                                                                                                                                                                   |
| 后台升级（T14）                | 隔离 Windows 验证一次性密钥签名的实际 NSIS 暂存、两版套件持锁换入、Host 换代及专用卸载项提交与中断回滚。Windows 本地测试覆盖从认证意图发现未完成操作。产品更新入口、桌面自动重启与正式发行旧版升级继续验收。 [签名暂存](https://github.com/YanChao001/serial-workbench/actions/runs/45169277281/artifacts/14816463061) · [两版换入与注册回滚](https://github.com/YanChao001/serial-workbench/actions/runs/45175282344/artifacts/14820495565) |
| 网络 API（AUTO-12）            | 本机 HTTP 已合入，和配对 WebSocket、LAN TCP 的独立认证与版本拒绝有同候选证据。HTTP 已实测来源、游标、重试和授权撤销。配对浏览器 Raw 与 IPC 的字节对照及 LAN 返回游标的双栈回环续读已定向通过，证据分别绑定实际构建。同一综合候选复验后核对软件账本。 [当前合入](https://github.com/YanChao001/serial-workbench/pull/56) · [专项验收](./acceptance.md#本机-http-控制)                                                                         |
| 公开 SDK 合约                  | 已有签名事务和实际 Claude Code stdio MCP 证据。当前候选补齐公开会话钩子、配对浏览器签名图表和插件设备参数入口。Windows 定向通过 Virtual Echo 的有序收发与终态、真实配对读页和重新附着。完成同候选矩阵和整套升级，再依 [M3 契约冻结](./acceptance.md#m3-契约冻结) 冻结 v1。                                                                                                                                                                   |

本机证据入口均相对主工作区 `.cache/evidence/`。已合入候选查 `m3-contracts-20261121/resume-20261121-180211/checkpoint.json` 和 `m3-http-20261121/7285426/merge-receipt.json`。待合入切片查 `m3-long-script-20261121/`、`m3-parser-reference-20261121/`、`m3-signed-theme-20261121/`、`m3-transport-20261121/`、`m3-tool-handoff-20261121/`、`m3-update-consent-20261121/`、`m3-install-recovery-20261121/`、`m3-browser-signed-terminal-20261121/` 与 `m3-lan-role-simulation-20261121/`。实际 MCP 产品和 Windows T06 查 `m3-transaction-20261121/`。

### 当前候选与 M4 工作树

- PR #58 的 `cf4b4fc` 在隔离 Windows 完成真实 NSIS 0.1.0 到 0.1.1 的换入、Host 代次 1 到 2、同一身份与 profile 恢复，以及摘要拒绝和注册写入中断恢复。这里的注册恢复由隔离验证程序执行。独立产品升级场景首轮完成两版构建后达到任务时限，新的复验分别记录证书准备和真实桌面升级阶段。 [PR #58](https://github.com/YanChao001/serial-workbench/pull/58) · [两版安装收据](https://github.com/YanChao001/serial-workbench/actions/runs/45194202380/artifacts/14828417740) · [桌面更新复验](https://github.com/YanChao001/serial-workbench/actions/runs/45204372209)
- `feature/m4-workbench-basics` 集成了混合发送输入、HEX 校验定位、转义与追加校验、带原始偏移的录制导出、多源只读回放、诊断导出、窗口快捷键、插件视图实时切换语言以及 ANSI 终端。浏览器夹具核对跨包控制序列、显式启用后的键盘字节、应用快捷键优先和设备询问边界。`transfer.paste` 复用 Host 独占分片调度，模拟串口验证普通发送顺序、编号回执和取消后的已写入前缀。相关软件项目仍在验收，真实桌面终端交互和物理串口继续实测。

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

- 用户确认当前没有可用的独立实机与虚拟机环境。优先用 Virtual Echo、PTY、双 Host、故障注入和隔离 CI 验证适用软件场景，按实际覆盖记账。平台矩阵中的物理设备、72 小时实跑和缺 WebView2 的断网实装待有条件验收。

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
