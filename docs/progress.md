# 开发进度

更新：2026-11-10。M1b 已完成验收并合入；当前同步交付状态，随后逐张审查界面截图，再接续 M2—M6。整个目标尚未完成，以下结果只适用于其记录的源码和环境。

## 当前基线

- M1b 通过 [PR #40](https://github.com/YanChao001/serial-workbench/pull/40) squash 合入 `main@7b466df28bf255a325ed8275612ffb4400a06001`。候选 `9283f22463106a785834d055fb55f86a5aa14195` 与合入树完全相同；重新计算源码指纹均为 `86a459f87deab7e1077ae7caf2ca18897027b73c6b8d225e50e8f8b6c5177d37`。
- 主工作区 `D:\yanchao\Codex\serial-workbench` 已 fast-forward 到该 main 并核对干净。M1b 自有分支已清理；本次状态同步从该主线创建短期文档分支，后续继续从最新 main 创建短期分支。未修改 marketplace，未清理指定备份、用户数据或编译缓存。
- 247 条需求账本校验通过：76 个跨阶段软件项仍为 in-progress、168 个 not-started、3 个 not-applicable；76 个 M1 切片已登记并合入 PR #40 证据。切片交付不提升其后续软件、硬件或发行范围，也不把 247 条全部记为完成。
- 真实硬件仅做 Windows，macOS/Linux 做实现与虚拟测试。COM14 为 CH340（VID 1A86/PID 7523）；用户确认 TX/RX 已短接、可按测试需要选择参数，当前未执行正式硬件收发。最低系统、实际 72h、Windows LAN 双机、专业设备、安装签名及发行仍未验收。
- 合入/同源收据位于 `.cache/evidence/m1b/7b466df28bf255a325ed8275612ffb4400a06001/delivery.json`；候选源码、程序哈希、日志与软件/原生证据位于 `.cache/evidence/m1b/9283f22463106a785834d055fb55f86a5aa14195/`。历史失败保持原源码归属。

## 当前验证

[完整 CI 42710347353](https://github.com/YanChao001/serial-workbench/actions/runs/42710347353) 对应候选 `9283f22`，12 项必需任务全部成功：前端、浏览器、IPC 绑定、四目标 Rust、四目标 Native 和质量门禁。完整模式下未执行的预检占位是唯一 job skip，不能当作未运行的目标；四目标均实际执行。

四目标 Native 的 fresh 阶段：Windows/Ubuntu 各 14 通过/1 条件跳过，macOS ARM/Intel 各 13 通过/2 条件跳过；persisted 和 centered 均各 2 通过。源码指纹和 Host/CLI/MCP 三组件收据齐全；最终 Settings 页无错误或保存等待，本轮四端均未记录 Settings effects 错误。各端两个测试 Host 正常退出，三个桌面进程记录 runner 受控停止后的真实退出，不把强制结束记为正常 0。驱动 wheel 输入、Windows 专属 fullscreen 的条件跳过及系统文件选择对话框未测范围保留。

Windows 正式 T01/T03/T04/T05/T06/T08 六场景/18 断言通过，T06 实际 `600.5741037` 秒/602 样本；Ubuntu 离线同六场景/18 断言通过，T06 实际 `600.602492452` 秒/602 样本。两端各 11 个自有进程退出、清理完成；Windows 的 private Host runtime 和 forced-crash capture writer 为受控强制退出 code 1，不声称所有进程正常退出。原始 JSON、遥测及清理记录已由仓库校验器复核。

本机最终检查通过：Host all-targets 43 个结果组/464 项通过/2 个受父用例控制的辅助入口 ignored；桌面 Rust 库 164 项，含 6 项新增 Native 读取边界；相关 all-targets Clippy 与全仓 Rust fmt 通过。`pnpm verify --jobs 1` 九步骤通过，113 文件/1833 Vitest、290 工程脚本通过及 4 条件跳过，195.6 秒，目录 `.cache/verify/run-4yLZIA/`；完整无头浏览器 97 项通过，6.6 分钟。两轴最后增量复核无剩余发现，CI/门禁 8 项与脚本全集重叠，不额外相加。

反复失败已分别处理：Native 内部三个纯读入口补同代次有界恢复，不重放 invoke、授权、设备打开或平台效果；读者到期和 BREAK 先建立业务时序屏障，再推进可控时钟；饱和关停区分有界未完成与真实退出。传输等待保留原五秒，Store 读取移到阻塞 worker并保留失败诊断；旧 CI 具体停滞点仍无法由当时日志确定，新候选在四目标全部通过，不把诊断优化冒称为已证旧根因。本机 Debug/路径夹具失败和因新发现中止的旧 Cargo 均保留且不计通过。

## 当前能力

独立 Host、CLI 和 MCP 可无窗口运行，共用本机目录、授权、任务和状态。设备覆盖系统串口、PTY 与 Virtual，保留原始字节、epoch、revision 和真实 TX 回执。

工作台已有连接、Text/HEX 收发、搜索与跟随、文件发送、参数和线路控制、录制/验证/恢复/只读回放及显式保存的工作区。录制标签可只读显示尾部，并编辑独立的未连接草稿。共享设置与 ClientState 分开，图库使用受控引用。

Node 插件、浏览器连接、LAN、实际 MCP 产品客户端交互、最低系统、真实硬件、72 小时和公开发行按后续范围验收。当前浏览器为界面预览；发布模板、代码签名与更新配置尚未启用。

## M1b 问题闭合

原评审 8 项 Important、6 项 Minor 已闭合，最终两轴复核无剩余发现。表中 M1—M6 是原 Minor 编号，不是后续阶段名称；完整产品范围仍待 M2—M6。

| 编号 | 最终状态与证据范围                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| I1   | 文档视图选择、真实菜单编辑/克隆、CAS 和独立草稿完成；定向及所属完整 CI 通过                                     |
| I2   | 终态匹配 action/完整 target/epoch，以 applied 实际值确认；错误、未知、在途编辑、取消/切换回归与完整 CI 通过     |
| I3   | 身份/代次/启动失败退休连接，资源查询失败保留独立连接；显式重附着、旧回调隔离、原生重启通过，不重放 invoke       |
| I4   | 以来源、operation ID、byte span 合并意图/回执，保持 accepted/unknown 和分块事实；本机及四目标原生检查通过       |
| I5   | SharedSettings、ClientState、字符串 revision 及正式文件/授权/媒体链路完成；四目标原生通过，选择对话框本身仍未测 |
| I6   | Windows 专用测试 cfg/import、撤权时序及 owner 真实退出修正；四目标 Clippy 和单元测试通过                        |
| I7   | 同源 Host/CLI/MCP、源码/程序哈希、独立 profile 和真实退出收据齐全；四目标原生与两端正式软件通过                 |
| I8   | Cargo 真实输出、路径等价与 target/profile 边界通过；四目标未签名原生构建全部通过，Intel 不再跳过                |
| M1   | 保存输入/完整读取输出类型分开；默认 gallery、严格存档读取、类型及所属回归通过                                   |
| M2   | 删除不能证明受理时点的片段，声明只覆盖已完成预览查询不写文档/不扩大授权；不冒称证明受理后的取消时序             |
| M3   | 删除无效 newerDraft 字面量断言；保留真实工作区切换与旧保存回执检查                                              |
| M4   | artwork 的 hover、选中、键盘焦点与 aria-pressed 反馈通过；整体界面审美审查接续执行                              |
| M5   | 真实菜单导出成功/失败/取消及切换晚结果隔离回归通过                                                              |
| M6   | 架构/安全文档按 ClientState、Host CAS 和未来格式写保护更新                                                      |

后续未验收的 Node、浏览器连接、LAN、最低系统、硬件、72h 与发行按[规划](./plan.md#当前执行与下一步)推进；原失败记录继续保留，需求账本保持跨阶段判定。

## 有效验证记录

以下为交付前各候选的历史过程，不代表当前执行状态。失败、未执行和中止保持原归属；M1b 最终验收以[当前验证](#当前验证)及 PR #40 合入收据为准。

PR #40 首轮完整 CI（[42605928424](https://github.com/YanChao001/serial-workbench/actions/runs/42605928424)，源码 `e267c52`）：前端、IPC 绑定、浏览器与 Ubuntu Rust/正式离线六场景通过，600 秒负载实际执行。四目标 Native 均未通过，最早为语言保存未落盘，随后打开 Virtual 显示 `EPOCH_MISMATCH`，后续超时不计为独立通过。macOS 两目标六个 Rust 测试因临时目录含系统符号链接被拒绝；对应 Host 夹具改在 canonical 临时根创建，安全校验不放宽。

第二轮 [42609091281](https://github.com/YanChao001/serial-workbench/actions/runs/42609091281) 对应 `8ac838c`，前端、绑定、浏览器和 macOS ARM Rust 通过，Native 仍失败。追加的 JS 调用探针只取得空数组，未形成有效原生元数据，已撤去。复审定位到首次保存递增授权代次后，多个订阅终态误占唯一应急槽，业务连接被关闭；当前改为普通交付预算优先，真正耗尽才借应急槽，全部耗尽仍关闭连接。state/raw 以新查询重新验权，恢复查询和订阅共用三次预算；Raw 保留最后处理游标与有界显示，隔离旧队列和晚结果。恢复查询被下一次合法授权打断的复审问题先复现后修正，30 项 state/raw 定向通过，完整 Native 复验待新候选 CI。串行 Native 阶段首失败即停，失败现场照常保留。M1b 阶段出口仍未达到。

第三轮 [42612025687](https://github.com/YanChao001/serial-workbench/actions/runs/42612025687) 对应 `3a57f60`：四目标 Native 均已通过首屏、并行重复启动与真实语言保存，且打开 Virtual；首失败移到保存布局后工作区菜单。截图和组件回归确认同一 scope 的 JSON 字段顺序变化会误判目标切换并丢会话关联。现已统一按 scopeId/Target 固定字段建立身份，保留外层 Host 代次隔离；菜单操作先等待真实 revision 推进及界面保存完成。70 项相关组件检查、最终类型/lint及重建当前 dist-web 后的 10 项无头工作台场景通过；较早预览产物的 10 项不计为这次修改证据。两轴增量复审无剩余发现，完整 Native 仍待修正版候选。

第四轮 [42614836830](https://github.com/YanChao001/serial-workbench/actions/runs/42614836830) 对应 `6cd0c7a`：前端、绑定、浏览器及 Windows/macOS Rust 通过；Ubuntu Rust 测试通过，正式离线 T06 实际 600.65 秒通过，但 T08 回放操作查询报 `PERMISSION_DENIED: Retained source authority is unavailable`，T03 同组后续检查未执行，任务失败。四目标 Native 首三项通过，会话关联已保留，工作区菜单仍失败。读取已安装原生驱动源码并在本地无头浏览器重放其 DOM 点击，确认不生成 pointerdown；用正常键盘展开及真实菜单进入编辑器的重放 1 项通过。现已修正 Native 输入并复用同一工作流提供 Ubuntu 三阶段预检，成功也保留源码/程序收据及 Host 退出证据；预检明确不作为完整验收。后台 Host 错误复用现有限流脱敏日志，保留错误状态，继续定位截图中的不可用提示。

`6cd0c7a` 的本机独立 target 无头桌面 Rust 库测试 153 项通过，包含真实 Host/IPC/桥接夹具，日志 `.cache/local-acceptance-rust-6cd0c7a.log`；未启动原生窗口。随后 Host 日志接线与 state/raw/report-error 定向 36 项、类型检查通过。CI 工作流与门禁脚本 8 项、actionlint 通过；Native 输入/预检增量两轴只读复审无 Important/Critical 发现。当时候选的回放查询失败，后续修正见下，完整候选验收尚未完成。

首轮单目标预检 [42619540254](https://github.com/YanChao001/serial-workbench/actions/runs/42619540254) 对应 `f3a9e66`：菜单展开、视图编辑/克隆及保存已执行，首失败移到不存在的 `textarea[aria-label]` 选择器；实际控件用关联 label，现已按该标签取 textarea。原生 DOM 点击和文本输入的本地无头重放 2 项通过。发送和草稿保存显式等待能力就绪，完成后仍按实际状态确认。截图中空草稿的“Host 不可用”来自空 TX 资格检查，并非连接错误；原有权限回归已复现误导提示，文案条件修正不放宽发送权限，发送组件 21 项、最终类型/lint及 247 ID 检查通过。该增量两轴只读复审无剩余发现。

回放接纳修正：可信来源与 queued Operation 同事务持久，来源写入失败整笔回滚；执行前继续复核，公共 DTO/wire 与留存权限不变。真实 IPC 故障注入先复现旧实现返回 queued 的失败，再由修正后的 12 项录制/回放集成检查通过；Host 库 141 项通过、1 项辅助测试 ignored，全目标 Clippy 通过，均用本机独立 target。首次精确过滤未命中测试，不计通过。增量两轴只读复审无 Important/Critical 发现；正式 T03/T08 和完整候选仍待 CI。

第二轮原生预检 [42621994158](https://github.com/YanChao001/serial-workbench/actions/runs/42621994158) 对应 `3ab71ba`，fresh 前 7 项通过，含真实视图编辑/克隆与独立草稿、配置完成与单块 TX、受控 Host 重启及不重放草稿。Host 重启收据确认旧 PID 5394、新 PID 5692、同 hostId 且 epoch=2。首失败为媒体导入后图片未加载；背景设置已保存，原失败截图在 finally 恢复背景后取得，不能据此判定失败时的媒体状态。现补清理前截图、直接媒体解析诊断及非取消错误的限流脱敏日志；相关背景/图库/媒体/日志 29 项、类型/lint及诊断截图/写盘故障注入两分支通过。诊断失败保留原加载错误，临时票据在 finally 释放；两轴增量复审发现的诊断异常覆盖问题已修正。根因与后续阶段仍待预检证据。

第三轮预检 [42624507350](https://github.com/YanChao001/serial-workbench/actions/runs/42624507350) 对应 `1228eb7`，fresh 前 5 项通过，Host 重启失败，未进入媒体诊断。旧 PID 5923 正常退出，新 PID 6228 报 `HOST_BUSY`；普通 Native RPC/订阅及设置 effects 在连接退休后隐式附着，可能抢先启动 Host。新真实 Host 回归先复现退休后请求仍成功并重新连接，再改为现有 instance/generation 约束，明确附着入口保留；本机桌面 Rust 库 154 项、桌面全目标 Clippy、收据脚本 lint 与门禁 8 项通过，两轴增量只读复审无剩余发现，原生竞态仍待 CI 复验。

收据核对发现同一 `3ab71ba` 的本机/CI 指纹不同：按 CI 未初始化 gitlink 目录的父 HEAD 回退计算，精确复得 CI 的 `ad9488ad…`，而本机已初始化子仓为 `ab391aac…`。现仅对缺失/空目录读取索引 Gitlink OID，已初始化子仓继续识别实际 HEAD，非空且无 `.git` 的未知目录拒绝。真实 Git 用例先红灯后构建收据 7 项通过；Windows 只读 Git object 夹具曾导致回收 EPERM，已限制在核验过的测试目录内处理普通文件只读位并有界回收，失败轮次不计通过。

第四轮预检 [42628184882](https://github.com/YanChao001/serial-workbench/actions/runs/42628184882) 对应 `cf4e1f8`，fresh 前 7 项通过，受控 Host 重启通过；首失败仍为媒体加载。清理前诊断确认保存选择为 media、DOM 没有背景 img；背景与图库初次解析均报当前授权拒绝，稍后对同一引用的正式 `media_resolve` 返回 image/png 成功。现对该只读解析最多额外重新验权三次，保留真实撤权/旧代次/取消及晚票据释放；新回归先 3 项失败，修正后媒体/背景/图库/设置 41 项通过，两轴增量复审无剩余发现，Native 完整阶段仍待验证。

用户再次开发启动失败：默认 debug Host PID 49744 仍占 exe，所选 profile 98 条操作均为 succeeded、无 GUI/Cargo。正常 CLI 停止后实际默认 Host/CLI 构建通过。开发入口现按两程序内容哈希准备不可变副本，15 项脚本回归及 lint 通过；实际副本 Host PID 49516 启动成功，原 Cargo Host.exe 可独占读写打开且未写入，未启动 GUI。profile、数据及已有运行任务不因暂存自动停止；Host 变更后的正常停止步骤见[开发指南](./development.md#环境与启动)。

第五轮预检 [42633373011](https://github.com/YanChao001/serial-workbench/actions/runs/42633373011) 对应 `c16cd5e`，fresh 前 10 项通过，真实媒体导入、跨窗授权引用、Host 重启及窗口控制已执行；Windows 专属全屏场景在 Ubuntu 条件跳过。启动位置设为居中后未落盘，截图显示选中状态及保存失败；本机真实草稿/图库存储与 SettingsSync 链路复现 revision 冲突。修正为仅在偏好未并发修改时重读并最多尝试三次，保留新草稿/图库；并发偏好、未来格式和存储错误继续拒绝覆盖。新增三项先失败后通过，相关六文件 100 项通过，类型/lint 通过，Native 后续阶段仍未执行。

同轮日志还发现图库解析遇到 `HOST_BUSY` 后留下空缩略图，Native 只允许一个图片解码任务。现只对读取解析最多退避五次、累计等待 2.5 秒，未放宽解码/内存预算；取消即清理计时器，授权恢复预算独立保留。三项新回归先失败后修正，相关四文件 44 项通过；原生媒体场景新增缩略图真实尺寸断言，仍待 CI 执行。偏好修正后的无头浏览器 97 场景通过（4.7 分钟），其构建早于此次媒体退避增量。一次本机命令因自动权限审核超时未启动，重试后执行成功，不计为测试失败或通过。

第六轮预检 [42637613940](https://github.com/YanChao001/serial-workbench/actions/runs/42637613940) 对应 `79beb39`，本机与 CI 源指纹同为 `e39217b2…`。fresh 前 12 项通过，偏好重置和真实图库缩略图均已执行；首失败为双窗口语言同步。新窗口读取原生偏好前仍可选择临时默认中文，本机延迟读取用例已复现；现读取完成后才启用 Native 语言选择器，原生交互等待启用，并先核对次窗口保存再断言主窗口同步。相关三文件 61 项通过，浏览器即时选择保留；第一版保护误及浏览器及新增测试使用 JSDOM 未支持的指针 API，已改为 Native 边界和既有键盘路径，失败轮次不计通过。原生同步根因和后续阶段仍待复验。

`79beb39` 的本机 Windows 正式软件六场景全部通过：18 断言、T06 实际 600.7878651 秒、602 样本，11 个自有进程均记录退出；T03 的退出结算/重启不重放及 T08 回放查询完整通过。源码收据和原始证据位于 `.cache/evidence/m1b/79beb398ab2dfff24e5b32fcbfb34c3c06a95baf/`，使用独立 target/profile 和 Virtual 软件通路，未启动 GUI。它不代替 Ubuntu 离线命名空间或真实硬件验收，后续改动仅涉及语言控件与 E2E。

第七轮预检 [42641511204](https://github.com/YanChao001/serial-workbench/actions/runs/42641511204) 对应 `2f4fff0`，fresh 前 12 项通过；双窗口场景已确认次窗口保存中文及主窗口接收，反向同步在第 654 行超时，尚未闭合。现补主窗口英文落盘读回、清理前两窗口语言/revision/控件现场及 Native 设置各边界的稳定错误码日志，区分保存与订阅问题；该增量用于定位，未宣称已修复。完整本机 Vitest 最终为 113 文件/1813 项通过，日志 `.cache/m1b-final-vitest.log`。诊断接入曾暴露 mock 缺接口及浏览器错误边界的日志期望差异，已将日志收窄到 Native 并完善夹具；失败轮次不计通过。

第八轮预检 [42645720271](https://github.com/YanChao001/serial-workbench/actions/runs/42645720271) 对应 `4281838`，两窗口读回均为英文/revision 10，次窗口仍显示中文；日志明确为 `Settings attachment: PERMISSION_DENIED`。首次工作区元数据刷新失败的 catch 会误清理已认证连接，连带停止设置订阅；后续刷新原有保留逻辑未覆盖此初始化路径。本机两项先复现 connection 变为 undefined，再修正为资源查询失败留在工作区、保留连接与独立订阅，真实身份/代次失败仍退休，明确刷新继续使用原连接且不 invoke。相关两文件 62 项、最终完整 Vitest 113 文件/1815 项、类型/lint/格式通过；原始红绿及完整日志分别为 `.cache/m1b-first-refresh-red.log`、`m1b-first-refresh-green.log` 和 `m1b-first-refresh-full.log`，原生复验待执行。

第九轮 Ubuntu 预检 [42649314709](https://github.com/YanChao001/serial-workbench/actions/runs/42649314709) 对应 `5395898`，fresh 14 通过/1 个 Windows 专属条件跳过、persisted 2 通过、centered 2 通过。双向语言同步、媒体及实际缩略图、Host 重启和跨进程恢复均执行；本机与 CI 源指纹同为 `e359af28…`。相邻 Host/CLI/MCP 收据匹配，两个 Host 退出码为 0，三个桌面进程由 runner 停止并记录实际 SIGTERM 退出；预检不计里程碑验收。

随后同一冻结候选的完整 CI [42650634093](https://github.com/YanChao001/serial-workbench/actions/runs/42650634093) 已结束：前端、绑定、Windows/Ubuntu/macOS ARM Rust，以及 Ubuntu/macOS 两架构的 Native 三阶段通过；浏览器、Windows Native、macOS Intel Rust 失败，质量门禁失败。四目标 Clippy 通过；macOS Intel 的无 bundle 构建在测试失败后跳过，其余三个目标通过。Ubuntu 正式离线六场景全部通过、18 断言，T06 实际 600.642517544 秒、602 样本，11 个自有进程均记录实际退出，原始证据位于 `.cache/ci/42650634093/host-offline/`。该结果不代替最终候选或 Windows 真实硬件。

本轮已收齐并一并修正三个失败：浏览器 Native 日志命令 `record_frontend_error` 缺少明确 fixture 分支，本机先复现 4 失败/1 通过，补齐后 5 通过；Windows 标签点击后立即读取草稿存在渲染竞态，截图最终内容正确，本机原生 DOM 点击探针确认同任务内仍读旧值，现等待选中状态和精确草稿并重新定位元素，保留两份草稿落盘断言；macOS Intel 撤权使旧授权代次的租约自动取消，旧测试却断言其仍为运行态，本机等待清理后稳定复现失败，现先验证 Cancelled/Expired，再严格检查被拒绝调用前后操作全值及无新增副作用，action_check 8 项及对应 Clippy 通过。完整本机无头浏览器 97 场景通过（3.9 分钟），两轴增量复审均 0 项；日志 `.cache/m1b-browser-fixture-red.log`、`m1b-browser-fixture-green.log`、`m1b-revocation-red.log`、`m1b-revocation-green.log`、`m1b-browser-full-post-ci.log`。新增预检目标选择只使用四目标 runner 白名单；默认 Ubuntu，当前先复验实际失败的 Windows，完整门禁范围不变。M1b 仍未达到合入出口。

三处修正后的本机 `pnpm verify --jobs 1` 最终九步骤通过：113 文件/1815 项 Vitest、290 项工程脚本通过和 4 项平台条件跳过，以及格式、lint、类型、配置、品牌、版本与生产构建，耗时 148.7 秒，日志 `.cache/verify/run-pnskA4/`。首轮综合检查拦住新增预检测试的一处正则空格 lint 错误，已改用数量表达式，失败记录 `.cache/verify/run-s3X48O/` 保留，不计通过；修正后门禁/账本相关 36 项、247 ID 校验及 actionlint 通过。此增量仅修改测试、CI 和文档，生产源码相对 `5395898` 未变。

`4c144bb` 的 Windows 预检 [42658974267](https://github.com/YanChao001/serial-workbench/actions/runs/42658974267) 三阶段全部通过：fresh 14、persisted 2、centered 2；源码指纹 `b0af3cc0…` 与本机一致，两个 Host 正常退出，三个桌面进程均记录 runner 控制结束后的实际退出。随后同源码完整 CI [42660234584](https://github.com/YanChao001/serial-workbench/actions/runs/42660234584) 门禁失败：前端、绑定、浏览器、Windows/Ubuntu Rust 和 macOS Intel Native 通过；Windows Native 前 13 项通过，最后设置保存期间意外断链；macOS Intel Rust 的关闭测试发现 owner join 未回收；Ubuntu Native 在安装依赖 8 分钟后超时，未执行用例。两个 macOS ARM 任务未取得 runner，由 GitHub 因容量不足取消，未执行检查；不计代码失败或通过。

本轮运行证据推翻此前静态复审的 0 项结论，确认三个真实生命周期缺口并已本机先红后绿：取消或失败订阅的残帧永久进入 early，达到 256 后断开无关订阅；零字节旧帧撤权也关闭整个控制连接；completed/Closed 早于 owner 线程退出时，首次关闭、重复关闭及 shutdown 都可能提前成功。修正分别限制在途 requestId 暂存并在终结时释放、按实际写入字节决定丢弃或断链，以及在原 250ms 内等待后端与线程真实退出。Native bridge 51 项、IPC 写入边界 12 项和完整 Host 库 144 通过/1 个辅助用例条件忽略；最终跨包与原生复验继续执行。红绿日志保留为 `.cache/m1b-late-subscription-red.log`、`m1b-pending-frames-green.log`、`m1b-zero-byte-red.log`、`m1b-zero-byte-green.log`、`m1b-owner-exit-red.log` 和 `m1b-lifecycle-host-full.log`。Windows/Ubuntu 旧正式软件证据保持历史归属，本轮修改 Host 生产源码后必须取得新的同源正式六场景结果。

Linux Native 仅调整环境准备：非交互、减少推荐包并明确保留显示认证/字体/媒体解码依赖，安装预算 12 分钟；未增加用例超时或缩减场景。预检按目标分开并发，用于先复验 Windows 断链与 Ubuntu 环境安装。macOS ARM 容量取消必须在最终候选重新实际执行，不能拿旧成功记录替代。

补充复审发现第 4 项 P1：已有零字节证明的客户端动作仍经普通 Err 结算为 Unknown。真实 writer/Store/Host 回归先由 `operation.get` 读到 Unknown，现对明确未投递发送确定 Failed，保留 PERMISSION_DENIED 且无伪造平台回执；断连、超时及部分写入仍保持不确定结果。IPC 13 项、客户端动作组件 19 项和真实 IPC 4 项通过，两轴最终静态复核均为 0 项剩余发现。有效行为红/绿日志为 `.cache/m1b-client-effect-zero-red-settlement.log` 与 `m1b-client-effect-zero-green.log`；此前新增夹具的编译/Store 接线失败日志也保留，不计为业务复现。

本轮 `pnpm verify --jobs 1` 九步骤通过，耗时 183.7 秒，日志 `.cache/verify/run-O3aq8S/`；Rust 与最终检查结果另列。六个无窗口包的首轮并发构建因 Windows 页面文件不足、mmap 报 os1455 失败，记录 `.cache/m1b-lifecycle-backend-full.log`；已用 `--jobs 2` 复验通过，保留独立 target 缓存，未修改系统页面文件。新的正式六场景和 CI 仍待取得结果。

最终受限并发检查已收齐：同源 Host/CLI/MCP 与正式场景 harness 重建通过；core/ipc/host/client/cli/mcp 六包完整测试通过，日志汇总 579 通过、5 个受控子进程入口忽略，记录 `.cache/m1b-lifecycle-backend-bounded.log`；桌面库 158 项通过，Host/桌面 all-targets Clippy 与 Rust fmt 通过。首轮 Clippy 拦住早帧接线的两处可合并条件，等价修正后通过，原日志 `.cache/m1b-lifecycle-clippy.log` 保留，最终日志 `m1b-lifecycle-clippy-final.log`、`m1b-lifecycle-desktop-full.log`。本机检查完成后冻结源码；新的 Windows 正式六场景/实际 600 秒及 Windows/Ubuntu Native 预检可在各自独立环境并行，三者通过后再执行最终完整四目标 CI。

冻结候选 `95de4d1` 的 [Windows 预检 42673489430](https://github.com/YanChao001/serial-workbench/actions/runs/42673489430) 和 [Ubuntu 预检 42673497000](https://github.com/YanChao001/serial-workbench/actions/runs/42673497000) 均通过，源指纹同为 `a8bf3d4e…`，Host/CLI/MCP 收据匹配。各为 fresh 14 通过/1 条件跳过、persisted 2、centered 2；Windows 驱动无 wheel 派发能力、Ubuntu 无 Windows 专属全屏，不计通过。各两个 Host 正常退出、三个桌面进程受控停止并记录实际退出，Ubuntu 安装实际 48 秒。

同候选本机 Windows 正式软件失败：T01/T03/T04/T05/T08 通过，T06 实际运行 600 秒/602 样本后，`capture.stop` 的最终清单替换返回 OS5，三个最终断言未执行。失败 profile、manifest=failed、pending=complete 和原始记录保留于 `.cache/evidence/m1b/95de4d191b947d9e6c5b08b1baad1f4a6927b84a/software-windows/` 及 harness 指明的临时 profile。短回归已复现直接 MoveFileExW 拒绝合法共享读者，真实 API 差分确认标准库重命名包含可成功的 FileRenameInfoEx 回退；实际失败瞬间的句柄归属尚未知，不指认为特定外部进程。现仅元数据替换使用该回退，同一 RW 句柄跨更名并再次同步；持续禁止删除共享、只读和禁止覆盖仍拒绝，不加等待重试。正式软件失败不能由预检通过覆盖。

原子替换增量本机检查通过：Host 库 145 项及所有目标通过，日志 `.cache/m1b-capture-host-full.log` 汇总 43 个结果组、464 通过、2 个由父用例调用的子进程入口 ignored；Unix PTY 的 0 项不计覆盖。包含真实 writer.finish 持有旧清单读者仍完整读回、100 次共享替换、禁止删除共享的失败证据及显式重试、只读和禁止覆盖。最后只读夹具恢复原权限的 4 项复验通过，不另加为独立总数；全目标 Clippy 和 Rust fmt 通过，记录 `m1b-capture-metadata-final.log`、`m1b-capture-clippy-final.log`。首轮 Clippy 拦住夹具的 set_readonly(false)，旧失败日志保留。两轴最终增量复核均 0 项；新冻结候选的正式软件、原生预检及完整四目标门禁仍待执行。

`6b69a83` 原子替换候选的 [Windows 预检 42679974596](https://github.com/YanChao001/serial-workbench/actions/runs/42679974596) 与 [Ubuntu 预检 42679980840](https://github.com/YanChao001/serial-workbench/actions/runs/42679980840) 均通过，三阶段各为 14 通过/1 条件跳过、2、2，源指纹同为 `e83d2cdb…`。本机正式软件六场景/18 断言全部通过，T06 实际运行 600 秒且完成清单提交、独立读回，11 个自有进程均记录退出；证据位于 `.cache/evidence/m1b/6b69a83c4d4a69f85b90de938095a88611bca8cd/`。

Windows 成功预检仍记录 Host workspace 查询及 Settings effects 的权限错误，后两条没有显式撤权故障注入；现有落盘断言不能证明当前窗口最终错误提示清除。复核发现设置在原生效果仍在途时提前报告 saved，本机延迟原回执先复现失败，现按连接、已提交 revision 和重试批次记录真实完成，在途保持 saving、旧代次晚结果忽略、失败保留明确重试。设置 Provider/状态提示/设置页 66 项通过，日志 `.cache/m1b-effects-pending-red.log`、`m1b-effects-pending-final.log`。

原生最后用例等待真实状态终结并检查当前 Settings 页的 role=status、alert 和错误 toast，保留 `final-settings-ui.json`；证据写盘失败不覆盖原检查异常。该检查不证明离页的 workspace 查询已经恢复，也不额外执行效果命令制造成功。旧软件结果保留源码和程序哈希归属，新候选复用相同无窗口程序时必须逐一证明编译输入与程序字节一致；前端变更重新进行本机综合/浏览器及原生验收。

设置完成状态增量的最终本机检查已收齐：`pnpm verify --jobs 1` 九步骤通过，113 文件/1818 项 Vitest、290 工程脚本通过及 4 条件跳过，耗时 153.3 秒，日志 `.cache/verify/run-rqpPlI/`；无头浏览器 97 项通过，耗时 6.1 分钟，记录 `.cache/m1b-effects-browser-full.log`。首轮综合 lint 拦住诊断代码在 finally 中抛异常的写法，改为保存原异常、写证据后再统一重抛，原失败记录 `.cache/verify/run-EryNY4/` 保留。两轴增量最终复核均 0 项；冻结后仍需新的 Native 预检和完整四目标门禁，尚未合入。

`d830774` 的 [Windows 预检 42688068119](https://github.com/YanChao001/serial-workbench/actions/runs/42688068119) 三阶段通过，最终 Settings 页状态文件无 alert、错误 toast 或保存等待；[Ubuntu 预检 42688076153](https://github.com/YanChao001/serial-workbench/actions/runs/42688076153) fresh 12 通过/1 失败/1 条件跳过，在双窗反向同步超时，未执行后续用例。实际双窗现场为主窗和 Host 均英文/revision 10、次窗仍中文，原日志与诊断位于 `.cache/ci/42688076153/linux/`；Windows 证据位于 `.cache/ci/42688068119/windows/`。日志不足以断定是哪一个查询触发，不能用 Windows 成功覆盖 Ubuntu 失败。

本机分别复现普通初始化读取、已接纳操作终态读取和游标恢复被授权变化打断的失败，并确认成功游标恢复仍累计旧预算。现普通查询在共享连接入口最多三次读取，保留 actor/epoch，不重新授权、附着或重放 invoke；状态 SDK 使用原内部预算，完整 setup 成功后才归零。真实 SettingsSync/适配器/transport 回归确认中文提交后远端英文不再被旧输入遮住，且仅一次保存；持续拒绝、epoch、取消和迟结果对照保留。取消时还复现了两层等待器未观察已开始 Promise 的迟拒绝，已修正；79 项相关回归无未处理错误通过，类型/lint 通过。新夹具的类型/序列化修正及所有失败日志保留；最终综合、浏览器和新候选验收仍待收齐。

最终复核另确认早到合法 delta 会在 setup 结束前清零预算，紧随结束帧可绕过连续失败上限。两组旧实现实际开通 6 次、严格预期 4 次的红灯保留为 `.cache/m1b-buffered-delta-budget-red.log`；现仅完整安装并处理完早帧、代次仍有效时设为 ready，后续正常 delta 才可清零。两类终态×有无合法早帧的四组对照均保持 4 次开通和各句柄只关闭一次。最后 81 项相关回归无未处理错误及类型检查通过，日志 `.cache/m1b-query-recovery-focused-final.log`、`m1b-query-recovery-types-final.log`。综合 run-zAZTAl 因该新确定问题主动中止，不计通过；最终全集继续待验。

读取恢复增量最终检查通过：`pnpm verify --jobs 1` 九步骤，113 文件/1833 项 Vitest、290 工程脚本通过及 4 条件跳过，耗时 185.3 秒，日志 `.cache/verify/run-4LwFp1/`；无头浏览器 97 项通过，耗时 6.2 分钟，记录 `.cache/m1b-query-recovery-browser-full-final.log`。两轴最终复核均 0 项。以上修正未改变 Rust 和无窗口验收输入，复用原软件运行须继续核对四程序哈希；本轮冻结后仍需对应 Native 预检及完整四目标结果，不以旧通过替代。

`c16cd5e` 本机综合 `pnpm verify --jobs 1` 九步骤通过：113 文件/1806 项 Vitest、290 项工程脚本通过及 4 项条件跳过，以及格式、lint、类型、配置、品牌、版本和生产构建，总耗时 166.6 秒，日志 `.cache/verify/run-otne7u/`。该结果早于上述偏好保存修正；其增量由 100 项定向回归覆盖，最终候选仍需完整 CI。

授权恢复第一版的本机 `pnpm verify --jobs 1` 九步骤通过：113 文件/1800 项 Vitest、工程脚本及格式/lint/类型/配置/品牌/版本/生产构建，日志 `.cache/verify/run-cmZ91v/`。该次全量 Vitest 早于最终恢复查询竞态与 scope 身份修正；最后变化由上述定向检查及新候选 CI 继续验证，不将混合源码时点的检查写作最终候选验收。

当前切片本机使用 Windows x64、Node 26.13.0、pnpm 12.16.1、Rust 1.99.1。`pnpm verify --jobs 1` 九步骤通过：113 文件/1793 项 Vitest、286 项工程脚本通过和 4 项平台条件跳过，以及格式、lint、类型、配置、品牌、版本和生产构建；日志 `.cache/verify/run-F2Nfbj/`。项目 doctor、247 ID 账本检查与 `cargo fmt --all -- --check` 通过；显式 Windows target 同源 Host/CLI/MCP 构建通过。

`pnpm test:ui` 无头浏览器 97 场景通过，已查看图库深色选中反馈截图。其后的可见 TX 行间时间修正由定向 36 项及上述完整 Vitest 覆盖；最终候选浏览器和 Native 场景仍由四目标 CI 复验。本机未启动真实测试窗口或安装器；Rust workspace 检查为释放用户 `app:dev` 所需的共享构建锁而中断，不计通过，完整 Rust/Clippy 与正式六场景交由独立 CI。

整体复审：规范轴 0 项，需求轴发现 2 项（TX 合并后行间增量、Native 恢复视图后未显式关联 Virtual 会话），均已修正，增量复核确认两项消除。行间增量先复现为 10ns/预期 20ns，再由回归确认 20ns；Native 修正等待 CI 实际执行。

环境与失败记录：默认 shell 的 Node 22.22.2 低于 engines，已在忽略缓存中准备并核对官方 SHA-256 的 Node 26.13.0，未替换系统工具；受限环境的脚本回收因 taskkill 拒绝访问失败，在允许回收自有进程的环境复验通过。默认 debug Host.exe 被既有 PID 22536 占用导致构建拒绝覆盖，改用显式 Windows target 构建三程序。用户随后启动开发遇到同一占用；核对旧 Host 全部 8 项操作均为终态后，用 CLI 正常停止并确认旧实例实际结束，新开发启动已进入 `cargo run`。完整本机 Rust 检查同时中断以释放共享 target，后续完整验收使用独立 CI。

首轮综合 Vitest 有 2 项失败，原因是日志测试冷导入超过断言时限并晚到污染下例；已将冷导入放入等待完成的夹具准备。第二轮脚本有 2 项 Windows 清理探测超时；改为 WMI 仅查询 PID/程序路径，保留失败即拒绝清理的边界，定向 25 项和最终完整检查均通过。前两轮原始日志保留于 `.cache/verify/run-3EeEEL/`、`run-jkXKnq/`，不将它们计作通过。

2026-11-09，基于 `9dd188e` 整理测试：Vitest 从 1,788 项精简为 1,779 项，113 文件全量通过；受影响工程脚本 10 项、浏览器 9 场景及类型/lint 通过，浏览器现共 97 场景。移除自建 JSX/CSS 扫描器、过期配置文本及重复测试，将无障碍扫描统一到明暗主题的整页检查。Rust 源码和测试保持原范围。

2026-11-09，本轮 PR #38 源范围，Windows x64 / Node 24.22.1 / pnpm 12.16.1：

- `pnpm verify --jobs 1` 九步骤通过：1,788 项 Vitest；289 项工程脚本通过、4 项平台条件跳过；格式、lint、类型、配置、品牌、版本与生产构建通过。
- 受影响七文件 166 项组件测试通过，包含工作台菜单、配置、Host 与离页协商；与上述全量结果有重叠。
- `pnpm build:web` 与单 worker 无头 Playwright 全部通过，共 102 个浏览器场景。
- `cargo fmt --all -- --check` 通过；本轮未重跑 Rust 编译/Clippy、原生窗口及四目标 CI。
- `pnpm install --frozen-lockfile --offline` 通过，store 位于项目 `.pnpm-store/v11`；未修改 pnpm 版本或锁文件。

以下为历史源范围：

| 源范围               | 结果及适用范围                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端候选 `9e0e0ed`   | [CI 42505905397](https://github.com/YanChao001/serial-workbench/actions/runs/42505905397) 12/12 成功，含四目标 Rust/构建和当时桌面源码的 E2E；PR #37 已合入 |
| 后端正式软件 run6    | 六场景、18 断言通过；T06 实际 600.59486 秒、602 样本、最大间隔 1.131 秒，末值 6,919,040 字节；11 个自有进程均记录退出                                       |
| 工作台候选 `0c2ca56` | [CI 42548255152](https://github.com/YanChao001/serial-workbench/actions/runs/42548255152) 2 成功、10 失败；通过项为浏览器 102 项与绑定检查                  |
| 该候选 Unix Rust     | Linux/macOS 的 Windows-only 测试 import 导致 Clippy 失败，后续 Ubuntu 离线六场景/600 秒未执行                                                               |
| 该候选 Windows 构建  | fmt/Clippy/workspace 测试和桌面编译通过，包装器随后因输出目录比较失败，正式构建出口失败                                                                     |
| 该候选原生 fresh     | Linux 3 通过/8 失败/1 跳过；Windows 4/7/1；macOS Intel 与 arm64 各 3/7/2。存在旧接口失败，跨窗同步和持久化准备超时待定位；后续阶段未完成                    |
| 该候选前端综合 CI    | runner Unicode 编码异常，完整日志未取得，产品综合检查结果未知                                                                                               |

后端 run6 软件负载：吞吐 11,520.3201 B/s，进程树 RSS 峰值 206,241,792 B；source/reader/capture queue 峰值 16,879,922 / 5,941,160 / 4,361,320 B；控制延迟 p50/p95/p99 为 115.5142 / 182.2505 / 200.4717 ms。4 KiB credit、10 秒慢读、Gap/hash/offset 与生产预算保持，慢读工作集 128 KiB、回放页数 100 是 harness 前提修正。

候选前的历史本地记录：工程九步骤包含 1765 Vitest 和 286 脚本项，另有 4 项条件跳过（Unix 进程组、Windows symlink 权限、两项交互 NSIS）；Rust 全量 733 通过、1 失败、5 helper ignored，MCP 合法 fixture 修正后仅该 target 3/3；录制尾部后续三场景、四次 axe 通过，接收正文在 1120×744 / 880×600 为 283 / 139 px。它们属于不同源范围和子集，不相加，也不覆盖停手草稿；原始本地证据已删除。

## 下一步

完成 M1b 交付状态同步后，按用户安排在独立环境逐张审查界面截图并记录问题，再接续 M2；任务和出口见[规划](./plan.md#当前执行与下一步)。真实硬件、最低系统、实际 72h、LAN 双机、安装签名与发行继续单独记录，不以当前软件检查替代。
