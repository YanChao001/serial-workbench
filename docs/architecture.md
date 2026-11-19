# 产品架构

## 运行结构

桌面、CLI 和 MCP 经本机 IPC 连接同一 profile 的独立 Rust Host。Host 统一持有设备、发送仲裁、原始流、录制、操作和共享文档；关闭窗口或客户端后，已接纳任务可以继续。桌面仅管理本地窗口、系统交互和呈现。

| 位置                         | 职责                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `crates/core/`               | 公共领域模型、wire DTO、错误、能力目录与导出契约              |
| `crates/ipc/`                | 当前用户本机传输、帧、发现、实例锁和受保护身份存储            |
| `crates/host/`               | 设备、流、TX、任务、录制回放、权限及共享文档服务              |
| `crates/client/`             | Host 的 Rust 认证、连接、启动与 RPC 客户端                    |
| `crates/cli/`、`crates/mcp/` | 命令行和官方 MCP SDK 适配器，共用 Host 能力                   |
| `src-tauri/src/`             | Tauri 桌面组装、Host bridge、窗口、文件选择、媒体、恢复和更新 |
| `packages/contracts/`        | 从 Rust 导出的 TypeScript、schema、默认值及校验器             |
| `packages/host-client/`      | 不依赖 React/Tauri 的客户端投影、reader 和增量解码            |
| `src/features/workbench/`    | 工作台组件、布局、发送草稿及工具                              |
| `src/providers/`、`src/lib/` | Host/设置/未保存工作协调、门面和模型                          |
| `e2e/`                       | 无头浏览器及真实桌面验收源码，证据与程序分开保存              |
| `packages/plugin-sdk/`       | Node 插件作者类型入口与编译示例；不另设一套 wire DTO          |

根 [Cargo.toml](../Cargo.toml) 管理全部 Rust 包和共享 profile，使用唯一的根 Cargo.lock。无头包能够独立构建和测试；`src-tauri/target/` 是配置的共享编译输出位置。

## 客户端入口

- 桌面：`main.tsx`、`App.tsx` 组装 Provider 与 HashRouter；[路由表](../src/routes.tsx)负责布局和导航，菜单、命令面板与快捷键共用 `src/commands/`。手写代码只经 [Tauri 门面](../src/lib/tauri.ts)访问系统能力。浏览器预览使用自己的存储，不是生产 Host 的故障回退。
- 启动：先挂载工作台，窗口草稿读取与 Host 附着并行；设备和历史数据可以稍后就绪。物理窗口、WebView 文档 instance 和 Host epoch 不可互换。切页沿用连接，文档重载退休旧连接；只有明确附着可建立新代次，普通 RPC 不隐式启动 Host。
- IPC：原生桥只投递一次。失败发生在部分写入后须断开物理连接；不得重发可能已经产生副作用的请求。授权变化时只重读或重订阅，不能补授权、重放发送或恢复旧 reader。
- CLI/MCP：Rust 客户端认证到同一 Host，使用当前授权的目录。MCP 在同一连接上完成分页发现和执行；目录版本或可见性变化应重新发现，而非重试业务。见[目录适配](../crates/mcp/src/catalog.rs)与[调用示例](./development.md#hostcli-与-mcp)。

跨入口比较时，固定资源 Host、目标、代次和当前有效授权。业务查询返回相同的可见内容，动作遵循同一接纳、取消、去重和结果读取规则。选择文件、访问剪贴板等系统交互由具备相应能力的客户端执行，无可用客户端时报告不可执行。来源密钥和代码执行信任的变更还须验证本地用户控制身份。普通身份的目录隐藏这些动作，已知动作 ID 也须拒绝越权调用。见[本地 IPC 与用户控制](./contracts/host-v0.md#本地-ipc-与用户控制)。

## 数据归属

| 数据                                    | 权威与位置                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 身份、授权、Operation、共享设置和工作区 | Host profile 下 `host-v0/state.sqlite3`，实现见 [storage](../crates/host/src/storage/)                                      |
| 客户端窗口偏好、图库引用和草稿          | Native `appConfigDir/client-state-v0.json`，按窗口保存，见 [client_state.rs](../src-tauri/src/client_state.rs)              |
| 桌面路由与窗口恢复元数据                | Native `appConfigDir/workspace.json` 及窗口插件管理的几何状态，见 [system_commands.rs](../src-tauri/src/system_commands.rs) |
| 更新镜像或禁用策略                      | `appConfigDir/deployment.json`；公钥仍固定在安装包内                                                                        |
| 原始录制和导出                          | 明确选择或登记的目标，由 Host 管理引用、内容 revision 和实际写入结果                                                        |
| 浏览器预览                              | 共享预览偏好用 localStorage；窗口 ClientState 用 sessionStorage，见 [client-settings.ts](../src/lib/client-settings.ts)     |

共享设置与工作区使用 revision CAS。保存只确认相应提交，冲突重读且保留草稿；窗口的日常标签调整不立即写入共享模板，显式保存才更新模板，其他窗口的运行布局独立。

工作区已保存的视图、连接预设不等于窗口当前草稿或实际打开的设备。加载工作区不连接、不发送；优先关联已确认的设备身份和 session epoch，匹配歧义时显式选择。已确认快照与后续输入分开。草稿按窗口、工作区和视图区分，切页不重复恢复；未保存工作统一参与离开/退出协商。日常操作见[工作区操作](./development.md#工作区操作)。

## 生命周期与资源责任

- **设备与操作**　Host 持有逻辑会话、租约、TX 仲裁和关闭责任。系统串口句柄归 Rust，插件传输后端可持有自己的句柄。独占工具接管系统串口时，先冻结新写入、结算在途事务并关闭旧句柄，交还时重新核对设备身份。持久接纳、实际派发和最终回执分别记录。窗口关闭或停止等待后仍须结算 I/O，partial/unknown 保留已知范围且不自动重发。见[流与操作](./contracts/stream-and-operations-v0.md)。
- **Raw 与录制：** 源环、各 reader、录制和 UI 显示有独立游标与预算。慢读者产生明确缺口，不能阻塞采集；窗口隐藏或查看历史不冻结 Host。保留未 ACK 批次的预算，实际完成写入或退出才释放。录制按[容器契约](./contracts/capture-container-v0.md)保存验证前缀，回放不创建设备或发字节。
- **录制授权：** Host 的录制 reader 绑定源会话的 `content.read` 和目标文件的 `workspace.modify`，监控这两项实际生效规则及期限。追加目标文件的读取权时，录制仍由原权限继续。批次入队与撤权共享授权锁，磁盘写入在锁外完成。撤销或替换任一绑定规则后，停止接纳新批次并失败结算，已合法入队的数据可完成落盘并供验证与恢复。撤销后重新授权只对新录制生效。客户端 Raw 批次沿用创建时的身份授权代次。
- **授权与晚结果：** admission、dispatch、存储提交和最终交付分别复核当前授权。派生结果保留源权限，撤权后不能从历史结果或文件引用绕过；订阅只接纳当前身份和代次的帧。窗口级设置效果、媒体票据、读者和计时器随所属代次退休。
- **文件与恢复：** Host 登记用户明确选择的位置或固定内容引用，前端不提交任意路径。窗口图库持有引用而非原文件；共享背景选择、窗口元数据分别持久化。写入保持原子、revision 冲突及未来格式保护。[ClientState 恢复](../src-tauri/src/recovery.rs)只在明确重启时归档原件并安装候选，不重置 Host 数据库或删除用户文件。

## 可信 Node 扩展

| 改动入口                                                                                               | 由谁保证什么                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [安装与管理](../crates/host/src/node_packages/)                                                        | 安装只验证、暂存及原子提交，不执行代码。来源信任、执行确认和业务授权分开。升级/卸载在旧代实际退出后提交，CAS 或授权失败保留原件及证据。                               |
| [恢复监督](../crates/host/src/node_packages/recovery.rs)与[进程启动](../crates/host/src/node_runtime/) | Host 持有内容证明、进程和管道；真实退出再归还名额。恢复只重登记贡献，重新核对原主体、来源和授权，不重放旧业务。macOS 先核验暂停的映像，再恢复运行；监护进程也须收回。 |
| [后台](../crates/host/src/node_backend/)与[动作](../crates/host/src/node_actions/)                     | 只发布实际登记的声明子集。Host 离线校验输入/输出；schema 编译与缓存受进程预算约束。长计算进 worker，任务完成须处理其 worker、子接纳和回执，不能随 handler 提前返回。  |
| [子调用](../crates/host/src/task_children.rs)与[查询](../crates/host/src/node_queries/)                | 子调用继承根身份，权限取当前调用者、插件声明与父资源范围的交集；持久去重，既有子项按真实结果结算。查询不创建 Operation，结果按源权限再验。                            |

执行信任允许 Node 代码以当前 OS 用户的权限访问文件、网络和进程。Host API 授权只约束经 Host 提交的调用。worker 和进程监督负责停止、回收及故障报告。插件退出时，Rust 自持串口的采集与录制继续；若故障来自承载数据源的插件后端，须记录会话故障和已知缺口，无法确定的丢失量保留为未知。见[扩展契约](./contracts/node-extension-v0.md)与[验证基线](./plan.md#验证基线)。

任务内读取原始流时沿用 Host 的留存窗口、事件和 reader 内存预算。Node 私有管道用长度头区分 Raw 和控制，分别保留收发名额，writer 在帧之间优先处理控制。已开始写入的 Raw 帧有固定大小上限。Raw 页的内存租约随 writer 保留，发送前复核任务与授权。验收检查慢消费者、取消与撤权时队列和工作归属。

原生 Node 管道的控制、Raw 和派生队列保留各自的容量。成功入队会唤醒 writer，控制帧仍优先，Raw 与派生帧仍交替。业务请求、入站帧及异步 Raw 或派生结果就绪时唤醒 owner。Unix 读写等待管道就绪，每轮在原有间隔内重查停止信号，保留非阻塞回收边界。用真实派生发布、Raw 录制、撤权和进程退出核对吞吐与生命周期。

派生输出由 Host 按生产 Operation 和精确会话代次留存。Node 发布在独立队列接纳，Host 对照留存原始事件核验来源，以实际处理器和规范化配置生成追溯信息。读取方使用各自页游标并复核源内容权限，留存范围不足时明确报告游标过期。派生缓冲和读页预算与原始流、录制分立。验收覆盖派生积压期间的 Raw、控制与录制，以及撤权、旧代次和过期读取。

派生留存峰值由持有样本的 Host 留存层记录，读页峰值来自实际输出租约。通过现有 `host.metrics` 查询两个预算，无需启动采样任务。进程 RSS 仍从操作系统或实际 Node 进程采集。

桌面插件管理复用 Host 的安装、来源和运行快照。明确的本机管理操作使用封闭的原生意图类型，来源及执行信任写入使用独立的用户控制连接。安装、启停和卸载沿用桌面业务身份，显式管理意图按需取得 Host 目标的 `plugins.manage`，安装包的读取权限仍由文件选择入口按对象授予。界面通过业务连接观察 Operation，按当前摘要与 revision 写入，离页仅停止观察。验收须分别核对普通身份无法确认执行信任、显式本机意图提交成功及实时运行状态。

桌面安装列表使用 Host 从清单生成的名称、版本和安装状态，展开后显示来源和可用操作。来源签名的显示同时对照安装收据和当前来源信任。确认执行时使用经摘要校验的清单，显示所请求能力和本机执行风险，确认后仍需显式启用。界面用本地化的提示反馈失败。Host 请求、回执与验收证据继续记录用于复核的摘要和操作标识。

## 安全与恢复

本机 IPC 保护当前用户的实例，不抵御同账户恶意进程。普通客户端默认只读元数据；授权、执行确认等用户控制走专用入口。同一同步阶段可共享授权快照，不能跨异步等待沿用。文件、目录订阅、媒体分段和最终 writer 都检查实际目标及当前来源权限。CSP、Tauri capabilities、路径验证与资源预算各守自己的边界，见[安全规范](./conventions.md#安全)。

插件视图资源由 Host 通过成功的打开操作交付。打开回执固定业务目标及插件运行代次。资源读取使用实际登记的视图、验证过的归档资源索引及当前授权，重新启用后须重新打开视图。资源分段读设独立并发上限。桌面使用独立 Wry WebView 承载可信壳，包内容在另一来源的 sandbox iframe 中运行。可信壳核对 iframe 实例与打开时的一次性标识，通过专用端口交付快照和原始流。包内容只能确认当前批次，原生请求上下文留在桌面桥内。

每个终端视图有独立的 Raw 连接、cursor 和 credit。原生窗口先在隐藏状态初始化渲染器，显示前再核对发起文档和 Host 连接代次。显示与连接移除使用同一桌面桥锁，渲染器初始化在锁外完成。若其间代次失效或调用取消，销毁隐藏窗口并回收视图资源。原生层在向壳交付数据前复核视图代次与目标授权，包内容确认批次后继续交付。失去授权、iframe 重载、发起视图的桌面文档被替换或关闭窗口时回收对应资源。Host 持续持有会话和独立录制。重开从当前留存窗口恢复，游标已过期时报告缺口。测试入口与三平台原生窗口的待验项见[终端参考包验收](./testing.md#终端参考包验收)。

签名终端的自动化桌面验收使用独立 profile。测试构建在专用场景中提供已校验 ZIP 与新录制路径，随后沿用正式的文件登记、授权和录制流程。原生桥只记录测试窗口生命周期与已确认的流位置。真实文件对话框和窗口焦点保留独立的前台验收。

桌面桥把当前 Host 的目录变更转发到所属窗口，通知只携带桌面连接代次。窗口用当前 Host 身份重读目录和动作权限，分页固定目录版本，忽略被更新通知取代的读结果。重新启用插件时在同一窗口恢复目录入口。

派生视图使用发起窗口的 Raw 请求通道，每个视图持有独立读页位置。Host 查询绑定打开视图的采样 Operation 及会话代次。桌面桥在读页前和交付前复核视图授权，可信壳等当前页确认后再拉取。图表从留存样本恢复，遇到缺口时断开曲线。

## 更新与分发

应用、协议、目录和数据格式分别版本化。Rust updater 验证下载，在安装前协调各窗口和在途工作。公钥编译入安装包，可写部署配置仅能更换受控 HTTPS 镜像或禁用更新。桌面、Host、CLI、MCP 与固定 runtime 按同一发行版本交付；组件绑定、签名与启用条件见[分发契约](./contracts/runtime-distribution.md)及[构建与发布](./development.md#构建与发布)。

## 关键取舍

独立 Host 换取多客户端共享持口和无头任务，代价是实例身份、权限与整套升级必须协调。Tauri 复用 Web 界面但把系统提交留给 Rust，故浏览器测试不能替代 Native。可信 Node 让内置和市场插件共享作者接口，代价是必须把代码执行信任与设备 API 授权分开；页面不是后台的生命周期所有者。

## 系统串口与 PTY 能力

系统串口由独立 Host 的设备目录提供。目录返回不透明 `deviceId`；打开操作解析当前目录与绑定后，才把受信的系统定位符交给原生提供器。COM 编号、tty 路径和枚举顺序都不是稳定设备身份。目录刷新、stale 与重连规则由设备服务维护，平台提供器只读取 OS 事实。

设备目录每次只执行一轮枚举。`device.refresh` 等待调用开始后启动的枚举完成，多次请求可共用随后的一轮。关停唤醒等待者并返回 `HOST_CLOSING`。

### 配置与读回

产品保留 5/6/7/8 数据位、五种 parity、三种 stop width 和四种流控。平台不能表达的组合返回 `UNSUPPORTED_CAPABILITY`；驱动修改了请求值时，配置回执保留实际读回，TX 门控保持关闭。打开时只有全部字段确认一致才返回成功。

| 配置              | Windows                           | Linux                                   | macOS                                          |
| ----------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| 5/6/7/8 数据位    | DCB，随后 GetCommState            | termios2，随后 TCGETS2                  | termios，随后 tcgetattr                        |
| none/even/odd     | 支持编码与独立读回                | 支持编码与独立读回                      | 支持编码与独立读回                             |
| mark/space        | DCB MARKPARITY/SPACEPARITY        | CMSPAR，依驱动读回                      | 通用 termios 无对应表达，明确拒绝              |
| 1.5 stop          | 仅 5 数据位组合；6/7/8 明确拒绝   | 通用接口无法与 two 准确区分，明确拒绝   | 通用接口无对应表达，明确拒绝                   |
| 2 stop + 5 数据位 | 明确拒绝                          | 明确拒绝物理宽度歧义                    | 明确拒绝物理宽度歧义                           |
| RTS/CTS           | CTS 输出门控与 RTS handshake      | CRTSCTS                                 | CRTSCTS                                        |
| DSR/DTR           | DSR 输出门控与 DTR handshake      | 通用 termios 无双向 handshake，明确拒绝 | CDTR_IFLOW 与 CDSR_OFLOW，依驱动读回           |
| XON/XOFF          | 双向软件流控                      | IXON 与 IXOFF                           | IXON 与 IXOFF                                  |
| 任意 baud         | DCB 的 u32 范围，依驱动接受与读回 | termios2/BOTHER 的 u32 范围             | termios 或 IOSSIOSPEED；无法独立读回时拒绝确认 |

读写等待和重连间隔是 Host 策略字段，由 Host 保存；它们不伪装成硬件寄存器读回。数据通路关闭 echo、换行转换、strip、NUL 丢弃和字符替换。RTS/CTS 模式占用 RTS，DSR/DTR 模式占用 DTR；手动改变已被流控占用的线返回 `CONTROL_CONFLICT`。

### 原生资源与排空

打开、读写、取消与 close 的责任归原生 owner；等待超时不能提前释放句柄或复用端口。驱动 drain 与最后停止位、USB FIFO 和物理线空闲不是同一事实。自动 TX 时限据最终字节和线路参数估算，流控暂停仍可能超时；历史 TX unknown 不改写，只有实际控制线已清除、原生清理成功、线程已回收才释放关停责任。

### 控制与诊断

- Windows 使用 SetupAPI 枚举 present Ports，读取受控 PortName、说明、厂商、硬件标识、拓扑及驱动信息；Linux 读取 sysfs tty 与 USB 祖先属性；macOS 使用 IOKit IOSerialBSDClient 与 USB 注册表属性。
- 序列号缺失不补默认值。Windows 不把任意实例 ID 的末段当序列号；目录还会检查候选唯一性和拓扑变化。
- DTR/RTS、BREAK、purge、队列采样与 CTS/DSR/RI/CD 输入采样通过平台 API。输出调用成功表示驱动接受了请求；物理电平与对端收到 BREAK 需要硬件验证。
- purge 无法对应逻辑流偏移时报告未知丢弃范围，不编造字节偏移。Windows 接收溢出会产生明确错误；Unix 的普通 tty 接口没有统一的溢出计数，持续无损能力需结合实际驱动验证。
- 原生错误保留稳定 code 与 `details.osCode`，不把任意路径或推测的占用进程写入错误文本。

平台行为按目标 OS 的 `serial_backend` 和 `pty_roundtrip` 验证；PTY 不证明真实适配器速率、CTS/XOFF 阻塞或 BREAK 电平。硬件范围见[平台目标](./requirements.md#平台目标)。

实现依据：[Windows DCB](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb)、[Windows COMMTIMEOUTS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-commtimeouts)、[Windows CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex)、[Linux termios](https://man7.org/linux/man-pages/man3/termios.3.html)、[Linux termios2](https://man7.org/linux/man-pages/man2/TCGETS2.2const.html)、[Apple 串口访问](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/WorkingWSerial/WWSerial_SerialDevs/SerialDevices.html)、[Darwin termios 声明](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/termios.h)、[IOSSIOSPEED 声明](https://raw.githubusercontent.com/apple-oss-distributions/IOSerialFamily/main/IOSerialFamily.kmodproj/ioss.h)。
