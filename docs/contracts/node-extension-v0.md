# Node 扩展合同 v0

- 状态：v0 合同；M2 Task14.1 已开始实现 Rust 元数据 DTO 与生成 schema，正式离线加载、后台和 Web UI SDK 仍在 M2 实现，M3 参考场景通过后冻结 v1。
- 依据：[架构取舍](../architecture.md#关键取舍)与[产品需求](../requirements.md)。
- 分发运行时的精确版本、四目标来源、完整性与固定启动位置只在 [runtime 分发基线](./runtime-distribution.md) 维护。

本合同定义可信 Node 插件的正式包、后台、Web UI 与授权边界。

## 1. 协议与类型来源

所有 wire 字段使用 camelCase，Host `protocolVersion` 为字符串 `"0.1"`。v0 精确协商，不推断次版本相容；M3 冻结 v1 时另行规定支持范围。所有 u64 计数、revision、epoch、seq、offset、duration 使用无符号十进制字符串，禁止经过 JavaScript number 中转。包版本、manifest schema、Host 协议与私有数据 schema 分别版本化。

共享 Call、Query、身份、权限、目录、Snapshot、cursor、增量与 ObjectRef 由 [Host 合同](./host-v0.md) 维护，Operation、原始/派生流与资源结算由 [流与操作合同](./stream-and-operations-v0.md) 维护。Node SDK 与 Web UI 桥使用同一份生成类型与运行时校验。M1 Rust DTO 成为类型/schema 权威；M2 manifest 与动态贡献 DTO 一并纳入该生成链，禁止在 SDK 手写另一套 wire 协议。

外部 actorId 不能自授权；revealTarget 必须定位到目录登记的位置，resultRef 使用 ObjectRef。partial 是领域结果，不是 Operation 状态。停止等待、发出取消请求与副作用已停止分别记录。

## 2. 正式包与 manifest

正式包是不可变版本目录的离线 ZIP 归档，包含 `manifest.json`、构建后的后台 JS、可选 UI 的 HTML/CSS/JS、锁定依赖及许可、完整性清单和来源收据。安装只验证、解包、提交安装记录，不执行代码、npm install、install/postinstall 或任何依赖构建钩子。依赖由发布方预构建并打入包；目标机器无需 Node/npm 或联网补依赖。

以下为 v0 manifest 字段。M2 加载器及打包器必须从同一 Rust DTO 导出 schema，并提供成功与拒绝 fixture；v0 拒绝未知字段、重复键、缺失引用、重复贡献 ID、绝对路径、父目录跳转、链接/重解析点及大小写冲突的包路径。

| 字段                         | 类型与约束                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`              | 必需，精确字符串 `"0.1"`。                                                                                                                                                          |
| `id`                         | 必需，稳定的发布者命名空间与包名；升级保持相同 ID，ID 自述不证明发布者身份。                                                                                                        |
| `version`                    | 必需，发布包版本；安装同 ID 的升级必须高于当前版本，不借版本号建立信任。                                                                                                            |
| `displayName`、`description` | 必需的显示文本，不参与授权。                                                                                                                                                        |
| `license`、`notices`         | 必需，许可标识及包内许可/第三方声明路径列表。                                                                                                                                       |
| `hostProtocolVersion`        | 必需，精确 `"0.1"`；握手不匹配时安装可保留但不能激活。                                                                                                                              |
| `runtimeRef`                 | 必需，引用应用发行组件清单中的 runtime 身份；精确版本与 ABI 约束按 runtime 分发基线校验。                                                                                           |
| `main`                       | 必需，包内预构建 ESM JavaScript 后台入口，导出 `register`。                                                                                                                         |
| `webUi`                      | 可选，`{entry}`，指向包内 HTML；其所有执行资源随包提供。                                                                                                                            |
| `dependencies`               | 必需数组，逐项 `{name,version,path,license}`，只允许包内已经解析并锁定的依赖，不允许浮动标签、URL 拉取或宿主 npm 全局解析。无依赖时为空。                                           |
| `platformResources`          | 必需数组，逐项 `{id,target,path,kind,version,runtimeRef?}`；`kind` 为 `nativeAddon\|tool\|data`，target 使用发行基线目标标识。native addon 必须锁定 runtime/ABI，工具锁定实际版本。 |
| `activation`                 | 必需数组，元素为 `startup` 或声明的贡献 ID；只在启用且信任有效时触发，多个请求合并为同一激活。                                                                                      |
| `permissions`                | 必需，声明 Host API 权限/目标 scope、代码执行用途及外部工具需求；调用时仍复核当前授权，声明本身不授予权限。                                                                         |
| `contributes`                | 必需，包含 `actions`、`queries`、`transports`、`parsers`、`views`、`themes`、`configuration` 数组；未提供的类别为空。                                                               |
| `dataSchemaVersion`          | 必需，插件私有持久状态版本；安装包与数据分目录，拒绝向较新格式写入。                                                                                                                |

每项业务贡献引用 [公共目录项](./host-v0.md) 的 `actionId,kind,inputSchema,outputSchema,targetKinds,executionLocation,permissions,stateScopes,eventTypes,cancellation,revealTarget`，不另起字段名。动作、查询、设置、视图背后的业务、插件管理和工作区操作同时向 GUI/CLI/MCP 开放。纯主题资源声明资源 schema 与配置入口；视图引用动作和状态，不建立 UI-only 业务。动态注册的内容须是已校验 manifest 中声明的子集，不得扩大权限。

Rust 来源为 [`node_package.rs`](../../crates/core/src/node_package.rs)。包 ID 使用至少两段点分命名空间，每段仅 ASCII 字母、数字、`_`、`-`，总长不超过 128 字节。贡献 ID 使用 `<包 ID>.` 前缀且后缀非空，全部类别之间不得重复；不能覆盖内置目录 ID。包和锁定依赖的版本采用完整 SemVer，升级比较忽略 build metadata；相同 precedence 的构建标识变化不构成升级。`dataSchemaVersion` 独立使用非空字符串。

嵌套声明采用以下结构，所有列出的数组均必需，无条目时为空；可选字段只能省略，不能写 `null`：

| 声明                                                           | v0 形状与绑定                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permissions`                                                  | `{hostApi:[{permissions:string[],targetKinds:ResourceKind[]}],executionPurposes:string[],externalTools:Id[]}`。目标 scope 不得为空，执行用途必须有非空声明；工具 ID 必须引用 `platformResources` 中的 `tool`。声明不授予执行信任或 API 权限。    |
| `contributes.actions/queries/transports/parsers/configuration` | `ActionSpec[]`。actions、transports、parsers 的 `kind` 为 `action`，queries 为 `query`；configuration 可分别声明读与写。                                                                                                                         |
| `contributes.views`                                            | `{id,actionId,stateScopes:string[]}[]`。必须有 `webUi`，引用本包声明的 action，stateScopes 是该 action 声明的子集。                                                                                                                              |
| `contributes.themes`                                           | `{id,path,resourceSchema,configurationActionId}[]`。path 引用包内载荷，resourceSchema 使用公共 schema 对象，配置入口必须在 configuration 中声明。                                                                                                |
| 动态登记                                                       | `{id,version,contributes:{actions:Id[],queries:Id[],transports:Id[],parsers:Id[],views:Id[],themes:Id[],configuration:Id[]}}`。身份精确匹配 manifest，各类别只选择原声明中不重复的 ID；目录与权限元数据仍读取已验证的 manifest，不接受后台替换。 |

`NodePackagePath` 只接受规范的 POSIX 相对路径，保留 Unicode，拒绝空组件、`.`、`..`、反斜杠、冒号及控制字符。Core 的 JSON 原始字节入口在构造对象前拒绝任意层级的重复键；生成 schema 用于已解析值的结构校验，重复键及跨字段/跨文件引用仍由 Host 调用 Core 语义校验。文件系统大小写别名、链接/重解析点、归档条目与字节预算必须由 Host 安装边界另行验证，不能仅凭 schema 判为可安装。

包内 native addon、外部工具及其动态库按目标分包；目标缺少资源、ABI 不匹配或依赖不完整时，在执行前返回结构化不可用原因，不尝试在线编译。运行时只从应用发行目录的固定路径启动；PATH、用户 Node、NODE_OPTIONS 与插件提供的启动参数不能替换 Host 所选 runtime。

### 完整性与来源

完整性清单覆盖 manifest、JS、依赖、UI、平台资源与许可的规范相对路径、字节长度及 SHA-256。目录不得包含未列出的可执行资源；验证后的文件在不可变版本目录使用，激活前复核安装记录与内容身份。解包到暂存目录，完成校验后以 revision 条件原子提交；失败保留已安装版本及诊断证据。

`integrity.json` 使用 `{schemaVersion,id,version,source,keyId,files}`，schemaVersion 为 `"0.1"`；files 按路径字节序排列，每项 `{path,size,sha256}`，size 为 U64，包含 manifest 与全部载荷，不包含 integrity.json 和 signature.json 本身。签名覆盖 ASCII 前缀 `serial-workbench-node-package-v0\n` 与 integrity.json 原始 UTF-8 字节的拼接。`signature.json` 为 `{algorithm:"Ed25519",keyId,signatureBase64}`；密钥必须从安装来源已认可的信任记录取得，keyId 与完整性清单一致，不能由包自带公钥建立可信来源。未知算法、密钥、重复路径或摘要不符拒绝可信安装。归档摘要另记录在下载/安装收据中，包路径、字节预算与所有条目在解压前后分别核对。M2 提供签名、篡改、解压越界和离线金样。

无已认可签名的本地包可携带完整性清单而省略 signature.json，显示为本地未验证来源；首次启用由用户确认完整 Node 执行权限，不能伪装成原可信发布者的升级。下载索引签名不替代实际包摘要核对。市场目录的过期与撤销规则在 M2 市场入口建立时另行版本化。

Host 的只读验证实现位于 [`node_packages`](../../crates/host/src/node_packages/)，不写安装目录、不启动 Node。v0 打包采用单磁盘 ZIP32、Stored/Deflate 和 UTF-8 名称；既定预算内无需 ZIP64，未知压缩/加密/特殊条目拒绝。默认上限为归档 256 MiB、归档条目和隐式目录/文件节点各 10,000 个、单文件 64 MiB、展开总计 512 MiB、各主元数据 1 MiB（签名 8 KiB）、路径 1024 UTF-8 字节、单组件 255 字节及 30 秒；读入和哈希分块复核取消/期限，Host 接入时另持有并发容量直到任务真实退出。ZIP 库核对局部头、中央目录、重复名称和重叠，Host 额外核对原始类型属性、重解析标记、所有层级的大小写/Unicode 规范化别名及文件目录冲突。

验签使用来源记录提供的固定公钥及 Ed25519 strict verification，保留实际公钥 SHA-256、source/keyId 与归档摘要；签名针对原始 integrity 字节，不对解析后对象重排再签。Local 路径始终返回未验证来源，包自述或未知签名不会建立可信身份。验证结果持有不可变归档字节，后续安装消费同一内容；来源文件更换不改变已验证输入。只读验证不建立执行信任，安装与来源仓库基础见下节；管理入口的当前授权复核及执行生命周期继续按 Task14 接线。

### 安装事务与执行信任基础

Host 库层实现位于 [`node_packages/install.rs`](../../crates/host/src/node_packages/install.rs)。调用方在有界阻塞任务中消费已验证归档，先读取现有安装文档并检查 revision/格式，再解包至独立暂存目录、分块核对实际字节并同步文件。代码以唯一对象目录无覆盖发布，SQLite 条件提交后才成为可见安装版本；未提交对象不能用于激活。安装不执行后台、依赖钩子或 npm，也不访问插件私有数据。

所属命名空间为 `host-v0/node-packages/`：`objects/<UUID>` 保存已发布代码，`staging/<UUID>` 保留原始输入、安装收据及失败的暂存内容。原子提交使用现有 Store 的 `node-packages:installed` 文档和 revision，文档 `formatVersion` 为 U64 字符串 `"1"`；未知格式在写入和解包前拒绝，保留原件。目录操作复用已打开父目录的 PathGuard，拒绝链接/重解析点和路径替换；旧代码对象在升级或失败后保留，后续清理不能连带删除用户数据。文件与目录同步、取消和解压预算由实际安装任务承担；CAS 成功后不再把迟到取消报告为未安装，诊断写入失败也不改写已提交结果。

首次安装保持停用、无执行信任，即使来源验签成功。执行信任确认绑定当前归档摘要、权限声明和已验证来源；启停、确认、撤权都要求当前 revision 和摘要。`enabled` 是持久启用意图，不表示后台已经注册成功。只有可信 Host 的用户确认入口可调用确认方法；它未向 RPC 开放，也不授予设备或其他 Host API scope。

升级要求严格更高的 SemVer precedence。同一已验证 source/keyId/实际公钥指纹、相同协议/runtime 且新权限声明未扩大时，才可继承旧执行信任和启用意图；Host API 声明按 permission 与 target kind 的实际配对比较，不受数组分组影响。未验证本地新版、来源/密钥/runtime 变化或范围扩大均保持停用并重新确认。撤销执行信任同时清除启用意图，保留来源验证、代码和私有数据。实际接入时，调用方须先关闭新任务/效果接纳、结算旧 owner，再提交停用、撤权或升级；当前库层验证不能代替共享 Node/worker 的停止与资源归还验收。

来源仓库位于 [`source_store.rs`](../../crates/host/src/node_packages/source_store.rs)，复用 Store 的 `node-packages:sources` 文档与 revision CAS，`formatVersion` 为 U64 字符串 `"1"`，写入上限 1 MiB。每组 source/keyId 只有一个当前认可公钥；替换或撤销后保留历史公钥与指纹，历史记录不再用于新的可信验证。读取复核真实公钥、指纹、唯一性和弱密钥，损坏时拒绝覆盖，未来格式保持原件。

仓库验证入口先选取当前认可公钥，使用实际 Ed25519 签名验证归档，再复核当前认可身份；`require_current` 只报告本次观察的认可状态。认可来源不建立执行确认或 Host API scope。当前库层尚未提供 RPC 管理动作，安装/激活前的最终认可与授权检查、撤权通知及运行中 owner 停止仍须由管理器统一协调，不能把历史验签回执当作持续有效的执行授权。

### 已安装内容复核

[`installed.rs`](../../crates/host/src/node_packages/installed.rs)提供激活前的内容证明。`verify_installed` 绑定包 ID、预期安装 revision 和原始归档摘要，重新读取所属暂存记录中的原 ZIP，按同一预算验证完整性及实际当前认可的签名；本地未验证来源保持该身份。归档中的完整 manifest 和来源回执必须与已提交记录一致，不能从被改写的安装目录重新建立基准。

随后核对实际代码目录的所有文件、元数据、显式及隐式目录，拒绝缺失、未列出条目、类型变化、链接和重解析点；原始 ZIP 与代码文件的真实链接计数必须为一。实际字节大小和摘要逐块比对，Unix 文件权限按安装时的只读/可执行模式复核。macOS 比较目录项时处理文件系统的 Unicode 分解表示，原包仍须通过规范化别名拒绝。结束前再次检查安装 revision 和当前来源认可，失败不改写安装记录、归档或代码。

Windows 的证明对象持有拒绝写入/删除共享的文件句柄及目录保护句柄，调用方须把证明交给实际执行 owner，在 Node 真正退出后才释放。Unix 逐文件校验后关闭文件，代码目录仍按 Host 的不可变对象模型使用。停止、预算和未知格式按已有稳定 code 拒绝，公共错误不含私有路径。

内容证明不表示后台已激活，也不建立执行授权。管理器还须在实际接纳与效果边界复核执行信任、当前授权、runtime/协议及 owner 代次，并协调停用、撤权和升级；这些接线及共享 Node/worker 生命周期继续由 Task14 后续节点完成。

## 3. 后台生命周期与状态

`register(context)` 返回可异步调用的 `dispose()`。context 只含公开 SDK 的已认证连接、贡献注册、订阅、任务、日志与私有数据入口；导入模块不能偷偷代表用户发起业务。注册阶段完成能力校验与轻量初始化，长计算、持续解析和自由脚本直接进入可终止 worker 或子进程。

| 阶段      | 必须行为                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| 安装      | 只验证与保存；不调用 register，不运行预安装/后安装脚本。                                                         |
| 激活      | 复核启用、来源信任、协议/runtime、当前授权；register 成功后原子发布贡献及状态。失败撤销本次登记并显示错误。      |
| 接纳任务  | Host 先验证调用身份、scope、revision/epoch、租约和预算，建立 operation，再交给插件执行。                         |
| 停用/撤权 | 立即停止接纳新任务和新效果；已有任务请求取消、结算已发生副作用，释放订阅/句柄/贡献；超时按监督规则终止执行容器。 |
| 升级      | 先暂存并验证新版，停止旧版接纳，结算或中断旧任务，dispose 后才激活新版；同一包只允许一代贡献可写。               |
| 卸载      | 完成停用后移除安装记录与代码；私有数据的删除是独立显式操作。                                                     |
| 崩溃恢复  | Host 保留 operation 与结果证据；只重新登记贡献、恢复可查询状态，不重放发送队列或自动恢复有副作用任务。           |

dispose 必须可重复调用，覆盖部分 register 失败、停用、升级与 Host 退出。资源由创建它的后台任务/Host 生命周期拥有；不能把端口、解析器、文件传输或 operation 挂在页面组件的卸载回调上。任务记录执行 Host、发起者、插件版本、输入摘要和资源引用；后台拥有业务状态，Host 拥有授权、操作日志、状态投影与结果引用。客户端仅拥有草稿、焦点、选区和局部展示状态。

语义未变化的透明代理保留原始 Call 的操作者、requestContext、requestId、目标 Host 与执行模式，并记录插件代理链。Host 已接纳的插件动作需要调用 session.tx 等新业务动作时，使用 [父任务与子动作](./host-v0.md#父任务与子动作) 的 ChildCall：执行上下文取得 Host 派发的 taskContext，按父作用域递增 childKey，Host 为每个新子动作分配独立 requestId/operationId，并记录 rootOperationId 与 admission 的 parentOperationId/childKey。不得把根 Call 身份复用于不同子动作，也不得在 unknown 后换键自动补发。SDK 串行确认接纳，已接纳业务可并行；相同子键重试返回同一结果身份。

taskContext 只表示当前父任务与执行 owner 的关联。服务端在接纳和效果提交前复核调用者、插件与父任务 scope 的交集；插件完整执行信任不替代调用者的设备权限。已接纳 independent 任务超过根请求的 24 小时窗口后可继续提交新子动作，父取消、撤权、停用或 owner/Host 重启会关闭接纳，并按父子结算规则保留实际结果。断开客户端不生成新身份或扩大 scope。

## 4. 三类通道与资源预算

控制/取消/心跳、批量原始流、派生流使用分开的队列与调度预算；UI 刷新进一步合并，不能把逐字节原始事件塞入控制消息。每个订阅独立 cursor 与 credit，Host 核定最大批字节、未确认字节、队列长度和处理预算；worker/UI 不能无限申请 credit。具体 wire 字段复用流合同，预算配置与测量阈值统一在 Host 实现及性能基线维护。

原始流以资源所属 Host 的 sessionEpoch 与 seq 为权威。Node 消费者慢时报告缺口、停止相应消费者或从 capture 补读，不阻塞 Rust 录制，不用新 seq 隐藏缺口。credit 用尽暂停该订阅投递，已占用队列有界；取消、授权撤销和监督心跳保持独立可达。派生帧、字段和图表样本关联原始字节区间、解析器版本、配置摘要、单位及质量；出现缺口或新 epoch 时重置解析状态。

页面重开按 [快照与订阅](./host-v0.md#快照与订阅) 先拿快照再接续增量，过期 cursor 走公共恢复流程；不能把上代 instanceEpoch 的增量合入新状态。

## 5. Web UI 与客户端效果

桌面 WebView 与浏览器加载同一份预构建 UI。UI 在独立受控 iframe 中运行，无 Node、require、process 或 Tauri 全局；隔离文档不能获取任意系统路径、宿主对象或通用原生 IPC。宿主在验证 frame 来源/所属包/版本/页面实例后建立专用消息端口；每个消息校验生成 schema 与当前授权，不能仅信任消息内 actorId。重建 frame 使旧端口失效，迟到消息不能命中新实例。

桥上的业务调用与状态订阅复用 Host 合同。主题、语言、焦点、可见性、尺寸等客户端上下文作为独立 UI 控制信息；窗口、剪贴板、文件选择等效果明确定位目标客户端，缺少客户端时报告不可用。文件导出与后台业务通过 Host 文件/结果引用工作，不能把浏览器本地路径传给远端 Host。

关页释放消息端口、UI credit、事件监听与显示计时器；业务任务继续。隐藏界面暂停渲染、减少刷新；重新打开从快照与 cursor 恢复。未保存草稿参与客户端离页协商，暂停 AI 跟随只停止导航；人工接管按 Host 授权和租约规则执行。

| UI 验收例                         | 预期结果                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 切换浅/深主题、语言与缩放         | iframe 与宿主语义 token 一致；Canvas/图表主动重绘，正文与控件可读。                             |
| 从宿主 Tab 进入终端再退出         | 焦点位置可见，无键盘陷阱；关闭视图后回到发起控件。                                              |
| 输入法组合、粘贴、Ctrl/Alt/方向键 | composition 未完成不发送半成品；终端键位仅在聚焦且获控制时发送；宿主快捷键冲突有明确优先级。    |
| 桌面与浏览器打开同一终端/图表     | 同一 action/状态/结果；无 Node/Tauri 依赖，浏览器能力差异只影响客户端效果。                     |
| 关页后持续解析/脚本/录制，再重开  | 无 UI 订阅泄漏；业务继续，快照与增量接续不重复提交任务。                                        |
| 大流量同时停止任务                | 图表降采样或合并刷新，队列有界；取消与心跳不会排在批量数据后。                                  |
| 无 GUI 请求图表/报告导出          | 后台拿固定数据范围、配置、字体/主题与尺寸，在可终止导出任务中生成文件引用；完成后销毁离屏资源。 |

## 6. 一次信任与代码执行授权

可信 Node 按当前 OS 用户权限运行。进程与 worker 监督提供故障回收，不提供文件/网络/进程的强沙箱；API scope 约束经过 Host 的调用。第一方随包插件由产品建立信任；市场和本地包首次启用显示来源、版本与完整 Node 执行权限，由用户确认。普通已授权动作复用现有 scope，不逐次弹窗。

设备读写、自由脚本执行、外部工具执行与插件管理分别授权。导入工作区、打开录制、生成脚本或加载示例只准备内容。执行脚本时记录实际代码内容摘要/版本、来源、运行 Host 和授权 scope；MCP 生成与执行是两个动作，MCP 请求不能自行建立执行授权。B 共享串口的权限不包含在 B 运行代码、安装插件或启动工具。

同一可信来源/发布者密钥身份、相容协议/runtime 且授权范围未扩大的新版本可继承启用状态与原有信任；已拒绝 scope 不因升级变为允许。代码来源、签名身份或请求范围变化重新确认。仅改 manifest 中作者文本不能继承身份。

运行中撤销 API scope 会阻止新请求、清理未执行写入并结算在途结果；撤销 Node 执行信任会停用插件并终止其 worker/子进程。共享主 Node 中有未响应插件时，Rust 监督器可终止整个 Node 宿主，此影响在任务列表逐项可见。已产生的外部副作用按回执保留，不伪造回滚。

## 7. 监督与验收门

| 场景                                    | 必须观察到的结果                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 全部插件关闭                            | 基座仍能枚举、连接、Text/HEX 收发、capture/replay、任务查询与诊断。                                                    |
| 解析/脚本 worker 崩溃                   | 只中断所属任务，保留已完成结果与错误；其他插件、Rust 自持串口和录制继续。                                              |
| 共享主 Node 挂起                        | Rust 监督器通过独立心跳/期限判定并重启；相关任务 interrupted，已发效果无法确定时 unknown；重新登记贡献，无旧写入重放。 |
| Rust 自持串口录制期间重启 Node          | 原始序号和 capture 水位连续；插件派生流按实际缺口恢复，不声称派生结果完整。                                            |
| 插件 worker 持有 BLE/HID/USB 句柄后崩溃 | Host 报连接断开、终结旧租约与队列；重开产生新的 sessionEpoch，旧回执和数据不能并入新会话。                             |
| 升级时持续提交新动作                    | 旧版停止接纳，新请求得到明确不可用/升级状态；结算旧任务、释放贡献后才注册新版。                                        |
| 升级来源相同且相容                      | 复用原信任，授权未扩大；来源/密钥变化则保持停用直到用户确认。                                                          |
| 执行中撤权与人工接管                    | 新修改拒绝，排队写入终结，在途动作按可取消点结算；UI 与 MCP 查询得到相同状态。                                         |
| 插件动作连续发送、重试与长运行          | 按 Host H12—H16 验证独立子请求、乱序拒绝、超过24h仍按现有scope接纳、撤权停止和父子unknown结算；不得复用根请求身份。    |
| 慢插件 reader 的缺口与确认              | 按流 S20—S21 解码 StreamItem 的 reader_gap 分支，按批边界确认；不能把 ReaderGap 填成源 RawEvent，不能重复增额。        |
| 浏览器断线、GUI 关页、A Host 失联       | 分别验证视图释放、后台继续，以及 interactive 租约到期 / independent 已接纳任务继续，不能把关页当断开 Host。            |
| 三平台离线安装与加载                    | 正式包完整，固定 runtime 通过校验，无下载或安装钩子，无 PATH 依赖。                                                    |

M2 以终端、图表、自动化三个正式参考插件完成后台、Web UI、离线安装和故障路径。M3 再以至少两个仅依赖公开 SDK 的插件完成协议事务、独占工具、长脚本、离线波形与离屏导出，核对 GUI/CLI/MCP 等效、schema/类型一致、版本拒绝与后台整套组件升级。通过后才冻结 v1。
