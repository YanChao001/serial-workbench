# 产品架构

本文描述当前源码结构。预期功能见[需求](./requirements.md)，实现与验收缺口见[进度](./progress.md)；Node、浏览器连接与 LAN 的后续设计见[规划](./plan.md)和[契约](./contracts/README.md)。

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
| `e2e/`                       | 浏览器与真实桌面测试源码；运行产物另存 artifacts              |

根 [Cargo.toml](../Cargo.toml) 管理全部 Rust 包和共享 profile，使用唯一的根 Cargo.lock。无头包能够独立构建和测试；`src-tauri/target/` 是配置的共享编译输出位置。

## 客户端入口

前端由 `main.tsx`、`App.tsx` 组装 Provider、HashRouter 和边界。路由、懒加载、预载、导航位置与布局统一在 [routes.tsx](../src/routes.tsx)，菜单、命令面板和快捷键复用 `src/commands/`。

首页为串口工作台，设置承载偏好、诊断与恢复，启动故障保留受保护的隔离入口。工作台顶部连接、中央接收、底部常显发送，参数和辅助工具就近展开；布局及无障碍约束见[界面规范](./conventions.md#界面)。

手写 TypeScript 通过 [tauri.ts](../src/lib/tauri.ts) 使用原生能力。门面检查运行环境；浏览器提供独立存储的界面预览。浏览器 fixture 只服务测试，不进入生产状态回退。Native 命令及 Host DTO 分别生成绑定，流程见[开发指南](./development.md#契约与功能接线)。

已认证连接与工作区元数据初始化分别管理。首次或后续查询失败在工作区保留错误和重试入口，连接继续供设置等独立订阅使用；Host 启动失败、认证失效或实例代次变化才退休连接。重试查询不重新授权或重放修改操作，见 [HostProvider](../src/providers/host.tsx) 和[工作区控制器](../src/providers/host-controller.ts)。

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

录制清单与索引先写同目录候选并同步，再原子替换。Windows 使用标准库包含 FileRenameInfoEx 回退的替换路径，允许仍在读取旧件的合法共享读者；同一候选文件句柄保留到更名后再次同步。只读或禁止删除共享的目标仍明确失败；替换失败保留原件和候选，替换后的同步失败保留实际文件并返回错误，不伪造回滚。目录归档和新件发布继续禁止覆盖，见[录制契约](./contracts/capture-container-v0.md)。

ClientState 的偏好、草稿和图库共用窗口 revision。偏好保存遇到其他切片更新时，最多尝试三次并保留最新非偏好数据；若偏好本身已被修改，保留本地输入并要求明确重试，不自动覆盖并发偏好。

设置保存状态同时等待当前连接、已提交 revision 和本次重试对应的原生效果调用完成。磁盘提交成功但原调用仍在途时保持 saving，真实回执通过身份/revision 核验后才完成；旧连接晚结果不能结算新连接。效果失败保留错误与明确重试，不自动重放修改操作。

工作区及工具草稿的 scope 身份使用 [scope 键](../src/lib/host-scope.ts)按 scopeId 与 Target 固定字段生成，不依赖 JSON 对象字段顺序；查询、投影及原生命令可采用不同序列化顺序。Host attachment/epoch/generation 仍单独隔离，revision 更新不冒充目标切换。

图库保存 ObjectRef 与名称，当前背景属于共享设置；移除图库条目只移除元数据。媒体内容经受控协议读取，临时 URL 不进入共享文档。内置壁纸及 SVG 皮肤由资源清单维护，见 [wallpapers](../resources/wallpapers/README.md) 和 [skins](../resources/skins/README.md)。

旧软件 API、数据和插件格式不读取迁入。旧 `settings.json` 原件保留；当前共享偏好权威为 Host，Native 恢复对象为 ClientState。

## 生命周期与资源责任

- Host、客户端、会话、视图和 Operation 各有身份与代次。切换 Host/目标、撤权或卸载后隔离旧结果；订阅处理 StrictMode、晚到完成和清理。
- 未保存工作由 `useUnsavedWork` 登记。离页、关闭、退出和安装更新复用协商；保存失败或用户取消时保留工作。
- 调用接纳与执行完成分别处理。停止等待不回滚已发生 I/O；按 Operation 终态和实际回执确认，避免自动重放未知发送。
- Native 普通 RPC、状态/Raw 订阅和设置副作用只使用现有窗口 instance/generation；连接退休后返回代次错误，不隐式重附着或启动 Host。明确的 `host_attachment` 入口负责建立新连接，旧调用及晚结果继续隔离。
- 恢复和回放操作的可信来源由服务解析，与 queued Operation 在同一数据库事务持久化，提交后才发布接纳。来源写入失败整笔拒绝；执行前仍复核当前权限和来源，历史查询仍按当前源权限授权。
- Raw reader、源历史、capture、媒体响应和原生工作都有有界名额及字节预算。慢消费者产生明确 Gap 或停止结果；任务实际结束才归还其持有的预算。
- 窗口的正常订阅终态计入普通交付预算，普通容量耗尽才借唯一应急终态槽，未 ACK 前不释放。授权代次变化结束旧订阅；客户端用新查询重新验权并建立新 reader，恢复查询与订阅共用三次预算，持续拒绝后停止。Raw 接续保留最后已处理游标，历史不足明确报错，旧队列及晚结果不重新投递。
- 普通只读查询在同一连接最多尝试三次以处理授权代次变化，每次重新验权，不重新授权或附着，也不重放 invoke；已接纳操作只重读同一 operationId。Native 内部的设置效果读取与连接设备后的操作/会话读取使用独立白名单，仅重复 `settings.read`、`OperationGet(operation.get)` 和 `session.get`；仅 Host 的 `PERMISSION_DENIED` 回复触发重读，重读使用新 requestId，连接代次变化及其他错误立即返回。平台效果、设备打开和明确授权均在读取循环外；控制通道、媒体和订阅不叠加该预算。状态 reader 使用 SDK 内部查询和自身恢复预算；游标与授权恢复都在快照和订阅完整建立后归零，连续 setup 拒绝仍有界停止。取消等待后仍观察已开始 Promise 的迟拒绝，底层任务保留实际清理责任。
- Native 状态/Raw 早帧只归属仍在建立的订阅 requestId；成功、拒绝或取消后释放其暂存，已退休订阅的晚帧直接丢弃。各建立队列仍限制 256 帧/4MiB；有效建立请求溢出仍关闭相应连接，不以扩大预算掩盖残帧积累。
- Host IPC 按实际成功写入字节区分失效边界。尚无字节的旧事件丢弃、未投递客户端动作以 Failed 结算且不伪造平台回执、敏感回复改为失败；已写部分帧则关闭物理连接，防止新授权沿用旧正文，未确认的平台效果保留 Unknown。写入预算仍为 5 秒。
- 会话 owner 管理唯一持口、发送门控、配置与重连。关闭视图不会伪造设备停止；未完成原生线程继续承担句柄、缓冲区与清理责任。

## 安全与恢复

应用以当前 OS 用户运行，本机隔离不抵御同账户恶意进程。普通 Host 客户端默认只有元数据权限；授权和撤权由明确的本地用户控制入口完成。操作、查询、订阅、派生结果和文件读取都复核当前来源权限。

文件选择将实际目标登记为受控 ObjectRef，普通前端请求不能通过任意路径扩大权限。固定引用绑定内容 revision，内容变化拒绝沿用。Native 媒体票据绑定窗口与连接代次，每段读取仍由 Host 验权。

并发明确保存可能使媒体解析中的授权快照失效。媒体只在同一 Port/Native generation 对 `PERMISSION_DENIED` 最多额外重新解析三次，每次重新读取和验权，不重新选择文件或授予权限；持续撤权、旧代次及取消仍失败，晚到票据按原生命周期释放。

[recovery.rs](../src-tauri/src/recovery.rs) 处理 ClientState：确认后暂存候选，明确重启时复核格式，将原件归档到 `client-recovery-archive-{token}/` 后安装；失败保留或恢复原件、journal 与错误证据。未来格式在准备和重启阶段都拒绝覆盖，Host 文档损坏或未来格式也阻止写入。

恢复候选是默认 ClientState 文档，会重建其中的窗口偏好、草稿和图库元数据；原 ClientState 随归档保留。它不重置 Host 共享设置或工作区，也不删除图库指向的用户文件，不能用来修复 Host 数据库。

CSP、Tauri capabilities、路径校验、预算和内容校验分别约束对应边界；密钥、输入和日志规则见[安全约束](./conventions.md#安全)。

## 更新与分发

应用版本、协议版本、目录版本和文件格式分别管理。Rust updater 管理检查、下载验签与安装；安装前协商所有窗口及在途工作。更新公钥编译进安装包，deployment 配置仅能更换受控 HTTPS 镜像或禁用更新。

当前发布模板、签名和更新端点尚未启用。组件构建需要同源的桌面、Host、CLI、MCP 和有效收据；后续 Node/runtime 也作为整套发行组件升级，先结算任务再切换，见[构建与发布](./development.md#构建与发布)。

## 关键取舍

- **独立 Host：** 让多个客户端共享唯一设备所有者，录制和长任务独立于窗口；代价是实例管理、身份和整套组件发布的协调。
- **Tauri 桌面：** 复用 Web 界面与系统 WebView，系统能力由 Rust 提交边界控制；浏览器预览与原生验收分别验证。
- **可信 Node 扩展：** 后续统一 SDK、后台和隔离 Web UI；Node 具有 OS 用户权限，代码执行信任与设备 API 授权分别建立，重计算交给受监督 worker。
- **图库与选择分离：** 元数据、共享背景选择和用户原文件各有归属，避免窗口设置副本成为内容权威。
- **安装包固定更新公钥：** 可写部署配置不能替换信任根；换钥需要可信过渡版本或手动安装。
- **线性里程碑交付：** 同一切片的实现、测试、审阅修正和文档集中，经 PR squash 合入；Git 规则见[协作](./conventions.md#协作)。

## 系统串口与 PTY 能力

系统串口由独立 Host 的设备目录提供。目录返回不透明 `deviceId`；打开操作解析当前目录与绑定后，才把受信的系统定位符交给原生提供器。COM 编号、tty 路径和枚举顺序都不是稳定设备身份。目录刷新、stale 与重连规则由设备服务维护，平台提供器只读取 OS 事实。

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

每个端口只独占打开一次。专有原生读取线程与单个 TX 或 drain 任务共享同一份受控句柄引用；会话所有者在写入和 drain 待完成期间继续 RX，不允许新的 TX、配置或有副作用控制穿插。写回执分别记录已经确认的接纳前缀、当前在途未知区间和未提交的尾部；取消不会把已提交的字节改写为零副作用。

写入载荷同时保有字节与原分配的预算租约。业务已返回 unknown、源历史已被回收时，未完成的原生任务仍承担这笔预算；实际完成后才释放。Windows overlapped 写入借用这份载荷，不额外复制整块缓冲区。

Windows 使用 FlushFileBuffers，Unix 使用 tcdrain。只有原生调用成功结束才产生 confirmed；驱动队列计数为零、等待一段时间或请求取消都不能生成确认。Windows 通过 CancelSynchronousIo 请求中断 drain；Unix 尝试安装专用 SIGUSR2 空 handler 并定向中断，不覆盖进程已有的该信号处理器。不能安装 handler 或驱动不响应时，等待仍然有界，结果保留 unknown。

取消收尾预算为 100 ms。超过预算后原生线程继续持有句柄、缓冲区和清理责任；会话进入 `ControlUnknown`，同设备保留隔离，晚到成功不会自动恢复 TX 或允许重开。活跃与隔离串口合计最多 16 项。会话 close 使用独立关闭信号，在同一 250 ms 总预算内等待后端结果与 owner 线程真实退出并回收 join；`completed` 或 Closed 快照不能单独证明线程已结束，重复 close 与 shutdown 也不绕过此结算。超时保留 JoinHandle 与隔离责任，业务邮箱满不会丢失关闭，Drop 不等待未完成线程。

领域 write/drain 期限使用 Host 的注入单调时钟；到期通过独立原生取消信号请求收尾，错误仍保留 `WRITE_TIMEOUT`，不会改成用户主动取消。owner 的备用收尾预算是实际时间 150 ms，不依赖领域时钟继续推进。

原生 close 也在持有资源的原生线程执行。实际进程或 OS 锁尚未消失时，停止流程仍需按真实状态报告；线程分离不产生“设备已停止”证明。

### 控制与诊断

- Windows 使用 SetupAPI 枚举 present Ports，读取受控 PortName、说明、厂商、硬件标识、拓扑及驱动信息；Linux 读取 sysfs tty 与 USB 祖先属性；macOS 使用 IOKit IOSerialBSDClient 与 USB 注册表属性。
- 序列号缺失不补默认值。Windows 不把任意实例 ID 的末段当序列号；目录还会检查候选唯一性和拓扑变化。
- DTR/RTS、BREAK、purge、队列采样与 CTS/DSR/RI/CD 输入采样通过平台 API。输出调用成功表示驱动接受了请求；物理电平与对端收到 BREAK 需要硬件验证。
- purge 无法对应逻辑流偏移时报告未知丢弃范围，不编造字节偏移。Windows 接收溢出会产生明确错误；Unix 的普通 tty 接口没有统一的溢出计数，持续无损能力需结合实际驱动验证。
- 原生错误保留稳定 code 与 `details.osCode`，不把任意路径或推测的占用进程写入错误文本。

### 验证分层

`cargo test --locked -p serial-workbench-host --lib device::serial` 验证参数编码、读回与可控原生调用的资源生命周期；`--lib device::sessions::mailbox_tests` 验证真实 owner 的 RX、邮箱和有限关闭。

`cargo test --locked -p serial-workbench-host --test serial_backend --test pty_roundtrip` 在目标 OS 运行提供器与 PTY 测试。PTY 对端是独立进程，验证任意分块、字节摘要、RX purge、实际 drain 调用和断连。Windows 上被 cfg 排除的 PTY 用例不计为通过。Linux PTY 的 tcdrain 可能立即返回，因此这一结果不证明成功中断过阻塞 drain。

M6 硬件检查保留 CTS/XOFF 阻塞、实际速率、最后停止位、USB FIFO、输入边沿、线电平与 BREAK 接收。记录 OS、内核、驱动、芯片、接线和时间基准；本机软件用例不替代这些证据。

实现依据：[Windows DCB](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb)、[Windows COMMTIMEOUTS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-commtimeouts)、[Windows CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex)、[Linux termios](https://man7.org/linux/man-pages/man3/termios.3.html)、[Linux termios2](https://man7.org/linux/man-pages/man2/TCGETS2.2const.html)、[Apple 串口访问](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/WorkingWSerial/WWSerial_SerialDevs/SerialDevices.html)、[Darwin termios 声明](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/termios.h)、[IOSSIOSPEED 声明](https://raw.githubusercontent.com/apple-oss-distributions/IOSerialFamily/main/IOSerialFamily.kmodproj/ioss.h)。
