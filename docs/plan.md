# 路线与进度

[需求矩阵](./requirements.md)的 247 项中，244 项纳入，移动端 FUT-10、CONN-19 排除，NET-13 留给零安装 Web Serial。逐项状态见[需求账本](./feature-status.json)，逐轮测试和本机收据见[历史验收记录](https://github.com/YanChao001/serial-workbench/blob/49067ea2fbc284e995fb337fe565e86a61d09f30/docs/plan.md)。

[M3 主线证据](#m3-契约与产品证据) · [M4 实现](#m4-已有实现与待验) · [M5 实现](#m5-已有实现与待验) · [验收边界](#验收边界与未决问题)

## 当前执行与下一步

### 当前任务顺序

按依赖顺序只推进队列中的当前任务。工作区和分支按[主工作区与单任务](./conventions.md#主工作区与单任务)管理，完成[合入与清理](./conventions.md#合入与清理)后接续下一项。

1. M4 发送控制（IO-08）。工作台按住连发和真实配对浏览器随 #83 合入。桌面热键按 Windows、macOS、Linux X11 与 Wayland 分别验收注册、键位冲突及当前目标授权。Wayland 接入依赖桌面 GlobalShortcuts portal。独立物理串口和正式安装包按专项验收。 [桌面热键专项](./acceptance.md#桌面全局发送热键)
2. M4 余项。按需求账本完成可在软件环境验证的缺口，物理设备、长稳和正式发行按专项归属安排验收。
3. M5 专业分析与市场。独立市场签名目录工具已交付，宿主接续市场检索、包来源核验、安装和同来源相容升级。正式目录发布、评分数据来源及其余专业任务按账本推进。

### 本轮交付与验收

- 候选 `c77c8c2` 的 Windows、两种 macOS 架构、X11 和 Wayland v1/v2 热键收据均确认关窗隐藏时零写入，X11 恢复后同键写入一次并完整回环。Apple Silicon 的后续重启用例把 `1000×680` 近满屏窗口保存为 `maximized=true`。存档的当前位置是 `(24,29)`，其正常位置是 `(0,25)`，重启实际使用了正常位置。夹具改用已验证的 macOS 正常窗尺寸，保存前后核对最大化状态。重启按保存的位置与尺寸核对，居中阶段复用该尺寸。窗口恢复属于 SESS-01 与 UX-04，继续随 IO-08 综合门禁验收。 [候选门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45908398322) · [Apple Silicon 窗口收据](https://github.com/YanChao001/serial-workbench/actions/runs/45908398322/artifacts/15159800471) · [Wayland 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45908398322/artifacts/15159930621)

- 同一候选的 Ubuntu Rust 作业已通过等待授权终态后的 LAN-01 双栈恢复，并完成独立网络命名空间内的离线软件基线。收据确认 T01、T03、T04、T05、T06、T08 全部通过。T06 的末个样本在负载开始后 600.1 秒，慢读者隔离、控制响应和丢失记账均通过。物理串口和各平台 72 小时实跑仍按 M6 单独验收。 [Ubuntu Rust 作业](https://github.com/YanChao001/serial-workbench/actions/runs/45908398322/job/140212428284) · [离线收据](https://github.com/YanChao001/serial-workbench/actions/runs/45908398322/artifacts/15159857582)

- 候选 `57b1d4a` 的 Windows 固定 Node 门禁已通过前九个运行时用例。目录链接拒绝用例在准备阶段重命名已加载过的 `runtime` 目录时收到 `EPERM`。本机用占用文件句柄的临时目录复现相同错误，并确认从另一个安装目录建立和移除链接时原文件保留。夹具用独立安装目录，由原生探针按实际安装路径验证 `NODE_RUNTIME_INTEGRITY_FAILED`。这项 M3 固定运行时回归随 IO-08 的综合门禁复验。 [Windows 故障收据](https://github.com/YanChao001/serial-workbench/actions/runs/45898242216/artifacts/15155527820)

- IO-08 候选 `57b1d4a` 的四个原生桌面作业和 Wayland v1/v2 定向预检通过。完整门禁中的 Linux Rust 作业在 LAN-01 双栈恢复夹具获取普通 CLI 请求上下文时收到 `PERMISSION_DENIED`。同源本机探针确认授权先返回 `queued`，随后才出现 `authorization_changed`。夹具改为按操作 ID 等终态，并将失败收据归档。LAN-01 属于 M2 软件回归，复验纳入 IO-08 合入的综合门禁。 [桌面与 Wayland 收据](https://github.com/YanChao001/serial-workbench/pull/89) · [Linux 门禁失败步骤](https://github.com/YanChao001/serial-workbench/actions/runs/45898242216/job/140179694726)

- IO-08 候选 `9f21c6e` 通过 X11 独立进程占键冲突、停用后零写入和原键接管。Wayland v1、v2 均确认主窗单次写入，速查、应用设置页和次窗零写入，返回工作台后另一应用前台可再次发送。两版的门户交接在测试启动之前被场景白名单拦截，待修复启动器后在真实门户复验。 [X11 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45895543201/artifacts/15154545154) · [Wayland 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45895543201/artifacts/15153019670)

- IO-08 候选 `0ecc633` 以一次定向预检并行核对 X11 与 Wayland。X11 的系统占键冲突、原键保留、另一应用前台单次 TX 与停用后零写入均通过。停用后独立客户端接管 F9 仍返回 `BadAccess`。Wayland v1、v2 的主窗单次写入、速查及次窗零写入均通过，切到应用设置页后各产生一笔错误 TX。工作台路由的授权撤回和返回重订已通过本地无头回归。X11 注销改为等待服务端处理，通过 Linux 目标编译检查。两项修复与真实门户交接进入同一批原生复验，软件验收继续进行。 [合并预检](https://github.com/YanChao001/serial-workbench/actions/runs/45893732856) · [X11 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45893732856/artifacts/15152792583) · [Wayland 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45893732856/artifacts/15152533998)

- IO-08 的 Wayland 候选 `ce76aa3` 在 Ubuntu 26.04 构建通过。批准和取消两套 KWin 会话均有真实 Wayland 客户端连接，门户在会话变量生效前被启动，未暴露 GlobalShortcuts，工作台场景未执行。复验先确认 KDE 后端和已接管私有总线的门户，再运行批准、取消、改键与 Raw 收发。 [首轮诊断产物](https://github.com/YanChao001/serial-workbench/actions/runs/45878510321/artifacts/15145423839)
- Wayland 候选 `317a246` 在 KDE 6.6.7 与 `xdg-desktop-portal` 1.21.1 下确认 GlobalShortcuts v2。原生弹窗取消后速查显示关闭，另一 Wayland 客户端在前台时没有新增 TX。批准后速查显示系统分配的 Ctrl+Shift+F9，原始 Raw 读回仍为空，门户日志未报告激活。复验保留前台客户端按键、KGlobalAccel、KDE 后端和公共门户的信号。先核对这几段证据，再判断是否需要修改产品的收发路径。 [批准和取消收据](https://github.com/YanChao001/serial-workbench/actions/runs/45879721728/artifacts/15145488821)
- 候选 `958c43c` 的取消会话通过。前台 GTK Wayland 窗口收到一次带正确修饰键的 F9 按下与释放，Raw 无写入。批准前 KDE 未登记该组件，批准后组件出现且速查显示 F9。前台窗口仍收到 F9，KGlobalAccel、KDE 后端和公共门户都无激活信号。`ConfigureShortcuts` 已到 KDE 后端，系统设置窗口未出现。重载场景的旧门户连接已关闭，读取新文档超时。下一批核对 KWin 自身快捷键、KDE 实际键位与标准系统设置关联，并先从系统侧确认待定弹窗释放。 [输入、总线与重载证据](https://github.com/YanChao001/serial-workbench/actions/runs/45880795320/artifacts/15147805519)
- 候选 `a35cfe7` 确认 KWin 持有 KGlobalAccel。Alt+F4 有按下和释放信号，并关闭前台 GTK 窗口。取消场景通过。批准后 KDE 报告已分配 Ctrl+Shift+F9，首次及停用后再次注册均由前台窗口收到 F9，Raw 无写入，总线也无对应激活信号。系统设置打开了「快捷键」，该用例未找到改键控件。重载场景的应用总线连接已清理，待定授权弹窗仍出现在无障碍窗口列表中。跨应用写入、改键和重载释放继续待验。 [KDE 分配、按键与弹窗收据](https://github.com/YanChao001/serial-workbench/actions/runs/45882156250/artifacts/15148042023)
- 候选 `987a77b` 的隔离 KDE 构建、系统取消与零写入通过。KWin 确认注册工作台的 Ctrl+Shift+F9，但把注入的组合识别成 Ctrl+Alt+Shift+F9。在独立配置把同一键位登记给 KWin 自己时也复现。系统设置已实测选中工作台、取消捕获和取消冲突，应用改键后门户同时报告新增的 Ctrl+Alt+Shift+F10 与旧 F9。重载后授权窗仍可见且处于活动状态，未记录到应用发出的显式关闭调用。清除系统分配场景被测试入口拦下。下一批按 Xvfb 的原始键码注入，等待系统设置确认旧键已取消，改用 WebView 发起重载并核对新文档代次，同时补齐清除分配的场景入口。 [KWin 按键、系统改键与请求收据](https://github.com/YanChao001/serial-workbench/actions/runs/45884038808/artifacts/15149465075)
- 候选 `efc99bf` 的取消、清除系统分配及缺少 GlobalShortcuts 三个场景通过。缺少接口时全局按键无写入，编辑器仍可主动发送同一草稿并精确回环。原始键码使工作台和 KWin 对照均收到正确的 Ctrl+Shift+F9。保持一次按下时，KWin 最先报告原生连发，随后出现额外的释放与按下，Raw 共九笔写入。下一批关闭外层 Xvfb 的连发，继续要求 KWin 原生连发及单笔 Raw。KDE 设置在应用改键后报告 F9 与 F10，复验改为先录入 F10 再停用旧默认键。WebView 重载后弹窗仍在前台，应用发出的关闭调用和新文档均未取得证据。 [批准、拒绝、兼容和重载收据](https://github.com/YanChao001/serial-workbench/actions/runs/45885776566/artifacts/15150500392)
- 候选 `3cd1a21` 的独立 GTK 窗口置前后，KWin 报告 18 次原生连发，长按及松手后的第二次按键各产生一笔精确 TX 与回环。取消、清除分配、缺少接口和 KWin 对照继续通过。KDE 设置中旧键复选框显示停用，应用后门户仍报告 F9 与 F10。Qt 默认无障碍切换只修改复选框属性，下一批使用真实空格键触发 KDE 的快捷键模型并复验移除旧键后的重新分配。重载仅记录初始文档。测试从发送区保存草稿后重新申请热键，并核对弹窗关闭、新文档、草稿恢复和零写入。 [单笔 TX、改键与页面收据](https://github.com/YanChao001/serial-workbench/actions/runs/45887394595/artifacts/15149384309)
- 候选 `287519f` 的待定授权重载通过。WebView 提交新文档，同一原连接依次关闭 Request 和 Session，授权窗消失，已保存草稿完整恢复，另一应用前台时旧组合零写入。长按、第二次按键、取消、清除系统分配及缺少接口继续通过。KWin 收到空格且设置报告复选框已获焦点，复选框仍启用，测试停在应用改键之前。下一批用无障碍控件范围与 KWin 前台客户区定位同一真实复选框，由外层指针点击并继续核对替换、旧键零写入及撤回。 [重载及 KDE 改键收据](https://github.com/YanChao001/serial-workbench/actions/runs/45888967047/artifacts/15151261267)
- 候选 `531a69e` 在 KDE 设置中点击并停用旧键。KWin 撤销 F9，门户在同一会话依次报告无键位及仅有 Ctrl+Shift+F10，工作台显示新组合。设置打开成功后工作台已经退出编辑，测试却继续等待编辑区的「取消」，未执行换键后的 Raw 验证及撤回。长按期间 KWin 原生重复 14 次，长按及第二次按下各有一笔精确 TX 和回环。取消、清除分配、待定重载和缺少接口再次通过。后续通过速查的关闭按钮返回发送面，在设置仍处于前台时检查新旧键与撤回。v1 使用同一工作台构建、独立会话和实际 v1 前端。 [本轮 Wayland 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45890784612/artifacts/15151916350)
- 候选 `ad441ec` 的 KDE Wayland 专项通过，两个会话使用工作台 SHA-256 相同的构建。v1 运行 `xdg-desktop-portal` 1.20.4，显示手动设置指引。v2 运行 1.21.1，从工作台打开设置。两组均以真实设置界面验证冲突取消、换键、旧 F9 零写入和新 F10 单笔 TX。操作 ID 与写入意图一致，回环逐字节匹配。撤回后速查显示关闭，F10 零写入。待定授权重载由原连接关闭请求和会话。v1、v2 长按分别有 16、14 次 KWin 原生重复，均只写一次。v2 的缺少接口场景与 KWin 同键对照通过。主窗和次窗发送边界及 X11 独占冲突另有本地用例待跨平台验证，精确候选全量门禁、物理串口及正式安装包继续待验。 [双版本 Wayland 专项](https://github.com/YanChao001/serial-workbench/actions/runs/45892054842) · [原始收据](https://github.com/YanChao001/serial-workbench/actions/runs/45892054842/artifacts/15152207618)

- M4 桌面热键（IO-08）的当前草稿授权、原生注册和 Wayland 系统改键进入 #89。`c80dfbd` 通过 X11 跨应用单次发送。`022ce13` 在 Windows 验证冲突、原键保留、后台单次发送、24 字节 Raw 回环和停用释放。`afb7e84` 在两种 macOS 架构通过同一组原生断言。计算器在前台时，F9 仅产生一笔已接纳的 TX，操作 ID 与写入意图一致，24 字节回显逐字节匹配。功能键标志的系统对照另有原始收据。Wayland 服务交接已通过本地协议测试。GlobalShortcuts v1 和 v2 的独立 KDE 桌面证据见上文。物理串口及正式安装包按专项验收。 [PR #89](https://github.com/YanChao001/serial-workbench/pull/89) · [X11 作业](https://github.com/YanChao001/serial-workbench/actions/runs/45863879445/job/140061636746) · [Windows 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45866771347/artifacts/15141565894) · [Apple Silicon 工作台收据](https://github.com/YanChao001/serial-workbench/actions/runs/45875440582/artifacts/15143554953) · [Intel 工作台收据](https://github.com/YanChao001/serial-workbench/actions/runs/45875440582/artifacts/15143829850) · [两架构功能键标志对照](https://github.com/YanChao001/serial-workbench/actions/runs/45875033574)
- M4 工作台按住连发逐笔确认实际写入，松手、授权失效或写入状态无法确认时停止后续提交，并保留已接纳回执。四平台门禁、365 项本机无头 Chromium 回归和真实配对 Raw 写入复验通过。 [PR #83](https://github.com/YanChao001/serial-workbench/pull/83) · [四目标检查](https://github.com/YanChao001/serial-workbench/actions/runs/45774688836/attempts/2)
- M5 独立市场交付了签名目录、时效和回退检查、版本兼容筛选，以及评分来源与时间。宿主固定引用市场主线提交 `455348126b56c58a7b975f3b5075da8d925be23d`。 [Marketplace PR #3](https://github.com/YanChao001/serial-workbench-plugins/pull/3) · [目录四平台检查](https://github.com/YanChao001/serial-workbench-plugins/actions/runs/45790904133)

2026-11-26 对照 `main@5227cf5` 的产品入口、实现、测试及已合入 PR 核对。每项按需求矩阵的最终目标里程碑计入一次。M0 基座见下方验证基线，矩阵没有最终目标为 M0 的单列需求。软件通过要求该条目的软件验收条件已有证据。验收中包含仍缺软件验收条件或证据的条目，其中一部分已有实现合入。实机和发行按账本及专项分别登记，表中数量用于跟踪逐项软件验收。阶段出口的集成证据见下方验证基线。

| 软件需求 | 纳入 | 通过 | 验收中 | 未启动 |
| -------- | ---: | ---: | -----: | -----: |
| M1       |   14 |    2 |     12 |      0 |
| M2       |    8 |    0 |      8 |      0 |
| M3       |   19 |    0 |     19 |      0 |
| M4       |  136 |   17 |     96 |     23 |
| M5       |   41 |    3 |      9 |     29 |
| M6       |   26 |    0 |     17 |      9 |
| 合计     |  244 |   22 |    161 |     61 |

本次补录了 M3 会话钩子、M4 传输与复现实验、M5 专业分析等主线证据。IO-18 的真实桌面拖放继续验收，FUT-07 仍缺宿主市场接入。实际串口、跨物理机和正式发行各有专项验收条件。

### 已合入的旧分支收敛组

从历史分支逐项迁入了 12 项有效改动。候选 `cb01d39` 的 13 项必跑作业通过，已随 #82 合入 `main@dff3c2c`。 [PR #82](https://github.com/YanChao001/serial-workbench/pull/82) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45756264823)

1. 六段帧模板及首方协议字段包的签名升级。
2. 双实时会话拆屏对比和各自的接收范围。
3. 固定请求识别、延时自动应答及取消时序。
4. 落盘脱敏、脱敏视图以及与原字节搜索的模式隔离。
5. 附着和离线无头批次，复用当前录制搜索的 Raw 通道。
6. 环回自检与误码报告。
7. LAN IPv6 双栈连接恢复。
8. Node 报文边界和空报文。
9. 设备 UDP 单播、广播与组播。
10. 设备 WebSocket 客户端和侦听。
11. 收发字符映射与发送回执。
12. 图表样本交接。先验证源会话换代、撤权和 LAN 对端切换后的样本失效，再交付跨源 XY 接线。

终端外链和原字节录制搜索沿用 #79 和 #81 的主线实现。快捷键速查旧工作树的两处诊断夹具和 NSIS 验证正则已逐项与当前主线核对一致。

### M3 契约与产品证据

**Host RPC 1.0 已合入。** M3 签名参考场景、公开会话钩子、配对图表和 Windows 产品更新已有主线证据。当前接续任务与阶段顺序见[当前任务顺序](#当前任务顺序)。 [M3 Host 1.0](https://github.com/YanChao001/serial-workbench/pull/62)

PR #55 与 #56 对应候选均通过本机综合验收、208 项无头 UI 和完整四目标 CI 的 13 项必跑作业。Windows 真实图表保存与两轮 Intel macOS 首轮失败、同源复验均可从各自 CI 追溯。 [PR #55 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44893314699) · [PR #56 四目标 CI](https://github.com/YanChao001/serial-workbench/actions/runs/44904815981)

| M3 事项                        | 已有证据与下一步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本协商与签名 UART（DIAG-08） | 四个 Rust 目标通过版本不兼容引导与签名公开 SDK 的双向 UART 金样。VCD/CSV、校验位和 BREAK 按 M5 验收。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 图表离屏导出（VIZ-13）         | Windows 真实保存对话框核对焦点返回、曲线和 Host 换代，签名参考场景核对 MCP 文件结果。其余格式按 M4/M5 验收。 [Windows 复验](https://github.com/YanChao001/serial-workbench/actions/runs/44893314699/artifacts/14702887521)                                                                                                                                                                                                                                                                                                                                                                                                         |
| 后台升级（T14）                | PR #60 的 `6775722` 在隔离 Windows 以验收密钥完成产品签名升级。0.1.0 正常退出，0.1.1 自动重启，Host 代次 1→2 并保留身份、profile 和卸载注册。PR #58 覆盖换入中断及注册回滚。正式发行签名和旧正式发行版升级继续按 T14 验收。 [桌面升级收据](https://github.com/YanChao001/serial-workbench/actions/runs/45230713894/artifacts/14848730614) · [两版换入与注册回滚](https://github.com/YanChao001/serial-workbench/actions/runs/45175282344/artifacts/14820495565)                                                                                                                                                                    |
| 网络 API（AUTO-12）            | 本机 HTTP 已合入，和配对 WebSocket、LAN TCP 的独立认证与版本拒绝有同候选证据。HTTP 已实测来源、游标、重试和授权撤销。配对浏览器 Raw 与 IPC 的字节对照及 LAN 返回游标的双栈回环续读已定向通过，证据分别绑定实际构建。同一综合候选复验后核对软件账本。 [当前合入](https://github.com/YanChao001/serial-workbench/pull/56) · [专项验收](./acceptance.md#本机-http-控制)                                                                                                                                                                                                                                                               |
| 公开 SDK 合约                  | 四目标签名参考场景和实际 Claude Code stdio MCP 已有证据。`a2926b6` 通过 13 项必跑作业并合入 `main@2641506`。隔离 Windows 从 RPC 0.1 升至 1.0，保留 Host 身份、profile 和卸载注册，旧 CLI 收到 `PROTOCOL_UNSUPPORTED`。Ubuntu 隔离断网安装后运行签名终端、图表和自动化。正式发行签名仍按 T14 验收。 [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45281633279/attempts/2) · [Windows 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45281626888/artifacts/14871361995) · [Ubuntu 收据](https://github.com/YanChao001/serial-workbench/actions/runs/45286376831/artifacts/14873136854) |

M3 会话钩子已随 #58 合入。公开 Node SDK 接收有序的连接、断开、收包、发送和错误事件。隔离 Host 用 Virtual Echo 核对真实 RX/TX、关闭与回调失败后的读端释放。AUTO-14 已开始验收，缺口后的解析器重置及跨代晚结果继续逐场景核对。公开 SDK 1.0 以 #62 的合入与四目标验收记录为准。 [PR #58](https://github.com/YanChao001/serial-workbench/pull/58) · [M3 Host 1.0](https://github.com/YanChao001/serial-workbench/pull/62)

### M0–M6 界面审查

M0–M6 界面候选 #77 通过精确候选的 13 项必跑作业及 Windows 签名图表窗口验收，已合入 `main@c404af9`。 [PR #77](https://github.com/YanChao001/serial-workbench/pull/77) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45503989022)

- 工作台与设置统一控件、窄窗、焦点和错误反馈，覆盖命令库、会话对比、回放、录制文件、任务与自动化。
- 配对、接管及插件视图统一权限、语言、关闭焦点和窄窗状态。M5 频谱、统计及跨源 XY 随 #80 复验。
- 更新、恢复和诊断已跑无头 Chromium。Windows 卸载清理选项通过 `makensis /WX` 夹具，原生窗口、缩放、系统剪贴板及三平台发行安装继续验收。

[界面设计](./ui-design.md) · [宽窄草稿](./ui-design.md#浏览器配对与写入接管草稿) · [命令库草稿](./ui-design.md#命令库和会话对比草稿)

### M4 已有实现与待验

传输批次随 #75 合入。M4 规则触发、日历任务、多端口广播、命令库撤销与接收区右键随后通过精确候选的四目标综合门禁，13 项通过，并随 #76 合入 `main@5de9f55`。该批次保留首方图表 0.1.2、自动化 0.1.5 和九个签名前驱。对应需求账本登记 PR 证据。专项中仍待的设备、故障和发行场景继续按各自范围验收。 [PR #76](https://github.com/YanChao001/serial-workbench/pull/76) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45478885978)

- 录制内搜索（LOG-10）随 #81 合入。Host 分页搜索文本或 HEX，支持取消、原字节定位和侧车重建。跳转保持暂停。四目标通过，近 1 GiB Windows 结果为历史专项。 [PR #81](https://github.com/YanChao001/serial-workbench/pull/81) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45640702694) · [专项验收](./acceptance.md#录制内搜索log-10)

- 不可信终端序列（SEC-08）随 #79 限制外链来源。实时 ANSI 仅允许用户显式打开合规链接，录制和回放保留文本与颜色。24 项无头回归通过，包含改动的 #82 通过四目标。原生 WebView 与其他导入来源待验。 [PR #79](https://github.com/YanChao001/serial-workbench/pull/79) · [专项验收](./acceptance.md#不可信终端序列sec-08)

- TCP 客户端和服务端（NET-01）随 #78 合入。隔离 Windows Host 与独立 TCP 对端验证双向收发、半关闭、撤权和回收，签名随包通过首启、重启及四目标。远程串口（CONN-12）包含 TCP、RFC 2217 和 #82 的 WebSocket。慢连接、第三方网关、跨机与发行待验。 [PR #78](https://github.com/YanChao001/serial-workbench/pull/78) · [专项验收](./acceptance.md#签名插件传输)

- RFC 2217 客户端（NET-06）随 #78 合入。隔离 Windows Host 验证不匹配、拒绝、超时、重开恢复和 DTR/RTS 不确定回执。随包 0.1.1 保留签名 0.1.0 前驱，已经核对首启、重启及四目标。第三方设备与发行待验。 [专项验收](./acceptance.md#rfc-2217net-06) · [宽窄草稿](./ui-design.md#rfc-2217-连接草稿)

- 规则与日历已随 #76 合入，整合时保留首方 0.1.5 签名归档与两个前驱。38 项脚本和 25 项无头 Chromium 用例通过，覆盖夏令时、休眠、停止、任务重新打开和源证据，以及 440 与 1240 像素的输入与状态位置。Host 及传输测试目标通过编译检查，Rust DTO 与桌面 IPC 生成核对通过。隔离原生运行与异常退出结果见下方专项。真实设备和正式发行继续验收。

- M4 传输批次 #75 交付读写进度、文件拖放、选区导出、字节分色、会话模板、故障向导和数据驱动。52 项单测、51 项无头用例、3 项自动化包用例、绑定检查及四目标通过。真实窗口、串口对端和发行待验。 [PR #75](https://github.com/YanChao001/serial-workbench/pull/75) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45453895436/attempts/2)

- 字段模板和 Modbus 主站已随 #64 合入 `main@0c3c283`。精确候选 `dbae69a` 通过完整四目标的 13 项必跑作业。字段定义、CRC 识别、JSON/YAML、双向编解码和数值报文编辑已核对软件证据。Modbus 独立对端、其余协议模板和正式发行继续验收。 [PR #64](https://github.com/YanChao001/serial-workbench/pull/64) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45310433135)

- Modbus 实时从站、寄存器监视、字段标定、帧异常和开发启动修复已随 #65 合入 `main@5827258`。精确候选 `33af540` 在同一提交复跑 Apple Silicon 桌面后通过 13 项必跑作业。 [PR #65](https://github.com/YanChao001/serial-workbench/pull/65) · [首轮桌面失败](https://github.com/YanChao001/serial-workbench/actions/runs/45320639501/job/138198056122) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45320639501/attempts/2)

- 冷检出开发启动已补齐资源准备。缺少 `dist/index.html` 时，`pnpm app:dev` 在启动桌面前生成配对浏览器资源。脚本回归验证缺失时准备、已有时复用和构建失败退出。真实窗口仍按桌面验收边界检查。

- Modbus 主站事务（PROTO-09、PROTO-17、PROTO-20）使用事务租约、真实 TX 和 Raw 来源。RTU/ASCII/TCP 可配对分块应答，FC01—04 可显式限次重试并标明迟到或尝试归属。主站动作随包，独立设备和发行待验。 [主站事务验收](./acceptance.md#modbus-主站事务参考动作proto-09proto-17proto-20)

- 会话对比（PROTO-11）已随 #69 合入，支持按帧位置、字节前缀和多个协议字段对齐，以及字节、字段和相对时间差。回放投影保留事件和录制序号，缺口不补时间值。只读回放可分别固定基准和对照帧窗，并从工作台查看来源及差异。字段随包 0.3.0 增加签名会话对比动作，返回匹配摘要和分页明细。原生用例核对授权及读回结果。候选通过四目标的 13 项必跑作业。实机录制与正式发行继续验收。 [PR #69](https://github.com/YanChao001/serial-workbench/pull/69) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45364779379)

- Modbus 从站模拟（PROTO-17、PROTO-20）随 #65 支持三种封装、八个功能码、四张地址表及异常或静默。Windows Host 用虚拟对端核对分块读写、TX 和取消释放租约。线路时序、真实设备及发行待验。 [从站验收](./acceptance.md#modbus-从站模拟proto-17proto-20)

- Modbus 寄存器视图（PROTO-10、PROTO-20）随 #65 支持两类寄存器读取和监视、保持寄存器显式写回，可查看地址基准、字节序和异常。三种封装的设备对照与发行待验。 [寄存器验收](./acceptance.md#modbus-寄存器与监视proto-10proto-20)

- 字段标定（PROTO-16）已随 #65 合入，接通版本化线性系数、精确查表和单调插值。字段预览与随包签名动作保留原始码值、字节区间和标定版本，构造复用同一组系数反算。本机确认 0.1.0 升至 0.2.0 时保留启用、停用及卸载决定，真实 Host 核对标定的构造和解码。图表追溯、多项式扩展、独立设备和正式发行继续验收。

- 帧异常检查（PROTO-08）已随 #65 合入，读取已验证的分帧结果。长度、校验和序号采用用户字段定义，通过来源事件和超时阈值判断帧间超时。断档、时钟变化和会话配置切换阻断跨段判断。独立对端注入及发行实装继续验收。

- 总线负载（VIZ-10）已随 #69 合入，接入实时与只读回放的分帧结果，显示固定源时钟窗口的 RX、确认 TX、分帧与协议错误率。软件夹具核对收发回执、损坏帧、缺口和续页分帧范围，软件候选通过四目标门禁。独立线路仪器和发行继续验收。

- 字段曲线联动（VIZ-16、PROTO-16）已随 #66 合入 `main@32d77ee`。字段曲线读取已验证分帧页，也可按明确的固定帧边界从当前回放页解码。曲线和字段表共享游标，显示原始字节范围和录制序号，并可按来源事件和字节偏移反查。主接收与回放的 HEX 选区可转入字段曲线，曲线可返回原接收位置。筛选和压缩保留原坐标，采集断档单独标出。同一候选通过四平台综合门禁，独立设备及发行实装继续验收。 [PR #66](https://github.com/YanChao001/serial-workbench/pull/66) · [四平台门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45327829051)

- 基础图表统计（VIZ-05）已随 #67 合入 main 的字段曲线与图表插件。当前范围显示最小值、最大值、均值、总体标准差、P50/P95/P99、有效点及缺点比例。固定帧回放和派生图表使用可确认的缺失位置。首方图表 0.1.0 的签名归档列入 Host 随包和组件清单，外部参考图表保留独立身份。精确候选通过四目标门禁及 Windows 签名图表实际窗口。高级窗口随 #80 合入，见下文。 [PR #67](https://github.com/YanChao001/serial-workbench/pull/67) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45336554720)

- AT 响应（PROTO-04）已随 #64 合入，接入工作台与随包动作，区分命令回显、最终结果、主动上报、输入提示和消息负载。真实调制解调器、设备实录及发行实装待验。

- NMEA 0183（PROTO-04）已随 #64 合入，接入 GGA、RMC、GSA、GSV 和 VTG 的随包动作与本地预览，保留原行号、字段源字节、校验结果及 GSV 片号。设备实录、发行实装及其余协议模板待验。

- 首方图表的离屏 SVG 随 #55 合入，字段曲线 CSV 和首方图表的离屏 PNG 随 #68 合入（VIZ-13）。CSV 保留筛选范围、逐帧精确数值和原始字节来源。图表导出由桌面与 MCP 共用 Host 文件结果。当前首方图表归档为 0.1.2。 [PR #68](https://github.com/YanChao001/serial-workbench/pull/68)

- Modbus 报文（PROTO-04、PROTO-20）已随 #64 合入，接通工作台与随包动作。RTU、ASCII、TCP 的独立金样及 FC01/02/03/04/05/06/15/16 请求响应往返通过，包含异常、广播、数量边界及 CRC/LRC/MBAP 失败定位。离线配对覆盖事务 ID、单元标识、功能码、读数量和填充、写回显、异常码及响应样本缺失。主站事务等待与重试见上文。其他协议模板、设备及发行仍待验收。

- M4 通用分帧（PROTO-01）已通过四目标的 13 项必跑作业并合入 `main@150209e`。工作台支持六模式组合、精确来源续页与首方登记。原生验收核对安装等待、共享 Node 卸载保护和恢复。线路静默的独立设备验收及正式离线安装继续按实机和发行专项完成。 [PR #63](https://github.com/YanChao001/serial-workbench/pull/63) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45302722280)

- PR #58 的 `cf4b4fc` 在隔离 Windows 完成真实 NSIS 0.1.0 到 0.1.1 的换入、Host 代次 1 到 2、同一身份与 profile 恢复，以及摘要拒绝和注册写入中断恢复。这里的注册恢复由隔离验证程序执行。独立产品升级场景首轮完成两版构建后达到任务时限，新的复验分别记录证书准备和真实桌面升级阶段。 [PR #58](https://github.com/YanChao001/serial-workbench/pull/58) · [两版安装收据](https://github.com/YanChao001/serial-workbench/actions/runs/45194202380/artifacts/14828417740) · [桌面更新复验](https://github.com/YanChao001/serial-workbench/actions/runs/45204372209)
- M4 工作台基础已随 #59 合入。集成范围包括混合发送、HEX 校验定位、转义与追加校验、带原始偏移的录制导出、多源只读回放、脱敏诊断、快捷键、插件视图语言和 ANSI 终端。精确候选 `bf1563b` 通过四个 Rust 目标、四个平台真实桌面及最终门禁，合入提交 `85f1190` 的文件树与候选一致。模拟串口验证 `transfer.paste` 的独占顺序、编号回执与取消前缀，物理串口和发行包继续按对应专项验收。 [PR #59](https://github.com/YanChao001/serial-workbench/pull/59) · [四目标综合 CI](https://github.com/YanChao001/serial-workbench/actions/runs/45218765368)
- 基础候选的快捷键速查（DIAG-05）通过 F1、命令搜索、发送模式、冲突和重载复验。诊断包（DIAG-06）通过脱敏测试及 Windows 原生保存。收据验证预览与落盘数据一致，记录格式、字节数与摘要，发行安装场景仍按 T14 验收。 [快捷键浏览器作业](https://github.com/YanChao001/serial-workbench/actions/runs/45218765368/job/137847867653) · [Windows 保存收据](https://github.com/YanChao001/serial-workbench/actions/runs/45218765368/artifacts/14840297881)
- 基础候选 `bf1563b` 的混合输入、发送转义、合法性校验与追加校验（IO-02、IO-03、IO-04、IO-13）通过 94 项定向单测。浏览器核对按所选编码生成字节、范围报错和 Modbus 预览与提交一致。设备实机和发行按各场景验收。 [基础 PR](https://github.com/YanChao001/serial-workbench/pull/59) · [浏览器作业](https://github.com/YanChao001/serial-workbench/actions/runs/45218765368/job/137847867653)

#### 终端与收发工具

终端增强与工作区命令库已随 #61 合入 `main@6b87766`，后续 #79 补齐录制外链边界。以下记录各软件场景及仍适用的原生、设备验收。 [PR #61](https://github.com/YanChao001/serial-workbench/pull/61) · [PR #79](https://github.com/YanChao001/serial-workbench/pull/79)

- ANSI 鼠标和链接（TERM-11）已接入实时 ANSI。无头 Chromium 核对 SGR 和经典鼠标原始字节、选区优先、真实焦点、合成事件拒绝，以及 OSC 8 的原生外链调用夹具、键盘和中键激活与接收缺口清理。真实桌面外链和设备端交互继续专项验收。
- 编码识别依据（TERM-07）已接入工作台。编码单元测试核对 BOM、UTF-8、GB18030 和证据不足。无头 Chromium 以跨包 GBK 数据对照样本数、字节分布得分、手动误选与候选重解码，并复查自动设置和 UTF-16 发送。
- ANSI 回滚历史（TERM-15）加入窗口偏好、保留范围、淘汰提示与行号跳转。无头 Chromium 以 12,000 行连续 RX 核对首次启用和保存行数上限、首尾与中段跳转、冻结时接收与恢复、缩小缓冲后的淘汰、以及应用切到备用屏幕和返回。真实桌面与物理串口继续专项验收。
- ANSI 屏幕搜索（TERM-16）复用可取消且有时限的搜索工作线程。无头 Chromium 核对正则错误、匹配高亮及前后跳转、跨软折行的宽字符、硬换行边界和备用屏幕切换。已被清屏覆盖的文字仍可在原始字节搜索中定位。真实桌面继续专项验收。
- ANSI 色彩（TERM-13）采用浅深主题各自的基本色表，并保留扩展索引色和设备真彩色。无头 Chromium 在两个主题下对照屏幕色样和保存内容，分别核对基本色、扩展索引色和真彩色前景及背景。快照保留文字，链接目标留在原始数据。真实桌面文件对话框继续专项验收。
- ANSI 字体（TERM-14，复用 DISP-16 偏好）接入编程连字。无头 Chromium 用具有明确替换字宽的合成字体对照启停，在 20 px 字号、175% 行高下缩放窗口，再用鼠标选取并复制连字内的单个字符。真实桌面字体和设备继续专项验收。
- ANSI 尺寸上报（TERM-03）以可写会话为范围，显式开启后交由 ANSI 发送队列结算。无头 Chromium 对照本地缩放后的行列和发送字节，核对默认静默、冻结撤销和对端命令不触发上报。队列测试覆盖在途写入、最新尺寸替换和撤销待发。仍待约定了 CSI 的实际对端验证。
- HEX 格式化（DISP-02）支持大小写、四种分组、每行字节数、地址和 ASCII 栏。单测对照 64 位地址与末行对齐。无头 Chromium 核对切换大小写、分组和附加列后保留跨行原字节选区，原数据读取连接保持同一订阅。真实桌面 WebView 的指针选区仍待同候选验证。
- 发送历史（IO-06）已随 #69 合入，复用 Host 的操作投影、原始请求与结算。工作台可按端口、时间、会话筛选，按窗口持久化固定项，按所选顺序预览原字节和可写目标。批量重发逐条重新验权并等待完整写入，部分写入、变更或未知时停止后续项。超出当前操作投影的固定项可按 ID 重新验权查询或解除固定。实际串口和发行证据仍待补齐。
- 命令库与变量（IO-05、IO-07）随 #61 接入分页、改序、按修订保存、变量预览、自定义行尾及归档。SQLite、IPC 和无头用例验证权限、原字节与写满回滚。完整要求的剩余验收见账本。 [变量与行尾](./acceptance.md#命令库变量与行尾io-05io-07) · [归档验收](./acceptance.md#命令库归档io-07)
- 规则触发（AUTO-07）随 #76 支持文本或字段匹配、来源定位、通知及已签名命令。隔离 Host 和真实配对浏览器核对跨窗口通知、重复武装、按命令授权、取消及跨工作区不发送。实际写库插件、串口对端与发行待验。 [专项验收](./acceptance.md#规则触发auto-07)

- 测试套件与报告（AUTO-06）已随 #74 合入。精确候选通过完整四目标的 13 项必跑作业。浏览器按同一会话运行签名序列，核对 JUnit XML 与 HTML、两轮实际趋势，以及失败、取消、跳过和无法确认的分类。原生保存对话框、实际对端和发行继续验收。 [PR #74](https://github.com/YanChao001/serial-workbench/pull/74) · [报告场景](https://github.com/YanChao001/serial-workbench/actions/runs/45437638803/job/138599722219) · [验收方法](./acceptance.md#测试套件与报告auto-06)
- 多端口广播（IO-17）随 #76 按目标独立验权、提交、取消和重查回执。真实配对浏览器用 Virtual Echo 和独立 TCP 对端核对精确收发与断连时的零接纳。双物理串口的仲裁、停止与发行待验。 [专项验收](./acceptance.md#多端口广播io-17)
- 撤销重做（UX-12）已随 #76 合入命令库，加入跨字段草稿历史，沿用发送区快捷键。8 项无头 Chromium 用例核对 420/1240 像素操作栏、跨字段撤销、焦点回退、保存冲突后保留历史及不同分组隔离。49 项发送编辑和模板单测通过。真实桌面键盘和发行候选继续验收。 [宽窄草稿与专项验收](./acceptance.md#发送与命令库的编辑撤销ux-12)
- 接收区右键操作（UX-08）已随 #76 合入，接入复制格式、发送选区预览、时间书签及在此分屏。无头 Chromium 核对右键和 Shift+F10、宽窄确认窗、源字节与 Host TX 请求一致、撤权和只读时禁用写入、原事件定位及清屏后的失效反馈。46 项接收、选区复制与定位单测通过。真实 WebView、系统剪贴板、串口与正式发行继续验收。 [宽窄草稿与专项验收](./acceptance.md#接收区右键操作ux-08)
- 文件拖放（IO-18）随 #75 接入桌面发送，#78 补齐桌面命令槽和配对浏览器。显式确认后才提交发送或应用 HEX 草稿。两批通过四目标，真实配对 Chromium 与独立 Raw 核对实际选区及回执。原生桌面拖放、实体串口和发行待验。 [PR #78](https://github.com/YanChao001/serial-workbench/pull/78) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45532404818) · [专项验收](./acceptance.md#文件拖放发送io-18)
- 复现实验包（SESS-09）随 #78 合入。导出按修订选择证据并脱敏，导入先检查依赖，再显式保存和重绑。四目标门禁的 Windows 双 Host 实验核对确认前只读、缺失依赖及保留线路。原生文件对话框、物理设备、跨机及发行待验。 [设计与验收](./acceptance.md#复现实验包sess-09)
- 传输进度（XFER-04）随 #75 分别显示文件读取、Host 接纳、设备确认和取消终态。定向前端、Host、无头回归与四目标通过。真实设备确认与发行安装待验。 [验收方法](./acceptance.md#文件传输进度xfer-04)
- 会话模板（SESS-03）已随 #75 合入，接入 STM32 调试、AT 模组和 Modbus RTU 从站。模板预览当前设备及线路参数，显式打开沿用 Host 接纳和实际配置回执，已打开会话禁止套用新参数。缺少从站动作时转到插件管理，示例与实时动作分别触发。 24 项无头 Chromium 回归通过，覆盖缺依赖时打开管理页、目录登记后重开、线路参数和已打开会话保护。真实串口、插件签名恢复和正式发行继续验收。 [验收方法](./acceptance.md#会话模板sess-03)
- 故障向导（DIAG-02）已随 #75 合入，接入打不开、乱码、丢数据和断连四条路径。打开失败按连接栏端口归属，接收样本和重连数据按活动会话归属。用户可应用候选接收编码、查看字节或指标，或显式重试对应端口。 120 项定向单测与 7 项无头 Chromium 回归通过，浏览器核对实际请求的目标及应用编码后保留原视图和订阅。候选四目标门禁通过。实际串口故障与发行环境继续验收。 [验收方法](./acceptance.md#故障向导diag-02)
- 参数化与数据驱动（AUTO-09）已随 #75 合入，支持 CSV 和变量表，显式映射列与类型，按输入顺序在接纳前校验所有轮次。工作台支持导入 CSV 并在套件报告中保留物理行号或变量表行号。8 项定向单测覆盖跨行 CSV、类型转换、行上限与失败后的来源追踪。无头 Chromium 核对无效 CSV 保留草稿、按行下发、失败跳过、导出和更换输入后的报告归属。四目标门禁通过。实际串口对端和正式发行继续验收。 [验收方法](./acceptance.md#参数化与数据驱动auto-09)
- 测试用例与断言（AUTO-05）已随 #73 合入，复用命令序列。支持逐次 HEX 断言和显式配置的超时重试，保留各次写入 ID、定义路径和响应来源。覆盖迟到应答、部分写入、源证据缺失、交错写入及重试预算。独立设备和正式发行继续验收。 [验收方法](./acceptance.md#测试用例与断言auto-05)
- 手工发送录制（AUTO-04）随 #72 接入。只按完整 TX 和相邻源区间生成连续序列，配对场景核对发送区、选区、临时引用、256 字节文件重绑和重试冲突时零新增 TX。系统密钥、长文件传输、原生选择器、其他手工动作及独立串口待验。 [验收方法](./acceptance.md#手工发送录制auto-04)
- 命令序列（IO-10）随 #71 接入签名 Host 动作与工作台。支持 HEX、变量、延时、循环、应答分支及取消。Windows 签名 Host 和无头回归核对写入、应答、源游标、授权及重试边界。独立对端、精确候选四目标与发行继续验收。 [验收方法](./acceptance.md#命令序列io-10)

- 日历定时任务（AUTO-08）以定点或带时区的 cron 武装，提交前复核修订和权限。Windows 隔离 Host 核对正常及异常重启后不补发、修订冲突和撤权时零收发。独立设备与发行待验。 [专项验收](./acceptance.md#日历定时任务auto-08)

- 定时与循环发送（IO-09）随 #70 合入 `main@192ebfc`，13 项四目标作业通过。签名 Host 验证周期、抖动、RX 起止、逐轮应答与取消，工作台可重开原任务查询。实体串口与发行安装待验。 [PR #70](https://github.com/YanChao001/serial-workbench/pull/70) · [四目标门禁](https://github.com/YanChao001/serial-workbench/actions/runs/45375317753) · [签名后台验收](./acceptance.md#定时与循环发送io-09)
- 多行发送编辑（IO-01）接入滚动行号、匹配模式的语法着色、双向选区缩进和混合草稿块注释。单测核对行边界、选区和注释解析。无头 Chromium 核对反向选区、原生撤销、行号同步、注释后的 HEX 预览和实际提交参数。真实桌面候选继续验收。
- 接收文本高亮（DISP-07）已接入窗口规则编辑、重叠优先级和可终止 Worker。单测覆盖 Unicode 偏移、无效规则、禁用、输出上限和 Worker 超时清理。无头 Chromium 核对样式、排序、无效正则期间继续接收、原样 HEX 和长记录展开页。真实桌面按专项验收。
- 接收静默分帧（DISP-09）可为当前会话选择收块间隔，保留既有包边界。包时间标明门限、来源及分辨率，字节数沿用实际留存范围。单测核对阈值包含关系、时钟粒度变化和冻结快照的边界保留。无头 Chromium 核对切换门限、按源时钟分包及同一 Raw 订阅。真实桌面和设备端时间精度继续专项验收。
- 长记录折叠（DISP-19）保留长度、缺片和错误，展开时逐页生成内容。单测核对完整 64 位长度、字节缺口、发送错误及 UTF-8 跨页。浏览器复验接收突发逐页等于原数据、消息的未留存片段和大型回放引用。真实桌面和签名传输对端待候选验收。
- 接收记录编号与定位（DISP-14）区分显示行、显示包和原事件。单测覆盖全宽事件号、重复来源、已淘汰范围和发送回执替换。浏览器验收检查按三种编号跳转、复制定位号、解除显示筛选后回到原事件，以及清空显示后的失效提示。录制实机与真实桌面剪贴板待候选验收。
- 接收查找与过滤（DISP-12）支持按 RX/TX 和正则或 HEX 命中显示或隐藏记录。单测核对双向连续性、跨记录区间和超限回退。无头 Chromium 核对方向切换、跨记录正则命中、可见字节统计、无效请求回退与原订阅保持。真实桌面和录制对照待同一候选验收。
- 多格式复制（DISP-13）以相同的 HEX 或 ASCII 原字节选区生成文本、HEX、带时间戳文本、C 数组、Python bytes 和 Base64。定向测试核对同一选区的六种结果、跨事件 UTF-8、可切换解码及时间来源。真实桌面剪贴板仍待同候选验证。
- 协议字节分色（DISP-08）在分帧、只读回放和报文构造共用字段预览。帧头、地址、长度、负载和校验可分色，选择字段可查看值、原始字节及范围。单测核对共用字节与 64 位偏移，无头 Chromium 核对键盘操作、录制来源以及解析失败回到原字节。真实桌面和发行继续验收。 [专项验收](./acceptance.md#协议字节分色disp-08)

- 选区导出（DISP-20）在工作台字节选区提供浅色或深色 HTML 和 SVG。HTML 保存整段，SVG 每页最多 1024 字节。单测核对转义、精确偏移、短末页、来源失效和取消保存。无头 Chromium 用实际跨事件选区核对文件名、范围及字节。配对 Chromium 用独立 Host 的两条 RX 事件，按 CLI Raw 结果复验 420 像素窗口中的 4 字节选区以及实际的深色 HTML 和浅色 SVG 下载。本地收据位于 `.cache/evidence/receive-selection-browser/accepted/receipt.json`。真实桌面保存和发行继续验收。 [专项验收](./acceptance.md#接收选区导出disp-20)
- 多进制数值解释（DISP-03）接入 HEX 与 ASCII 选区。单测核对跨记录的连续原字节、断档拒绝、64 位整数、浮点负零、无穷和 NaN。无头 Chromium 用实际接收视图对照 ASCII 选区、源偏移、位宽和端序切换。真实桌面选区仍待同候选复验。
- ANSI 本地键入回显（TERM-09）按会话显式开启。无头 Chromium 对照按键实际发送字节、退格、独立设备回显和 ANSI 彩色导出，并核对关闭或冻结时清除本地输入。单测核对 Unicode 组合字符和留存上限。实际无回显串口设备以及真实桌面仍待同一候选复验。
- ANSI 的 POSIX shell 设置（TERM-12）按可写会话选择 TERM、COLORTERM 和行列。无头 Chromium 核对自定义与当前尺寸、非法 TERM 拒绝、显式插入和 Enter 独立发送。本机 POSIX sh 对照单色和真彩色两组环境变量。仍待实际设备的 shell 启动脚本与平台验收。

### M5 已有实现与待验

- 专业频谱（VIZ-04）随 #80 提供 FFT、逐窗瀑布图和直方图。金样、Chromium 与签名 Host 四目标覆盖采样率、主峰、缺样和分箱。独立设备实录与市场发行待验。 [PR #80](https://github.com/YanChao001/serial-workbench/pull/80) · [四目标验收](https://github.com/YanChao001/serial-workbench/actions/runs/45615772681/attempts/2) · [频谱验收](./acceptance.md#专业频谱瀑布图与直方图viz-04)

- 高级统计（VIZ-05）随 #80 按样本位置或固定时钟划窗。计算与无头用例核对半开边界和两类空窗，四目标签名 Host 核对缺样。独立实录与市场发行待验。 [专项验收](./acceptance.md#高级统计窗口viz-05)

- XY 与散点（VIZ-06）先随 #67 支持同帧配对，#80 增加时钟校准、漂移修正和可追溯插值，#82 接通实时及回放样本。连接或权限失效收回样本和报告。签名 Host 与样本交接通过四目标。独立设备和发行待验。 [专业 XY 验收](./acceptance.md#专业跨源-xy-与李萨如viz-06)

- MDF4（VIZ-13）随 #80 支持实时及回放字段导出 MDF 4.10。独立读取器通过，签名桌面与 MCP 文件一致。MATLAB 读回、市场和正式安装待验。 [MDF4 专项验收](./acceptance.md#mdf4-专业导出viz-13)

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
