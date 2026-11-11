# 开发进度

更新：2026-11-11。M1b 与本轮界面软件切片均已交付；PR #42 已 squash 合入 main。最终完整四目标 CI 的 12 项必需任务全部成功。解锁后的 COM14 开发版短回环及正常关闭复测通过，开发启动就绪仍观察到 7.8—9.4 秒，速度问题未闭合。按用户要求暂停总目标，不推进 M2—M6。最低系统、实际 72h、完整硬件及发行等范围仍未验收；整个目标尚未完成。

## 当前基线

- 本轮界面软件通过 [PR #42](https://github.com/YanChao001/serial-workbench/pull/42) squash 合入 `main@1154b89f3b6eb59a1668bcef9c2bc6b245c88fc3`。候选 `2f3d06441f62f2e5a4f785dfc6cb7e4245305939` 与合入树完全相同，重新计算源码指纹均为 `6fd5e73698eb122c069bf3fd6647a88a9c4b3c3c851872ebaca698874e91870e`；收据在 `.cache/evidence/ui/1154b89f3b6eb59a1668bcef9c2bc6b245c88fc3/delivery.json`，实际源码、程序、日志和验证结果在相邻候选证据目录。后续状态同步仅修改文档与账本。
- M1b 通过 [PR #40](https://github.com/YanChao001/serial-workbench/pull/40) squash 合入 `main@7b466df28bf255a325ed8275612ffb4400a06001`。候选 `9283f22463106a785834d055fb55f86a5aa14195` 与合入树完全相同；重新计算源码指纹均为 `86a459f87deab7e1077ae7caf2ca18897027b73c6b8d225e50e8f8b6c5177d37`。
- M1b 交付时主工作区 `D:\yanchao\Codex\serial-workbench` 已 fast-forward 到该 main 并核对干净，自有分支已清理；后续 PR #41 状态文档已合入 `main@7a8e81a`。本轮 UI 切片从该主线创建 `fix/workbench-ui` 并已由 PR #42 交付；后续切片继续从最新 main 创建短期分支。未修改 marketplace，未清理指定备份、用户数据或编译缓存。
- 247 条需求账本校验通过：76 个跨阶段软件项仍为 in-progress、168 个 not-started、3 个 not-applicable；76 个 M1 切片已登记并合入 PR #40 证据。切片交付不提升其后续软件、硬件或发行范围，也不把 247 条全部记为完成。
- 真实硬件仅做 Windows，macOS/Linux 做实现与虚拟测试。COM14 为 CH340（VID 1A86/PID 7523）；用户确认 TX/RX 已短接、可按测试需要选择参数。驱动重装和重启后，9600/115200、8N1、无流控的独立系统及当前 Host/CLI 定向回环均通过；此结果不代替完整硬件矩阵、GUI 或 M6 验收。最低系统、实际 72h、Windows LAN 双机、专业设备、安装签名及发行仍未验收。
- 合入/同源收据位于 `.cache/evidence/m1b/7b466df28bf255a325ed8275612ffb4400a06001/delivery.json`；候选源码、程序哈希、日志与软件/原生证据位于 `.cache/evidence/m1b/9283f22463106a785834d055fb55f86a5aa14195/`。历史失败保持原源码归属。

## 当前验证

[最终完整 CI 42916751468](https://github.com/YanChao001/serial-workbench/actions/runs/42916751468) 对候选 `2f3d064` 的 12 项必需任务全部成功：四个 Rust、四个 Native、前端、浏览器、绑定及质量门禁；另 1 项预检占位按完整模式跳过。四个平台普通原生程序均构建成功，没有打包、签名或发布。PR #42 已合入，合入树与验收候选及源码指纹均实际核对一致。

浏览器 128/128；Native fresh 为 Windows/Linux 各 26 通过/1 条件跳过，macOS ARM/Intel 各 25 通过/2 条件跳过，四目标 persisted/centered 各 2 通过。四份 ZIP 摘要、完整源码与四程序收据、12 份阶段原始日志已核验，RPC/订阅四类冲突全部为零；EOF 只出现在各目标安排的 Host 重启，正常关闭不新增 Raw 故障（Linux 0→0，其余三个目标 1→1，实际观察 2024—2057ms）。11 张窗口内截图中 7 张与已审图同 SHA256、4 张变化图已重新查看。

Ubuntu 正式离线六场景的 18 条断言通过，实际负载 `600.440496826s`、602 个样本，wrapper 总计 `610.288377034s`，11 个自有进程全部退出。已复核网络隔离、原始遥测、程序来源与清理；它属于 M1 软件参考负载，不替代 M6 的实际 72 小时及硬件矩阵。

本机完整 verify 的 2105 应用测试、309 工程脚本/4 条件跳过及其他检查和构建通过；之后 EOF 日志修订另由同源三程序、完整 Rust workspace 773 通过/5 原条件忽略/0 失败、workspace all-targets Clippy/fmt、相关 E2E 检查 5/5 和 JS lint/格式覆盖。各轮源身份独立保留，最终候选的完整门槛以本轮 CI 为准。

36 项用户界面反馈在记录的软件/浏览器范围完成修正；COM14 GUI 补充结果及启动速度缺口见下。当前电脑字体/DPI、系统选择对话框、最低系统、实际 72h、完整 Windows 硬件、LAN 双机、安装签名及发行保留未测。开发窗口、原 Host、草稿、指定备份和编译缓存保留。247 条需求账本的状态仍为 76 个软件 in-progress、168 个 not-started、3 个 not-applicable；本轮 35 个相关软件项已登记 PR #42 交付证据，最终 CI 通过记录位于该 PR 与本节，没有提升硬件或发行状态。

### COM14 解锁后现场复测

2026-11-11 08:47—08:58（北京时间），在用户安排的前台时段，从干净 `main@9a12ec2711216a94a1c71fb97db7358c8240b079` 运行 `pnpm app:dev`，使用普通 profile 与原 Host。源码指纹为 `d669f25f8c7ef885cfad8655adeadd91fcbb5fcff67db09263652eab27aae0f0`，相对已验收实现仅变更状态文档。实际 GUI PID 33636、SHA256 `ace956c7a2ffef024344859ee6b417ee7924d69f27d40ebb447bcd8c8cd0333c`；保留 Host PID 47088、SHA256 `182ab55ff93b49aeeb595f2ba949960f56eba19b0344ca04b9a9a88cde58ee15`，没有为本次重建或重启该 Host，不将其冒称为当前 GUI 同源重建产物。

本次恢复测试中的首次显式打开成功；这是已有普通 profile/Host 的复测，不是新 profile 或冷 Host 首连。连接参数界面读回为 9600、8N1、无流控，本次未改参数。自建独立视图，文本 `CUA-FINAL-COM14-OK` 发送 18 字节，实际 RX 分为 1+17 字节并精确拼合；切换 HEX 后草稿转换为相同 18 字节，再次发送与 RX 精确一致，两次回执均完成。TX 绝对偏移为 78、96，未把既有历史字节算入本次 36 字节结果，也未发送原中文草稿。

08:48:07 发起打开至 08:56:31 主动关闭之间的多次界面采样未见连接/断开反复切换；这是约 8 分 24 秒的点状观察，不是连续稳定性遥测。关闭后超过 2 秒的界面复核未见新增 Raw 故障通知，08:58:17 独立只读 Host 元数据确认 COM14 为 closed，既有 virtual:echo 仍为 open。测试视图已关闭，原 78 字节草稿完整保留；未保存布局，原 Host、开发窗口及既有虚拟会话保留。

两次开发启动日志的 frontend-ready 分别为 9362ms、7757ms；前一次因用户误关窗口结束后重新启动。该值不含 Cargo 编译，属于开发模式启动阶段，不能当作 release 冷启动指标，也不能据此宣布响应速度已修好。证据、UIA 原始记录、环境及程序摘要在 `.cache/ui-audit/com14-foreground-20261111-0847/summary.json`，启动日志为 `.cache/ui-audit/dev-com14-final-retest-20261111*.log`；原生截图已在工具结果中查看，没有本地 PNG 文件。本次只补一组参数下的两个短包与关闭，不提升完整 Windows 硬件、最低系统、72h、LAN 双机或发行验收状态，总目标保持暂停。

### 收尾过程记录

以下保留各候选发生时的执行状态、原失败与修正经过；当前交付和暂停状态以上述汇总为准。

日志修订后的本机检查全部通过：先实际构建同源 Host/CLI/MCP，再执行 `cargo test --locked --target-dir .cache/local-acceptance-target --workspace --no-fail-fast`，71 组结果汇总为 773 通过/5 原条件忽略/0 失败，包含桌面库、CLI 关停与真实程序交叉测试；workspace all-targets Clippy 和 Rust fmt 通过。运行输入 source `9c119998673422eb338d6b6feae8ffb980fa431faf32b4499ddf1ed1715357f9`，之后仅更新状态文档；日志为 `.cache/ui-audit/gui-final-rust-*-2.log`。本机以 jobs=2 保留独立 target 缓存，完整测试程序编译 13m42s，不与 CI runner 耗时混比。相关 E2E 日志检查 5/5、JS lint/格式和 247 条账本通过。当前冻结修订候选后运行完整四目标，不以旧 Native 通过替代新门槛。

候选 `092d564460f48f1ef587711aeeb8221505547d0f` / source `391df233dd991ba8776c0525a7150bd7bd634e7d93d89ba55b6fe629b1e5f312` 的[完整 CI 42911090428](https://github.com/YanChao001/serial-workbench/actions/runs/42911090428) 已结束：前端、绑定、浏览器 128 项、四个 Native 通过；四个 Rust 均且仅在 CLI 的 `host_stop_waits_for_the_attached_instance_lock_to_release` 失败，质量门禁失败。原因是本轮新增的普通 EOF 告警污染成功命令 stderr，不是关停锁断言失败；Ubuntu 后续正式六场景未执行，不计通过。完整日志保留于 `.cache/ui-audit/gui-final-092d564-complete-ci.log`。

四份 Native ZIP 摘要及各自源码/四程序收据已核对，12 份阶段日志的 RPC/订阅四类冲突全部为零，11 张窗口内截图已逐张查看。fresh 为 Windows/Linux 各 26 通过/1 条件跳过，macOS ARM/Intel 各 25 通过/2 条件跳过，四目标 persisted/centered 各 2 通过。正常关闭在 Windows/Linux/ARM 为 Raw 0→0，Intel 为 1→1；Intel 非零基线对应实际安排的 22:13:11 Host 重启（停止命令接纳与进程退出已核对），关闭观察实际 2012ms，没有新增 Raw 故障。不得将整轮 Rust 失败改记为完整成功。

上述 CLI 失败已在本机同一实际测试复现（1.29 秒，`.cache/ui-audit/gui-cli-stop-diagnostic-red.log`），普通 EOF 改为 debug 后原断言通过（8.61 秒），真正读错仍保持告警；独立 Native 程序显式使用调试日志以保留 EOF 时刻，普通 Host/CLI 级别不变。相关 E2E 检查 5/5 及 JS lint/格式通过。随后本机同源三程序、完整 Rust 工作区及 Clippy/fmt 均通过，见本节首条；未变的前端结果保持原来源，后续完整四目标候选仍须独立通过。

最终本机复查（普通用户、`pnpm verify --jobs 1`，`.cache/verify/run-f7g9iF/`）全部通过，187.0 秒：129 文件/2105 Vitest、309 工程脚本/4 条件跳过，以及格式、lint、类型、配置、品牌、版本和最终 Vite 构建。输入 source `6a89e009426e526cafa6c0a7b6ae740f289d96ec57b6e70b7b2f56b63ea0bac3`；之后仅同步本条状态文档，再检查格式与账本。与 Intel 预检候选的运行时代码无差异，两个测试夹具修正保留原断言；前两轮失败仍保留原记录。下一步以完整四目标 CI 核对同一冻结候选，不用预检替代最终门槛。

候选 `e20d2b98cdaf07d35dd6f35dfa21a0e3fe4fc688` / 源码 `6cc4aeea82860d0b2602b8571a46325ba9f32b31e5262d58cdc83b757c935ec5` 的 [Intel 原生预检 42903896976](https://github.com/YanChao001/serial-workbench/actions/runs/42903896976) 通过：fresh 25 通过/2 条件跳过，persisted/centered 各 2 通过；三阶段全部四类冲突计数为零，正常关闭 Raw 为 0→0（实际观察 2073ms），RPC EOF 只出现在安排的 21:29:32 Host 重启，没有额外关闭。ZIP 摘要 `c498beec052d667bc171b3cd19f1da061a28d432d62b3333f62144723427f6bc`、日志摘要及四入口收据已核对。单次 Cargo 构建中 core/ipc/client 各编译一次，前轮均为两次；总编译 4m31s，前轮两段合计约 4m13s，尚不能宣称整轮提速。

同候选本机整轮 verify（普通用户、jobs=1）退出 1：129 文件/2105 Vitest、309 工程脚本/4 条件跳过，以及格式、类型、配置、品牌、版本通过；新增 HTTP 测试夹具存在 no-empty/prefer-const 两处 lint，最终构建未执行。当前只补排空请求体的注释、将可取消清理所用 client 初始化为 null，定向 lint/格式及实际驱动回归已通过；生产源码与 Intel 预检候选无差异，继续整轮本机复查后冻结同一完整四目标候选。原失败保留于 `.cache/verify/run-0Q0Xjw/`，不改记成功。

第二轮本机 verify（`.cache/verify/run-xbNTNZ/`，source `83c9de9b874c0bb9beca69b9c28b3f04a5f3209906750460ca32c95514d81f52`）退出 1：2104 Vitest 通过，录制恢复测试在文件名显示后、权限 effect 建立前读取不存在的订阅；其余检查及 309 工程脚本/4 条件跳过通过，最终构建未执行。现在测试等待匹配当前输入的有效订阅，保留原授权、过期回调隔离与不启动工作的断言；受影响文件 17/17 通过。没有修改运行时代码或放宽产品预算，继续完整复查。

候选 `f20d0c11acb8159c9eacf92255b5c261940c2c08` / 源码 `13411652dbae66ee22632a6fc55ab4db62498ce4af4c79a991f030505d11877e` 的 [Intel 预检 42897971950](https://github.com/YanChao001/serial-workbench/actions/runs/42897971950) fresh 25 项用例通过/2 条件跳过，但新日志门控检出一次 Native 订阅建立重复，整轮失败、后续阶段未执行。同一 request 的两个数据通道编号均为 773077628，驱动自动重试已关闭；没有额外 RPC 关闭，安排的 Host 重启仍单独记录。ZIP 摘要 `1b1b6cb6701038835ad5333de61e1e894dcebb7c01362b7201d5ae2372ff7d1f` 已核对，原收据为 subscriptionWarnings=1/passed=false。

锁定 Tauri 2.12.4 的实际 IPC 脚本在本机受控“原生已接纳、导航取消回复”场景，对相同 payload/channel 先 fetch 后 postMessage 接纳两次，单次投递断言红；源脚本摘要 `68ae690606006f733bde75dd8bb6748464954a22c7e83914a93b1abc221d7072` 及红证据已保留。当前通过公开 `Builder::invoke_system` 固定单一 postMessage 路径，保留认证、回调、headers 和原序列化；4 项行为检查及相关脚本合计 20 项通过，桌面库 173/173（11.39 秒）、all-targets Clippy、fmt 与显式 JS lint 通过。此次修正的实际 Native 预检结果见本节首条；原间歇关闭未在本轮再现，不宣称全部旧失败都已证明为同一原因。

E2E 已合为同一次 Cargo 构建四个入口，保留锁文件、target 与四入口收据。本机首轮因 Tauri CLI 已提供 `--bins` 而重复传参失败，修正后实际构建通过：source `0c1496c1f87926aa30187bf889b86c36ab28c6241f2bf7e8abf9df6523fffe86`、GUI SHA256 `1064cce9cd67ab7cd8e502c0cc3681de0ea9b345ac4b4dcf942ff7d385ac879b`；Cargo 4m15s、总计 299.70s，属于修正 IPC 前的构建接线验证。原 CI 同目标分两段各约两分钟，缓存未保留 workspace crates；尚不按跨环境冷构建宣称提速，修订候选的实际构建与 CI 耗时继续核验。

诊断候选 `6424905095af9afe2fd0110c44273f02f71a6eb2` / 源码 `20ed96b166431b5fd54eb2fbc87827067967867f0d6f0d24bde9d55f93c54289` 的 [关闭驱动重试 Intel 预检 42895365718](https://github.com/YanChao001/serial-workbench/actions/runs/42895365718) 为 fresh 6 通过/1 失败/1 条件跳过，后续阶段未执行。失败在图片测试恢复设置的 `patchSettings`：刷新后立即读取窗口标识的 WebDriver 脚本超时；没有额外 RPC 关闭记录。ZIP 摘要 `fc9771f9732560cda7c651631237c441b971ab6dc72bdcc9e7d62b0414183a56` 已核对，截图已查看。当前将标识读取移至刷新前，再等待新页面就绪，保留原时限与保存断言。

复查 `ab7e41f` 原始日志还发现一次 `Subscription request is already pending`，旧门控未统计该 Native 订阅建立冲突；其原“冲突为零”只适用于已覆盖的两个 RPC 类别，不能扩展为无冲突。新门控在合成夹具中取得红→绿，并实际重放该日志判失败，原收据保留。当前为重复订阅补固定通道编号诊断以区分同一调用重投与不同调用，不记录正文、目标或凭据，也不改变订阅预算/行为。相关 10 项脚本、bridge 62 项、Clippy 与格式通过；原间歇关闭根因仍未闭合。

诊断候选 `ab7e41f0b470524188fbd812bd2b755868dc228d` / 源码 `2731f02457e725b1f610daada18be9a40a2130e1b0e71b8b29f15f9219e63399` 的 [Intel 预检 42893195710](https://github.com/YanChao001/serial-workbench/actions/runs/42893195710) 通过：fresh 25 通过/2 条件跳过，后两阶段各 2 通过。十二次独立重载后的跨窗口同步与另进程保存均通过；RPC EOF 及状态流停止只出现在安排的 20:20:09 Host 重启，三阶段冲突为零、正常关闭 Raw 0→0。ZIP 摘要 `8ef11ab2e06fac74a2968c18df2c8fc6a5771a98e715c7cc6337e2444f255679` 已核对，仍未复现原来额外关闭的具体原因。

另外以仓库实际 WebDriver 配置和本机 HTTP 夹具独立复现：已接纳后返回脚本超时的调用被执行两次，525ms 内红；关闭测试驱动自动重试后执行一次，相关 8 项检查通过。此修正仅禁止驱动重放可能已有 Native 副作用的脚本，不改变产品的保存、连接和恢复时限；没有证明它导致原 RPC 关闭。下一候选在此配置下继续 Intel 诊断，不把上一轮通过当作根因闭合。

诊断候选 `d7395688bd8cb7f4cdd5d99c0866b71ddfc385e7` / 源码 `48d2e73cd240cb7ac38236261643fc6ae92e91458bee46873b691c4d99bdd86d` 的 [Intel 预检 42888053946](https://github.com/YanChao001/serial-workbench/actions/runs/42888053946) 为 fresh 11 通过/1 失败/2 条件跳过，后续阶段未执行。十二次重载与原跨窗测试共用 90 秒，准备步骤消耗总预算，最终为测试总时限失败；本轮只记录了受控 Host 重启时的 RPC EOF，没有复现未安排的第二次关闭。ZIP 摘要 `768c4b04b06e53241eef7bee0fd1cc7b504ebc099c9169d86e44412a72153c06` 已核对，失败截图已查看。当前将每次重载拆为独立准备测试，原保存测试仍保持 90 秒及全部断言；不将夹具超时当作原故障再次复现或修复通过。

诊断候选 `529110bb1749e1c1663dbca1b1458a94dce13d8f` / 源码 `d87ae8e41a1e192019e9dbc1aefd4029680d3d0daf97ba062f06618bd8c4de31` 的 [十二次重载 Intel 预检 42884500508](https://github.com/YanChao001/serial-workbench/actions/runs/42884500508) 再次失败：fresh 12 通过/1 失败/2 条件跳过，跨窗口语言测试通过，后续另进程设置落盘等待超时；GUI 强度 70，实际仍为 50/revision 8。受控 Host 重启在 19:26:47，19:28:36 又出现 `event_stream_failed`，没有页面投递预算/通道失败记录。属于额外连接关闭后的同类未落盘，尚未证明与 `6b742de` 完全相同的底层触发。ZIP 摘要 `399fb280b6f9cda7a8432b6aecba7cd71c081381b4eeba14846904339a8edbf3`、原截图和 JSON 已核对保留，后续阶段未执行。

当前进一步补充 Rust RPC 读取停止的固定类别、消息/通道类别、受限错误码及写入中断记录，原关闭、队列、写入时限和重试行为保持；不记录请求正文、目标或凭据。保留十二次重载和保存断言，先完成客户端及 Native bridge 定向回归、静态检查，再运行相同 Intel 场景定位具体停止点。上述仍是诊断，不将失败或单次通过记为已修复。

诊断候选 `02167e361181cbcdb24a6e9a0c149180be01ce33` / 源码 `9ec760e485523480bdfb0f8c99beee4929d2a68fe426ec7db0e917cdf28a74c8` 的 [Intel 原生预检 42882068050](https://github.com/YanChao001/serial-workbench/actions/runs/42882068050) 为 fresh 13 通过/2 条件跳过、后两阶段各 2 通过。ZIP 摘要 `420706ffe71fd1ee0d091787e774f3cca6815cc498d9aba14384d18e29b1e429` 已核对；状态泵只在受控 Host 重启时记录 `event_stream_failed`，没有复现原故障的第二次关闭，仍不能宣布修复。下一次仅将相同场景的真实主页面重载从 3 次增为 12 次，继续定位；保留保存断言及原等待门槛，不触发完整四目标重跑。

候选 `6b742de57fcadecad441a59b9b0db3503806cbb2` / 源码 `fd0701a08d7de71003489676593fb9464b533864763c46b44aa34bd7985f0795` 的 [完整 CI 42876267719](https://github.com/YanChao001/serial-workbench/actions/runs/42876267719) 中，Windows Rust 及 Windows/Ubuntu/macOS ARM Native 通过；Intel Native fresh 为 11 通过/1 失败/2 条件跳过，后续阶段未运行。主窗显示英文但实际共享语言仍为中文、revision 7；18:42:22 安排的 Host 重启后，18:43:04 又发生第二次 Native 状态流关闭，具体停止原因尚未记录。原始失败截图、JSON、源码 bundle 及 ZIP 摘要均保留，不把产物已生成或其他端通过当作完整门槛成功。

当前诊断仅增加固定的状态泵停止类别与投递失败类别/占用，不记录正文、目标或凭据，也不改变关闭、授权、保存或重试行为。Intel 定向原生场景在跨窗口操作前增加三次真实主页面重载，失败时先记录 GUI 保存状态再作独立 Native 查询；原保存断言与等待门槛保留。受影响 bridge 62 项及静态检查在本机验证，下一步先做 Intel 定向原生诊断，故障闭合后才重新触发完整四目标 CI。主工作区仍在自有 PR 分支，不推进后续里程碑。

候选 `49ac4cd16f9763a998336235b20ba8398b9c92fc` / 源码 `27aa8411465bbe09e0210ab6e62ff02edb8f36f724bebe56ae44c11ceb0cb015` 的 [Ubuntu 原生预检 42869919568](https://github.com/YanChao001/serial-workbench/actions/runs/42869919568) 通过，fresh/persisted/centered 三阶段日志均实际存在，重复请求与前端冲突均为零，正常关闭 Raw 计数为 0→0。[完整 CI 42871645939](https://github.com/YanChao001/serial-workbench/actions/runs/42871645939) 的 Windows 桌面库为 172 通过/1 失败：阶段测试等待真实回复门时耗尽 3 秒，不能计为完整门槛通过。原始 job 日志及原源码 bundle 均保留；现场没有阶段细节，不能据此断言具体哪段连接耗时。

上述夹具现保留真实 Host、原阶段顺序、一次 Open 和两次授权断言；加入实际回复交付前的受控 4 秒延迟，旧 3 秒同步预算在本机 3.26 秒失败，修正后两项阶段测试 5.58 秒通过。测试同步预算独立为 10 秒，同时观测任务提前结束及安全阶段信息；产品连接预算和性能验收标准未改。默认并发完整桌面库 173/173、6.10 秒及 all-targets Clippy、Rust fmt 通过，日志为 `.cache/ui-audit/gui-ci-stage-*`。这一受控反例证明原夹具无法容纳合法延迟，不冒称复现了 CI 中未记录的具体上游变慢原因。后续修改只涉及夹具与状态文档，界面和运行时代码保持该候选版本；仍须核对修订候选的完整 CI。

最终开发窗口已按用户要求由 `pnpm app:dev` 编译启动，原 profile/Host、虚拟会话与草稿保留；桌面随后处于锁屏状态，未在锁屏后操作应用或发送测试字节。最新前台 COM14 复测待用户解锁时段，不能把此前组件范围的短回环记为该次新测试。

最新修正：`5a730d0` / 源码 `2a9bfaf18c7506df75a6d412c0ed16eea456e63b46e286d6738b510e3ea59c27` 的 [Ubuntu 预检 42854631328](https://github.com/YanChao001/serial-workbench/actions/runs/42854631328) 用例通过（fresh 14/1 条件跳过、后续各 2），但实际产物有 7 条重复在途查询诊断和 3 条前端冲突；[完整 CI 42856067505](https://github.com/YanChao001/serial-workbench/actions/runs/42856067505) 已主动取消，不计门槛通过。ZIP 摘要 `276e42b2e59e0cc7e8c8f9280cdcc3a18a5b90a3f274c21f98a3c5252df77d6b` 与源码收据已核对，原源码保存于 `.cache/ui-audit/gui-source-5a730d0.bundle`。原生日志重放的新门控实际退出 1，检出同样 7/3，不再只依赖用例 reporter。

真实 LocalStream 的相同查询在途重投用例在旧客户端 0.04 秒内失败；现仅完全相同的查询共享原回复，不额外发帧，异参和业务调用仍拒绝。取消前后、剩余等待者、容量及旧 guard 隔离通过；客户端全目标 29 项通过/2 个受父用例控制的辅助入口忽略。Raw 在同设备 Native 授权未完成时抢先读取也取得 3 例红→绿，并覆盖真实失败、其他设备及退出，等待实际意图结束后仍独立验权。投递的更上游触发源尚未证明，不直接归因于 Tauri、UUID 或测试重试。

本机桌面库全量曾分别暴露两项失败：夹具在设备仍打开时改变授权导致真实取消；300 晚帧隔离在重负载下耗尽原 10 秒。前者现先等实际 Open 终态再注入只读回复失效；后者定向 5.31 秒通过，控制本机测试并发为 4 后完整 173/173、11.75 秒通过，未改变 300 帧、ACK 或 10 秒门槛。对应 client/Native all-targets Clippy、Rust fmt 通过；中途夹具类型错误也保留为失败，不将单例通过替代整轮。日志为 `.cache/ui-audit/gui-rpc-*`。

`verify11` 退出 1、411.0 秒：129 文件/2105 Vitest 及格式、lint、双类型、配置、品牌、版本通过；沙箱拒绝 CIM 查询和自有进程回收，工程脚本为 289 通过/14 失败/4 条件跳过，最终构建未执行。仅在普通用户权限重跑工程脚本后 303 通过/4 条件跳过、120.4 秒，原失败保持；无残留的两个失败测试 PID，未改清理源码或断言。随后 `pnpm build` 与 `pnpm build:web` 均通过，分别补齐桌面和预览产物，不将原 verify11 改记整轮通过。

renderer26 完整浏览器 128/128、8.0 分钟通过；462 个前端输入在构建前、构建后及浏览器结束时均为 `0639134523f03ed2d5638e3b30a893b11dd677860758d64b646a8373afa94d5c`，46 个产物文件指纹 `069928fd762b11f36e55c73ff2246a41de402479a9759618b053fd9b9573a0af`。164 张截图与 renderer24 比较，128 张完全一致，36 张差异逐张查看；材质采样含测试临时隐藏的参考内容，不当作普通页面可见性证据。前端输入收据不证明同期 Rust/文档未变，最终冻结候选仍待原生预检与同一候选四目标门禁。

最新源码：regular-profile 日志于 22:05/22:09 两次记录会话 `state.snapshot` 的 `EPOCH_MISMATCH`，Provider 随后退休整个连接并清空设备；具体触发换代的动作尚未证明。同一实际 Host 的独立 CLI 功能目录、7 项 scope 及两个会话快照均可读取。会话与目录错误边界已修正，七个真实 Provider 竞态、预算及最后一次真实实例失效用例取得红→绿，相关五文件 152/152 通过，独立复核无剩余确定必修。`verify10` 九步通过，353.6 秒：129 文件/2089 Vitest、300 工程脚本通过/4 条件跳过，分步目录 `.cache/verify/run-glvs6o/`；格式、双类型、lint、配置、品牌、版本和生产构建均通过。之后补退休标签的 11 个用例，最终全量 Vitest 为 129 文件/2100 项通过、65.11 秒；标签定向 115/115、双类型、lint 和格式通过。已知友好名称只在同一标签及完整来源身份内保留，未知名称显示本地化“会话”，不改存档、内部 ID 或草稿键。

用户授权 computer-use 后，两次 `pnpm app:dev` 新窗口均实际打开 COM14、精确完成 18 字节 GUI 回环，原草稿已恢复、测试端口已关闭。第一次仍保留一条早期 Raw 权限拒绝；第二次使用冻结后的 TS 修正，本轮未新增前端错误。启动与即时 UIA 观察包含工具、重载及并行检查，不能据此捏造纯连接耗时或声称永远挂起。两轮自有开发进程已停，原 Host 与另一会话保留；组件已按哈希归档到 `.cache/ui-audit/archived-dev-run2/`，这是局部运行组件归档，不是完整候选同源收据。

新增受控诊断不改变打开、授权、重试或取消语义。debug 开发进程记录一次实际 DeviceConnect 总阶段 3531ms：设备授权 751ms、Open 接纳 125ms、操作等待 913ms（1 次查询）、会话授权 611ms、会话读取 1126ms；该次触发动作未由 computer-use 独立观察，不作为完整点击至界面耗时或性能基线。普通日志级别第四进程随后由 computer-use 实际完成显式打开和关闭；其进入观察前有一条 Raw `PERMISSION_DENIED`，触发动作未确认，不记为无错误。只读 Host 快照于 2026-11-11 00:21 确认 COM14 closed/epoch10/revision30，原虚拟会话仍 open/epoch5/revision11；未发送用户草稿，保留开发窗口。证据见 `.cache/ui-audit/dev-live-computer-use-20261110.md`、四轮开发日志及 `dev-host-status-after-run4.json`。

RPC 重复在途请求诊断只记录固定 action、通道、进程内连接号、请求 ID 的不可逆摘要和等待时长，进程内每 60 秒最多 20 条；不记录正文、目标或凭据，也不自动重试。复用锁定的 `log 0.4`，仅新增 client 直接依赖边，不新增第三方版本。客户端全目标测试 21 通过/2 个受父用例控制的辅助入口忽略；最终有界夹具库测试 8 通过/1 辅助忽略，all-targets Clippy 通过。Native 真实 Host 阶段门控及已有 Open 归属检查最终 5/5、all-targets Clippy 和 Rust fmt 通过。首次 Native Clippy 因新测试使用已弃用 `chunks_exact` 失败，改为 `as_chunks` 并断言无余项后通过，失败日志保留。旧 Ubuntu 正常运行期 `REQUEST_CONFLICT` 的根因仍未证明，须检查新候选实际原生日志，不能以旧绿色结果解释为预期告警。

renderer24 的生产构建与完整浏览器 128/128 通过（9.1 分钟），462 个前端输入在构建前后和浏览器结束时指纹均为 `6e9104f8ab411bb4b2fce3168c28853604544e09353d1d2b4185296e66976cbe`，产物指纹 `aa3234273d1e4190bff092d84407aec4250d9cb83a586d08d393c1b4ee5c04ad`；20 张实际截图已查看，发现退休标签泄露内部 ID 并随后修正。renderer25 在该修正后重新构建，离线/工具布局/间距定向浏览器 15/15 通过（46.7 秒），462 输入指纹在三个时点均为 `995c7eb6c070dbb55221522d22b8fa13f21acd03a837be87b1da9b84e406a26b`，产物指纹 `78e20bf4413a731975cca401cca922fcd96f73da8c9ce72e9742450c202636a4`；实际离线截图确认友好名称、草稿和布局保留。上述前端收据不证明同期 Rust 或整仓源码未变，最终冻结候选仍须完成完整四目标 CI。

候选 `8d04d39` 的 [Ubuntu 原生预检 42830650618](https://github.com/YanChao001/serial-workbench/actions/runs/42830650618) 已通过，源码指纹 `629b2d3e4dcc817f707bce11247fa3b6f86e4aef5977fa1fbc0b446e52416986`。依赖索引/下载/安装分别 20/49/25 秒；fresh 14 项通过、1 条件跳过，persisted/centered 各 2 项通过。正常关闭观察 33 次/2055ms，Raw 故障计数无新增；产物摘要已核对。该独立 Linux 结果不覆盖本机开发版现场故障，也不是完整四目标验收。

用户现场报告的 GUI 首次加载/连接慢、首次 COM14 打开失败和连接按钮反复变化，已分别取得权限观察、初始 Raw 授权竞态及重复投影发布的回归并修正。renderer21 本机完整浏览器 128/128 通过，4.8 分钟；后续候选已实际进入 CI，未达到完整四目标门槛。用户随后安排前台时段，已完成其明确批准的 `d112500` 实际 GUI 定向检查；后续未提交修正不冒用该程序的现场证据。

当前执行仍在主工作区的 `fix/workbench-ui`，首轮已推送候选为 `8908605`；[PR #42](https://github.com/YanChao001/serial-workbench/pull/42) 未合入。用户要求紧凑图标工具栏、延迟悬停提示、固定几何布局及真实连接可用性，完整事项见[当前修正依据](./ui-review.md#当前修正依据)。首轮 [CI 42729558877](https://github.com/YanChao001/serial-workbench/actions/runs/42729558877) 的 macOS Intel Native 设置保存失败，后续阶段未执行；其他四目标 Rust、三个 Native 及前端/浏览器/绑定通过，完整门槛未达到。该失败的历史根因尚未证明，新增设置落盘证据不会将其改记为通过。新的真实 GUI 结果仍待当前候选复验。

界面审查切片从干净的 `main@7a8e81a` 建立 `fix/workbench-ui`，已查看 11 张原生基线、27 张默认/弹窗图和 40 张第一轮修正图；最终 40 张重拍中 38 张完全相同、2 张单独复查。已修正字体回退、信息密度、时间/回执详情、状态本地化、设置导航、皮肤辨识及标签关闭焦点。原生窗口边框/系统按钮不在这些 WebView 截图的证据范围。

上述已推送候选 `8908605` 的本机九步 verify 152.5 秒通过（1835 Vitest、290 工程脚本/4 条件跳过），完整无头浏览器 103/103（3.8 分钟），Rust client_state 8 项、桌面 all-targets Clippy、fmt 和生成绑定检查通过；其首轮复核没有剩余必修项，但后续用户审查和原生 CI 暴露的问题尚未完成，因此这些结果不代表当前源码已通过。

当前主工作区未提交修正已覆盖主工具栏、固定布局、单线焦点、设备/工作区工具、按设备参数持久、任务取消、录制/回执/指标及模块日志。连接状态与权限观察、在途初始 Raw 授权竞态、同版本操作重复发布、真实停止终态、Native/投影故障去重和 Gap 计数均取得各自定向红/绿证据。输入框右下只读字节标签、文本/HEX 正文转换、可编辑波特率、统一下拉及 IME 防护已实现；最终复核的重复通知、详情读取、回放固定布局及回执引用身份遗漏也已闭合。COM 展开明确执行现有 `device.refresh` 查询，后台继续读取目录缓存；在途旧查询与显式枚举分别合并，不清空有效选择或重放打开。

已推送 d112500 前的本机 verify6 九步骤通过，170.3 秒：129 文件/2061 Vitest、294 工程脚本通过/4 条件跳过及格式、lint、双类型、配置、品牌、版本和 Vite 构建通过，日志 `.cache/ui-audit/gui-integration-verify-6.log`、分步目录 `.cache/verify/run-IBhwae/`。此轮包含最后的弹窗滚动焦点修正及 Native 验收定位适配。较早 verify5 为 187.4 秒/2060 Vitest，保持原检查点归属。桌面 Rust 库 171 项、all-targets Clippy、client_state 19 项、Core 5 项、Rust fmt、契约生成/检查及绑定检查通过；之后未更改 Rust 实现。

关闭处理与 CI 修正后的 verify7 实际为 2076 通过、1 失败，工程脚本 300 通过/4 条件跳过及其余静态检查通过，整体退出 1，不计整轮通过。失败为录制工具测试在文件名已提交到 DOM、权限订阅的后续 effect 尚未注册时直接发布空订阅；现仅该用例等待完整引用、当前模式且未停止的真实订阅，保留所有权限、来源和旧结果断言，17 项定向通过。没有改产品、夹具或超时，最终综合结果由下一轮记录。

verify8 为 2077 Vitest、300 工程脚本通过/4 条件跳过，但测试辅助查找使用了 ES2022 编译目标不支持的 `findLast`，类型检查失败，整轮仍退出 1。随后改为保持相同查找逻辑的 `slice/reverse/find`，双项目类型与该文件 17 项定向均通过，不提升编译目标。最新生产产物 renderer23 完整浏览器 128/128 通过，8.4 分钟，指纹 `4648c5cbf5d8136c7a60c296be0f2eddbf6f848bb22400428eb4c9fa3f3098ef`；之后只修改测试兼容写法和验证记录，产品运行代码未变。最终 verify9 九步骤实际通过，160.0 秒，129 文件/2077 Vitest、300 工程脚本通过/4 条件跳过，目录 `.cache/verify/run-xf2aV5/`；记录源码冻结后的实现、测试与工具检查，随后仅补结果文档并复核格式与账本。

renderer21 的 build/typecheck 和完整浏览器 128/128 通过，4.8 分钟；日志 `.cache/ui-audit/gui-final-browser-all-21.log`。产物指纹为 `71eb190f8333ef0fd692a84ffbbe4c5eda377958ee7197a4c865cba0c07f60b6`，检查点 `.cache/ui-audit/gui-renderer-checkpoint-21.json` 记录其未提交源码与 46 个产物文件。此前 renderer19 完整检查 101 通过/25 失败、renderer20 22 通过/5 失败保持失败归属；旧交互断言已适配，同时实际修复纯说明 Tooltip 拦截点击、只读弹窗滚动区键盘不可达及 COM 显式刷新仅取缓存。最新检查保留原字节、权限、布局与无障碍断言。

已推送候选 `d1125006f4423cb95ea732b6c89bbdb83aeb1d3e`、源码 `8f890c78ad17a2c2c51e0dd78a375e5ccaada0edcba4acc266f1385c9cc9106f` 的 [Intel 预检 42816059931](https://github.com/YanChao001/serial-workbench/actions/runs/42816059931) 为 17 项通过、2 项平台条件跳过；原设置落盘场景和后续独立进程实际通过。归档摘要、同源收据、三个实际截图及两个 Host 正常退出已核对，桌面进程 SIGTERM 是 harness 清理。其 [完整 CI 42817876368](https://github.com/YanChao001/serial-workbench/actions/runs/42817876368) 为 5 成功、7 失败、1 预检占位跳过：前端、绑定及 Windows/macOS ARM/Intel Native 通过；浏览器 127/128，中文菜单墨迹向下恰偏 1px；三个 Rust 平台仍有旧默认名断言，Windows 另有授权 200ms 在初始 snapshot 前到期；Ubuntu Rust/Native 在 Azure 镜像下载阶段分别耗尽 8/12 分钟，未进入业务场景或 600 秒测试。质量门禁正确拒绝合入，不把环境失败记为软件通过。

本机补查 Core 默认值的全部 Rust 引用并修正 Host 独立工作区断言，Host 全目标 43 组/464 项通过、2 个受父用例控制的辅助入口忽略。到期用例改为确认读者真正等待后推进时钟，保留 200ms TTL、2s 预算及授权版本不变，21 项投影测试与 Host all-targets Clippy 通过。菜单补偿由 1px 减为 0.5px，原 `<1px` 断言未改，中英文 2 项通过且截图已查看；本机中文墨迹中心与图标中心均为 19.5。Linux 环境修正共用安装脚本，精确将已知 Azure URI 改为官方源、保留签名与必需包，下载有界且与 dpkg 分开；真实效果仍待 Ubuntu 原生预检及新候选完整四目标 CI。

获批前台检查于 2026-11-10 21:13—21:14 在 Windows 11 build 26200、CH340 `oem72.inf/4.0.2026.2` 执行。对冻结 `d112500` 重新按 Git blob 计算源码指纹并核对四程序哈希后，两设备分别使用全新隔离 profile：`virtual:echo`/COM14 各首次打开成功，115200、8N1、无流控，文本加二进制各两次发送，分别请求/接收 29/29、22/22 字节，Host Raw 与可见界面均精确一致；各 21 次采样、约 12 秒保持同会话/epoch/连接按钮状态，UI 确认会话关闭。点击至连接按钮就绪观测为 818/1033ms；设备列表首次观测 16633/12808ms 包含 WDIO 启动，只是上界，不作为纯前端或 HostReady 至端口可用的独立耗时。全部十个自有 PID 已退出，Host/CLI/WDIO 为 0，两个 GUI 为 harness 受控停止 1。十张实际 WebView 图已逐张核对，现场证据位于 `.cache/ui-audit/native-hardware-smoke/runs/run-rEXnZO/`。

这次现场也暴露正常主动关闭后的误告警：两例关闭截图均出现“实时数据已停止”，Native 日志各一条来自 `Host raw reader` 的 `EPOCH_MISMATCH`。首次连接、字节和短时稳定结果保持，但不能记为全程无错误。已修正同 epoch closed 不退休读者的缺口；仅远端 Raw 终态、游标、credit 或订阅建立的指定关闭错误进入一次有界权威核验，本地身份错误仍报告。30 项读者回归实测红→绿，覆盖两种终态顺序、真实断连、核验失败、晚结果、缓存与资源释放。原生场景增加真实 closed 状态及 2 秒诊断/通知观察，待新候选 CI 执行，不借用旧程序的现场结果。前台时段已结束并交还用户，后续不再自行启动窗口。

较早动态模块超时、私有缓存遍历失败及最后夹具写入期间的格式失败均保留，verify3 虽有 2052 Vitest/294 工程脚本通过但整体退出 1；verify4 的 2053 Vitest 及静态检查通过，工程脚本因 Windows 进程探针超时失败。格式命令现已在路径展开时排除诊断缓存，不改 profile 权限；工程脚本文件并发固定为 4 后，同一入口 294 通过/4 条件跳过，原探针预算未放宽。首轮新浏览器 6 通过/3 失败及自有 runner 清理后退出 1 继续保持旧产物归属。独立原生预检与四目标门禁仍待新候选，不将本机结果合并为全部验收通过。

需求账本为本轮实际涉及的 35 个既有软件进行中条目追加真实 PR #42 证据，保留全部原证据、状态与范围；247 条校验通过，仍为 76 个软件进行中、168 个未开始、3 个不适用。COM14 定向调试单独记录，正式 M6 硬件及发行矩阵仍未开始。

COM14 原驱动 `3.9.2024.9` 下，独立 `CreateFileW` 与 .NET 打开都返回系统错误 5，零写入/零接收。用户授权重装后，核验沁恒官方包及微软硬件兼容签名，暂存新包并移除指定 CH340 实例；Windows 返回 3010，用户自行重启。重启后实际驱动为 `oem72.inf / 4.0.2026.2`，端口仍为 COM14。独立 .NET 回环在两种速率各收发 256 字节一致；重新构建同源 Host/CLI/MCP 后，独立 profile 的 CLI 经实际 Host 打开 COM14 与 `virtual:echo`，两设备各两种速率均收发 256 字节一致，四个会话关闭且自有 Host 正常退出。证据为 `.cache/connection-audit/com14-os-loopback-after-driver-reboot-1.json`、`product-loopback-1794291400955/summary.json` 和 `ch340-driver-recovery-20261110.json`。此前失败记录保留；首次辅助脚本因解析 CLI 回包形状错误而未进入设备测试，修正脚本后才取得上述通过。按用户要求已删除本次导出的原驱动备份，未删除 Windows DriverStore 的旧包。当前 GUI 现场操作、完整硬件矩阵及 M6 仍未验收。

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
