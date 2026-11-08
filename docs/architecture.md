# 架构说明

当前产品范围见 [产品范围](./product-scope.md)。本文维护当前公共框架的职责、数据归属和生命周期。

## 运行时结构

前端从 `main.tsx` 挂载 React，`App.tsx` 组装 Provider、HashRouter 和路由边界。主导航由 [routes.tsx](../src/routes.tsx) 提供空白工作区和设置。诊断恢复归入设置，启动隔离使用独立受保护页面。

Tauri 从 [main.rs](../src-tauri/src/main.rs) 进入 [lib.rs](../src-tauri/src/lib.rs)。Rust 组装窗口、设置、恢复和更新服务，持有原生资源及持久化权威。页面、组件和 Hook 通过 [tauri.ts](../src/lib/tauri.ts) 门面调用原生能力。

浏览器共用界面源码和 HashRouter，提供外观、导航与偏好预览，使用独立的浏览器存储；原生调用由门面检查桌面环境。

## 独立 Host

独立运行时位于 `crates/host`，CLI、MCP 和 Rust 客户端经本机 IPC 共用目录、授权与 Operation。设备目录协调系统串口、PTY 与 Virtual，设备服务持有会话 owner、TX 门控和重连责任；raw 通路与状态投影分开，慢读者与 capture 使用各自有界预算。`packages/host-client` 提供不依赖 React / Tauri 的客户端投影、增量解码与转换。

共享设置和工作区由 Host 的 SettingsService / WorkspaceService 经 Store 持久化，以文档 revision CAS 保存并发布投影；读取失败、损坏或未来格式会阻止覆盖。它们与下文桌面 `settings.json`、`workspace.json` 的存储职责分别维护，桌面继续使用现有 Tauri 服务。

FileService 将显式登记的位置与内容引用分开；固定内容引用携带 revision，派生 capture / record 引用沿原授权来源复查。Capture 持有录制责任，停止后独立读回验证再发布完成状态；恢复另存已验证前缀，替换保留归档与失败证据。回放使用独立文件 reader，不创建设备 Transport。格式见 [Capture 容器](./contracts/capture-container-v0.md)。

Host 指标记录实际队列与资源计数；shutdown 协调已接纳任务、TX、capture、设备和持久化结算，报告未结算操作、隔离会话、证据引用与失败。超时后原 owner 继续持有未完成资源和清理责任，已发出而无最终回执的效果保留 unknown。客户端效果管理层负责登记、转发和回执，Native 系统效果执行器留待后续集成。

## 模块职责

| 模块             | 职责                                                          |
| ---------------- | ------------------------------------------------------------- |
| 路由、布局和命令 | 工作区与设置入口、键盘与菜单、加载与错误边界                  |
| 设置模型和同步器 | 当前扁平格式归一化、revision合并、在途写入与跨窗口事件        |
| 窗口和生命周期   | 主 / 次窗口、托盘、几何恢复、首帧显示、关闭 / 退出 / 重启协商 |
| 文件授权         | 用户明确选择位置后的文本导出                                  |
| 诊断和恢复       | 脱敏系统报告、设置故障隔离、确认后的默认设置暂存与启动安装    |
| 更新框架         | 固定信任策略、检查 / 下载快照、验签及安装前生命周期协商       |

## 命令与桌面交互

菜单、命令面板和快捷键复用 `src/commands/`，路由命令从 `routes.tsx` 生成。命令只表达当前可用操作，保持环境和窗口过滤；设置搜索直接定位设置分区。未知浏览器路由回到首页，原生深链仅接受允许的本地路由。

应用身份和深链 scheme 来自 [app.config.json](../app.config.json)。深链只用于允许路由的导航，单实例激活与次窗口恢复沿用原生窗口所有权。

未保存工作由调用方登记 `useUnsavedWork`，保存、放弃和取消参加离页与退出协商。原生维护、下载和其他在途操作按真实结束释放占用；停止前端等待不等于原生回滚。次窗口的关闭行为由窗口生命周期管理，不能绕过全应用退出协商。

## 通信机制

Rust 命令和 DTO 是 IPC 类型来源，统一在 `bindings.rs` 注册。签名、DTO 或注册变化时生成并检查 [bindings.ts](../src/lib/generated/bindings.ts)，步骤见 [页面到 IPC 流程](./development.md#新增页面到-ipc-与测试)。

门面负责环境检查和错误归一化，命令返回 `NativeResult<T>`，错误含稳定 `code`、`message`、`retryable`。前端按 `code` 处理，Rust 提交边界校验身份、大小、路径和权限。阻塞 I/O 移入有界阻塞池，任务满额返回 `NATIVE_BUSY`；已开始的同步任务保持占用直至真实完成。

订阅先建立再读快照，按revision与操作ID过滤旧消息。事件不是持久消息队列，写入结果以命令返回为准。异步订阅处理卸载、StrictMode重建及取消函数晚到，避免旧回调更新新界面。

## 状态管理与当前扁平格式归一化

页面状态留在组件；跨页偏好由 `SettingsProvider` 管理，命令由 `CommandsProvider` 管理。设置 schema、当前扁平格式归一化和默认值以 [settings-model.ts](../src/lib/settings-model.ts) 为准。

桌面 `settings.json` 是权威快照，Rust 使用原子替换与 revision CAS。前端同步器分离未提交与在途字段，冲突后重读并有限重试，失败保留修改；跨窗口只接受更新 revision。主题、语言、字体、皮肤和壁纸引用共用该模型。

普通保存拒绝覆盖未来 schema。用户明确确认的设置重置可以替换已读入的未来设置，仍检查 revision 并原子写入；启动隔离中的恢复流程保留未来格式保护，见下文。

浏览器使用独立localStorage与IndexedDB。读取失败保留原存档，修改暂留内存；重试先读成功再合并明确修改的字段。命名空间隔离同源产品数据，不构成脚本安全边界。

网络偏好选择后续原生 HTTP 的直连或系统代理，供更新请求使用；不修改进程代理环境或已开始操作，更新端点与验签规则继续生效。

## 数据存储

| 数据           | 位置与边界                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------ |
| 设置           | `appConfigDir/settings.json`；原子写入、revision、损坏备份及未来格式保护                   |
| 窗口与路由恢复 | `appConfigDir/workspace.json`；主 / 次窗口的允许路由与次窗口打开状态                       |
| 壁纸图库       | `appConfigDir/client-state-v0.json` 的窗口 gallery；仅保存 Host ObjectRef 与名称           |
| 自选图片与视频 | Host 登记用户选择的文件；共享背景仅保存固定 ObjectRef 与显示方式，播放票据属于当前窗口实例 |
| 日志与缓存     | `appLogDir`轮换日志，缓存只用于呈现和可再生内容                                            |

原生目录由 Tauri 路径 API 决定。默认设置恢复只替换设置，保留图库、日志及其他用户文件。

图库名称与条目属于客户端窗口状态；当前背景属于 Host 共享设置。删除图库条目只移除该元数据，不删除 Host 对象或用户原文件。原生选择器把实际文件登记为固定引用，不把路径、Data URI 或本地播放 URL 写入共享设置；原文件移动或变化后，旧引用读取失败。图片与视频共用 [文件入口](../src-tauri/src/file_resource_commands.rs) 和 [媒体协议](../src-tauri/src/media_protocol.rs)，每段读取都由 Host 复核当前权限和固定内容，协议按窗口实例与连接代次管理临时票据。响应在分配前取得名额和字节预算，释放票据不提前回收仍在运行的工作预算。

浏览器未连接媒体传输入口时保留已有背景选择，不伪造 Host 引用。若使用本地 Blob 预览，其 URL 只属于当前实例并在结束时释放；浏览器 Host 媒体传输在后续阶段接入。

内置图片由 [resources/wallpapers](../resources/wallpapers/README.md) 自动收录，设置使用稳定相对身份，不保存构建URL。皮肤资源与用户图库分开，规则见 [皮肤资源](../resources/skins/README.md)。

## 恢复、诊断与更新

正常运行时从设置进入诊断和恢复，旧 `/recovery` 路由跳转设置恢复分区。启动隔离时由 `RecoveryGate` 将普通页面导向独立恢复页，并允许访问隐藏的 `/diagnostics` 页面。设置与独立页面复用诊断内容，报告包含有限系统信息、设置 revision 和脱敏日志。

启动时，可读且未超限的损坏设置文件先备份为 `settings-corrupt-*.json`，再写入默认快照；读取、超限或备份失败保留原件。设置打开或恢复准备失败时，应用使用临时设置与临时图库隔离正式数据。

用户确认后暂存默认设置候选和待处理元数据，再由用户明确重启。下次启动验证候选与原件的未来格式保护，将正式 `settings.json` 原件重命名至 `recovery-archive-{token}/settings.json`，按恢复日志安装新设置；失败回滚或保留待处理证据。未知恢复元数据拒绝处理并保留原件供人工复核。

更新由Rust持有检查、下载和安装句柄，各窗口订阅快照。当前端点和公钥为空，框架停用且不联网。配置齐备后，安装前仍需重读策略、验证签名并重新协商全部窗口，细节见 [自动更新](./build-release.md#自动更新)。

## 安全边界

主 / 次窗口加载可信本地界面。Tauri capability与自定义命令校验是不同机制，规则见 [安全规范](./security.md)。

新增业务复用现有路由、命令、设置和门面；跨层契约、权限和窗口生命周期变化先完成 [影响分析](./engineering-at-scale.md#设计评审与-adr-门槛)，长期取舍记入 [ADR](./adr/README.md)。
