# Node 扩展合同 v0

可信 Node 插件的正式包、后台、Web UI 与授权契约。M3 主线已冻结 Host RPC 1.0，签名扩展清单继续使用 `0.1` 兼容值。各能力的主线交付及专项证据见[路线与进度](../plan.md)。运行时来源、目标与固定启动位置见[runtime 分发基线](./runtime-distribution.md)，作者接口见 [Node SDK](../../packages/plugin-sdk/README.md)。

## 1. 协议与类型来源

所有 wire 字段使用 camelCase。外部 Host RPC 按 [Host 协议](./host-v0.md#附着版本与目录)精确协商 `"1.0"`。已签名扩展清单的 `hostProtocolVersion` 继续声明 SDK 兼容值 `"0.1"`，包验证使用独立类型。插件通过公开 SDK 使用宿主会话、动作与查询。所有 u64 计数、revision、epoch、seq、offset、duration 使用无符号十进制字符串，禁止经过 JavaScript number 中转。包版本、manifest schema、Host 协议与私有数据 schema 分别版本化。

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
| `hostProtocolVersion`        | 必需，扩展兼容值为 `"0.1"`。Rust `NodePackageHostProtocolVersion` 拒绝未知兼容值，包验证失败且不进入安装。                                                                          |
| `runtimeRef`                 | 必需，引用应用发行组件清单中的 runtime 身份；精确版本与 ABI 约束按 runtime 分发基线校验。                                                                                           |
| `main`                       | 必需，包内预构建 ESM JavaScript 后台入口，导出 `register`。                                                                                                                         |
| `webUi`                      | 可选，`{entry}`，指向包内 HTML；其所有执行资源随包提供。                                                                                                                            |
| `dependencies`               | 必需数组，逐项 `{name,version,path,license}`，只允许包内已经解析并锁定的依赖，不允许浮动标签、URL 拉取或宿主 npm 全局解析。无依赖时为空。                                           |
| `platformResources`          | 必需数组，逐项 `{id,target,path,kind,version,runtimeRef?}`；`kind` 为 `nativeAddon\|tool\|data`，target 使用发行基线目标标识。native addon 必须锁定 runtime/ABI，工具锁定实际版本。 |
| `activation`                 | 必需数组，元素为 `startup` 或声明的贡献 ID；只在启用且信任有效时触发，多个请求合并为同一激活。                                                                                      |
| `permissions`                | 必需，声明 Host API 权限/目标 scope、代码执行用途及外部工具需求；调用时仍复核当前授权，声明本身不授予权限。                                                                         |
| `contributes`                | 必需，包含 `actions`、`queries`、`transports`、`parsers`、`views`、`themes`、`configuration` 数组；未提供的类别为空。                                                               |
| `dataSchemaVersion`          | 必需，插件私有持久状态版本；安装包与数据分目录，拒绝向较新格式写入。                                                                                                                |

每项业务贡献引用[公共目录项](./host-v0.md)的 `actionId,kind,inputSchema,outputSchema,targetKinds,executionLocation,permissions,stateScopes,eventTypes,cancellation,revealTarget`。GUI、CLI 和 MCP 通过同一目录访问获准的动作、查询、设置、插件管理和工作区操作。变更来源密钥与执行信任另需本地用户控制身份。视图引用目录动作与共享状态，纯主题资源声明资源 schema 与配置入口。动态注册限于已校验 manifest 声明的子集。

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

无已认可签名的本地包可携带完整性清单而省略 signature.json，显示为本地未验证来源；首次启用由用户确认完整 Node 执行权限，不能伪装成原可信发布者的升级。下载索引签名不替代实际包摘要核对。M2 使用本地包与来源记录。市场目录的过期与撤销规则随 M5 分发协议另行版本化。

Host 的只读验证实现位于 [`node_packages`](../../crates/host/src/node_packages/)，不写安装目录、不启动 Node。v0 打包采用单磁盘 ZIP32、Stored/Deflate 和 UTF-8 名称；既定预算内无需 ZIP64，未知压缩/加密/特殊条目拒绝。默认上限为归档 256 MiB、归档条目和隐式目录/文件节点各 10,000 个、单文件 64 MiB、展开总计 512 MiB、各主元数据 1 MiB（签名 8 KiB）、路径 1024 UTF-8 字节、单组件 255 字节及 30 秒；读入和哈希分块复核取消/期限，Host 接入时另持有并发容量直到任务真实退出。ZIP 库核对局部头、中央目录、重复名称和重叠，Host 额外核对原始类型属性、重解析标记、所有层级的大小写/Unicode 规范化别名及文件目录冲突。

验签使用来源记录提供的固定公钥及 Ed25519 strict verification，保留实际公钥 SHA-256、source/keyId 与归档摘要；签名针对原始 integrity 字节，不对解析后对象重排再签。Local 路径始终返回未验证来源，包自述或未知签名不会建立可信身份。验证结果持有不可变归档字节，后续安装消费同一内容；来源文件更换不改变已验证输入。只读验证不建立执行信任；管理入口仍须复核当前授权。

### 安装事务与执行信任基础

Host 库层实现位于 [`node_packages/install.rs`](../../crates/host/src/node_packages/install.rs)。调用方在有界阻塞任务中消费已验证归档，先读取现有安装文档并检查 revision/格式，再解包至独立暂存目录、分块核对实际字节并同步文件。代码以唯一对象目录无覆盖发布，SQLite 条件提交后才成为可见安装版本；未提交对象不能用于激活。安装不执行后台、依赖钩子或 npm，也不访问插件私有数据。

所属命名空间为 `host-v0/node-packages/`：`objects/<UUID>` 保存已发布代码，`staging/<UUID>` 保留原始输入、安装收据及失败的暂存内容。原子提交使用现有 Store 的 `node-packages:installed` 文档和 revision，文档 `formatVersion` 为 U64 字符串 `"1"`；未知格式在写入和解包前拒绝，保留原件。目录操作复用已打开父目录的 PathGuard，拒绝链接/重解析点和路径替换；旧代码对象在升级或失败后保留，后续清理不能连带删除用户数据。文件与目录同步、取消和解压预算由实际安装任务承担；CAS 成功后不再把迟到取消报告为未安装，诊断写入失败也不改写已提交结果。

首次安装保持停用、无执行信任，即使来源验签成功。执行信任确认绑定当前归档摘要、权限声明和已验证来源；启停、确认、撤权都要求当前 revision 和摘要。`enabled` 是持久启用意图，不表示后台已经注册成功。只有可信 Host 的本地用户控制身份可确认执行信任，RPC边界见[执行信任确认](#执行信任确认)；确认不授予设备或其他 Host API scope。

升级要求严格更高的 SemVer precedence。同一已验证 source/keyId/实际公钥指纹、相同协议/runtime 且新权限声明未扩大时，才可继承旧执行信任和启用意图；Host API 声明按 permission 与 target kind 的实际配对比较，不受数组分组影响。未验证本地新版、来源/密钥/runtime 变化或范围扩大均保持停用并重新确认。撤销执行信任同时清除启用意图，保留来源验证、代码和私有数据。停用、撤权或升级先关闭新任务与效果的接纳，结算旧 owner 的实际工作，再提交变更。

来源仓库位于 [`source_store.rs`](../../crates/host/src/node_packages/source_store.rs)，复用 Store 的 `node-packages:sources` 文档与 revision CAS，`formatVersion` 为 U64 字符串 `"1"`，写入上限 1 MiB。每组 source/keyId 只有一个当前认可公钥；替换或撤销后保留历史公钥与指纹，历史记录不再用于新的可信验证。读取复核真实公钥、指纹、唯一性和弱密钥，损坏时拒绝覆盖，未来格式保持原件。

仓库验证入口先选取当前认可公钥，使用实际 Ed25519 签名验证归档，再复核当前认可身份；`require_current` 只报告本次观察的认可状态。认可来源不建立执行确认或 Host API scope。RPC 来源入口见[来源管理](#来源管理)，不能把历史验签回执当作持续有效的执行授权。

### 已安装内容复核

[`installed.rs`](../../crates/host/src/node_packages/installed.rs)提供激活前的内容证明。`verify_installed` 绑定包 ID、预期安装 revision 和原始归档摘要，重新读取所属暂存记录中的原 ZIP，按同一预算验证完整性及实际当前认可的签名；本地未验证来源保持该身份。归档中的完整 manifest 和来源回执必须与已提交记录一致，不能从被改写的安装目录重新建立基准。

随后核对实际代码目录的所有文件、元数据、显式及隐式目录，拒绝缺失、未列出条目、类型变化、链接和重解析点；原始 ZIP 与代码文件的真实链接计数必须为一。实际字节大小和摘要逐块比对，Unix 文件权限按安装时的只读/可执行模式复核。macOS 比较目录项时处理文件系统的 Unicode 分解表示，原包仍须通过规范化别名拒绝。结束前再次检查安装 revision 和当前来源认可，失败不改写安装记录、归档或代码。

Windows 的证明对象持有拒绝写入/删除共享的文件句柄及目录保护句柄，调用方须把证明交给实际执行 owner，在 Node 真正退出后才释放。Unix 逐文件校验后关闭文件，代码目录仍按 Host 的不可变对象模型使用。停止、预算和未知格式按已有稳定 code 拒绝，公共错误不含私有路径。

内容证明不表示后台已激活，也不建立执行授权。管理器还须在实际接纳与效果边界复核执行信任、当前授权、runtime/协议及 owner 代次，并协调停用、撤权和升级。

### 管理查询

`node.packages.list` 是 Host 目标的只读分页查询，要求当前 `metadata.read`，回复为 `QueryResult` 的 `node_packages` 分支。[Rust 管理 DTO](../../crates/core/src/node_management.rs) 的输入为 `{pageSize?,after?,expectedRevision?,parserOnly?}`。pageSize 默认 20、范围 1—100。after 必须同时携带首张快照的 expectedRevision。返回同一次安装文档读取的 revision、packages 与可选 nextAfter。续页期间安装记录改变返回 `REVISION_CONFLICT`，客户端重新取首张快照。

省略 `parserOnly` 即读取完整安装目录。传入 `true` 时只返回签名清单声明 `contributes.parsers` 的包，包含已禁用的版本。筛选在分页前执行，续页沿用同一筛选。游标指向筛选范围以外的包时返回 `INVALID_ARGUMENT`。实验包的解析器选择、导出与依赖检查使用这个目录。

每项为有界的 `NodePackageSummary`，包含 `{id,displayName?,version?,archiveSha256,enabled,sourceVerified,executionApproved}`。Host 从已校验的安装清单生成显示名称与版本。名称超过 96 个 Unicode 标量时提供带省略号的预览，版本超过 128 字节时省略该字段。完整清单可通过详读接口读取，历史操作回执也可省略这两项。sourceVerified 表示安装记录带有来源验证收据；executionApproved 表示持久确认仍精确绑定该记录的归档、权限声明和来源。它们是历史记录投影，enabled 也仅为启用意图，均不表示后台已激活、当前来源仍可信或调用者仍有执行权限。实际接纳与效果边界仍按下述生命周期复核。

完整 manifest 和持久确认通过 `node.packages.detailsRead` 读取，输入为 `{id,expectedRevision,archiveSha256,offset,length}`，长度范围 1—32768 字节；回复为 `node_package_details` 分支，包含 revision、id、archiveSha256、jsonSha256、offset、totalBytes 和 bytesBase64。内容是 `NodePackageInstallation` 的完整 UTF-8 JSON；按原始字节 offset 拼接后核对总长和 jsonSha256 再解码，中文等多字节字符可跨块。revision 或包身份不符时拒绝，不能拼接不同安装代次的片段；这些值遵循同一 U64 字符串约束。

分页摘要、安装回执和详情分块均保持现有 1 MiB 控制帧门槛，不截断合法 manifest，也不扩大帧预算。元数据查询的实际读取/序列化共用两个名额，交付前复核授权及授权代次；不暴露代码对象 ID、安装目录或私有数据路径，不启动 Node、不导入插件代码或更改信任。

### 来源管理

`node.sources.list` 是要求 Host 上当前 `metadata.read` 的查询，输入 `{pageSize?,offset?,expectedRevision?}`，pageSize 默认20、范围1—100，offset默认0，非零offset须同时携带首张快照的expectedRevision。`node_package_sources` 返回 `{revision,keys,nextOffset?}`；每项为 `{source,keyId,publicKey,publicKeySha256,approved}`，publicKey 是32个0—255整数字节，摘要绑定实际公钥，历史认可和撤销记录均可查询。续页期间来源文档改变返回 `REVISION_CONFLICT`，单页及单项回执保持既有控制帧预算。

`node.sources.approveKey` 和 `node.sources.revokeKey` 均为 Host 上的用户控制动作，要求现有本地用户控制身份与 `auth.manage`，普通 `plugins.manage` 或 `code.execute` 不足以建立来源信任。认可参数为 `{source,keyId,publicKey,publicKeySha256}`，公钥必须有效、非弱密钥且与所确认摘要一致；撤销参数为 `{source,keyId,publicKeySha256}`，只撤销当前认可且摘要匹配的密钥。两者都必须提供Call.expectedRevision；冲突、错误摘要和未知当前密钥拒绝写入。认可、轮换与撤销保留历史公开材料，不确认插件执行信任，也不授予调用者API权限。

动作复用持久Operation、请求去重、合作停止和真实派发终态；成功返回 `node_source_changed` 的 `{revision,key}`。来源写入有独立名额，使撤销可以在归档读取/解包期间执行；来源提交和安装最终发布/CAS共用短期提交门锁，持锁后复核当前授权、代次和来源。来源变化提交后唤醒安装owner，已验证包按实际公钥指纹复核并停止失效的后续工作。安装progress使用已同步的文件数，平时限频发布，失败/取消结算前保存准确末值；内部事实保存不授予新权限，交付仍按当前授权过滤。真实阻塞任务结束后才归还名额，CAS成功后的真实回执不被晚到取消改写。撤销来源时还须验证运行中 owner 的实际关闭与旧代次退出，不能只验来源记录。

### 安装管理动作

`node.packages.install` 在 Host 目标执行，输入为 `{archiveRef,source}`。archiveRef 必须是已注册的 ReadFile 引用；source 显式选择 `{kind:"local"}` 或 `{kind:"trusted",source,keyId}`，可信公钥只从当前来源仓库取得，参数不能携带公钥或任意路径。Call 必须提供安装文档的 expectedRevision。动作分别要求 Host 上的 `plugins.manage` 和实际归档引用的 `content.read`，发现目录也按文件类别匹配读取 scope，不要求全 Host 内容读取权限。

接纳复用持久 Operation 与请求去重，实际任务独占安装名额。先检查文件预算，再从固定文件证明分块取得有界归档快照，验证和解包使用同一截止预算与合作取消；真实阻塞任务退出后才归还名额。管理器观察授权、Operation 取消和 Host 关停，发布和条件提交前再次检查接纳时的授权代次、当前权限、来源身份与 owner 状态。升级在完整候选准备后、CAS短锁外先收敛旧运行owner，再提交新记录并通知运行服务；安装动作本身不导入或执行代码，新版激活与恢复仍按后台生命周期完成。

安装文档 CAS 成功后，Operation 的结果是 `node_package_installed` 分支及 `{revision,package}`，package 使用上述有界摘要，完整记录仍从详情读取。新安装保持停用、无执行信任。相同请求返回原 Operation，新请求携带旧 revision 得到冲突，旧版本与失败现场保留；提交后晚到取消不把真实安装成功改写为未安装。可信来源和启用继承仍遵循上述安装事务规则，不能据 enabled 字段推断实际后台状态。

### 执行信任确认

`node.packages.confirmExecutionTrust` 是 Host 上的用户控制动作，要求现有本地用户控制身份及 `auth.manage`。输入为 `{id,archiveSha256}`，Call必须携带安装文档的expectedRevision；普通 `plugins.manage`、`code.execute` 或输入中自述确认不能代替该身份。成功返回 `node_package_changed` 的 `{revision,package}`，使用与安装相同的有界 `NodePackageChangeResult`；完整记录仍通过详情分块读取。

管理器先核对当前安装记录、内容身份和实际来源，使用同一预算重新验证保留的原ZIP、完整manifest和实际代码树，并保持内容证明至CAS结束。确认与安装共用一个实际工作名额，来源撤销使用独立名额；最终提交持同一门锁，复核当前身份、授权、来源和Operation状态。来源已撤销、错误摘要、过期revision、代码篡改或未来格式均不建立新的执行信任。已提交的真实回执不被晚到取消改写，相同请求复用原Operation。

确认保存当前内容绑定的执行信任，保留既有启用意图，不导入包、不启动Node，也不改变调用者的API授权。首次安装后的确认因此仍保持停用；实际激活与运行状态通过下述管理入口处理。

### 执行信任撤销

`node.packages.revokeExecutionTrust` 是Host上的用户控制动作，身份与 `auth.manage` 要求同确认；输入复用 `{id,archiveSha256}`，Call必须携带安装文档的expectedRevision。普通 `plugins.manage` 不能代替本地用户控制，`auth.manage` 也不是可经普通授权转授的业务scope。它不撤来源密钥、不删除代码或私有数据。

管理器按精确revision及归档身份选择安装记录，复用停用流程关闭新接纳、结算任务和实际执行owner，再于原授权提交锁内CAS清除enabled、执行确认及自动激活主体。撤销不重新认可代码，因此来源已失效或代码无法重新验证不能成为保留旧执行确认的理由；未来格式或身份冲突仍拒绝写入。实际退出未确认时保留Unknown，不报告已安全撤销；清理已真实完成但失败、撤销CAS已提交时，Operation保留失败码和 `node_package_changed` 的真实 `{revision,package}`。提交前取消不写假撤销，提交后的晚取消不回滚事实，相同请求只读取原回执。再次运行必须重新经人工确认及显式启用。

### 运行管理

`node.packages.setEnabled` 是 Host 上要求 `plugins.manage` 的合作停止动作，输入 `{id,archiveSha256,enabled}`，Call 必须携带安装文档的 expectedRevision。它复用安装/确认的实际工作名额，不能建立执行信任或扩展业务API权限。启用先复核精确安装记录、来源、runtimeRef、原归档与实际代码树，提交启用意图后保持同一内容证明交给实际 Node register；停用等待实际 dispose，再提交停用意图。当前后台主线程、worker和已启用包的授权在其他注册等待期间仍须被监督。

成功返回 `node_package_changed` 的 `{revision,package}`。启停意图已经提交时，即使注册或清理阶段失败，Operation 保留失败/中断/未知的实际终态、稳定错误码和已提交的 `node_package_changed` 结果，不能伪造回滚。调用者分别读取持久摘要与运行状态；再次尝试必须使用当前 revision 和摘要，不重放已经产生的业务效果。

`node.packages.uninstall` 是Host上的 `plugins.manage` 动作，输入复用 `{id,archiveSha256}`，Call携带安装文档expectedRevision。它先完成真实停用，再移除精确当前安装记录、代码对象及该对象的缓存归档/验证材料；私有数据、用户注册的原始ZIP、旧升级对象及未提交/失败暂存证据保留。来源认可、执行信任或代码仍能通过验签不是卸载前提，路径安全及未来格式保护仍生效。共享Node仍持目标对象证明且有其他活动包时，停用前返回可重试HOST_BUSY，保留其他包及目标的运行状态；休眠新对象不因同包旧对象仍被持有而被误挡。

卸载返回 `node_package_uninstalled` 的 `{revision,id,archiveSha256}`，表示安装记录移除已提交；只有物理清理完成后Operation才Succeeded。迟到取消不回滚已提交事实；清理仍受原截止时刻约束，失败时保留已提交回执、错误及待恢复材料，不能声称代码已全部清理。准备阶段使用受限恢复记录和无覆盖隔离移动，明确未提交的CAS失败恢复原路径；提交结果无法确认时保留Unknown及隔离证据。启动及下一次包效果在原预算内恢复，不能因旧回执重放再次删除或影响后来重装的新对象。无法从当前有效安装文档和恢复记录证明提交状态时保留原件并拒绝该Node效果，不阻断Host基础串口能力。

`node.packages.runtime` 是 Host 上要求 `metadata.read` 的查询，输入 `{id}`；返回 `node_package_runtime` 的 `{id,phase,generation,archiveSha256?,error?}`。phase 为 `inactive | starting | active | stopping | failed`，generation 是当前 Host 内实际后台启动代次，未启动为0。错误不包含私有路径或stderr。运行状态不等于持久 enabled，内容摘要绑定该次运行所选内容；控制任务进行时仍可读取阶段。Host关停等待真实进程退出与管道读写者结束，退出未确认必须保留清理失败，不能因消费句柄或线程panic变成成功。

公共管理的最终完整验权与安装/来源CAS，按管理门→同一授权变更锁排序；锁内执行原多资源validator，分别复核动作目标与实际文件引用的权限和当前授权，不将FileRef的content.read扩大为Host级权限。候选准备及实际register/dispose在锁外。撤权先完成则未提交写入拒绝；同步提交先取得顺序则完成后撤权才返回。异步等待继续观察原预算和合作取消，进入同步CAS后按真实结果结算。停用CAS已提交的事实与回执不被迟到取消或撤权回滚；真实dispose失败、执行容器已回收后停用意图仍已提交时，保留Failed/NODE_DISPOSE_FAILED及node_package_changed，不伪造成功或未停用。退出未确认继续优先Unknown，不提交“已安全停用”的事实。

## 3. 后台生命周期与状态

`register(context)` 返回可异步调用的 `dispose()`。context 只含公开 SDK 的已认证连接、贡献注册、订阅、任务、日志与私有数据入口；导入模块不能偷偷代表用户发起业务。注册阶段完成能力校验与轻量初始化，长计算、持续解析和自由脚本直接进入可终止 worker 或子进程。

`context.queries.register` 和 `context.actions.register` 只在 register 阶段绑定本包已声明的处理器。Host 目录只发布实际 active 的子集，按当前调用者权限过滤；停用、重新登记或授权变化使旧目录失效。`action.check` 不执行处理器。查询接收原始 Query，动作接收 Call 和任务上下文；Rust 校验目标、离线输入/输出 schema、声明 scope 与登记代次。异常正文仅供 Host 私有诊断。

公共动作接纳时持久保存请求身份、插件 owner/版本/归档/登记代次与 scope；owner 记录实际派发。成功结果是只读 `plugin_result` 引用，重放和结果读取均复核当前来源权限。合作取消等待实际处理器收尾，不合作则按监督预算回收。未经请求的取消回执结算为 `NODE_ACTION_FAILED`，不能把 Running 直接改为 Cancelled。

公共入口在Rust中补齐缺失默认值后校验并绑定摘要，显式值和null保持。引用、allOf、条件和依赖从同一原输入独立提案，anyOf/oneOf先按成功分支求共识再作为一项合并；缺失位置的完整字面值不一致时不新造共同容器。本scope自身字面默认值已有的子字段保持原值。候选保留来源，无自身可物化值但能接受有效候选实例的分支仍参与共识，不依赖上一轮偶然填值才投票；无效默认值不进入实例池。unevaluated按本轮完整组合值判断覆盖，自身默认提案保持独立。重放先验证保存的插件元数据，相同已规范化参数可直接复用持久输入，不同参数仍使用已保存的schema；完整摘要和当前结果权限均继续检查，准备阶段失败时仍重新查找同键请求并按当前结果权限交付。

**离线 schema 的预算与失败语义：** 条件、无默认值的输入和最终输出都须在预算内校验；输出不填默认值，超额不发布结果。预检须先于实际分配，覆盖递归引用、动态作用域、URI/Pointer、锚点、生成图及 registry 副本。仅解析真正引用的资源，不加载网络或文件 schema。不同实例/方言的作用域不能共用错误的基址，也不能因展开下一层重置同一请求的工作量。

- 每个 Prepared 的校验缓存同时限制 128 项与 8 MiB；进程级 128 MiB 逻辑额度涵盖初次构建、常驻图与生成缓存。单份超额为 `LIMIT_EXCEEDED`，并发争用为可重试的 `HOST_BUSY`。构建、校验与清理持有名额至真实完成，不把逻辑权重当作 CPU 或 RSS 硬上限。
- 超预算拒绝不得创建业务 Operation；显式输入和已接纳的请求身份不受新编译失败改写。各类工作量上限、计算方法及对应反例集中在 [Host 参数校验模块](../../crates/host/src/node_backend/definitions/parameters/)，不在客户端复刻。

**传输提供器。** 公开 SDK 在 `register(context)` 内用 `context.transports.register(id, open)` 选择已签名清单的传输条目。Host 在设备目录发布实际登记的传输，普通动作目录继续发布查询和动作。Host 的 `device.open` 以 `transportParams` 传入参数，沿用正常会话回执。Host 用条目的输入 schema 验证参数并补齐默认值，核对目标设备和授权后才调用提供器。插件参数由显式打开给定，串口绑定和自动重连沿用原有串口路径。

`open({params, signal})` 建立当前连接。句柄提供 `read({maxBytes, waitMs, signal})`、`write({bytes, waitMs, signal})` 和 `close()`。空读表示本次等待未取得数据，`null` 表示 EOF。写入回执的整数表示已知接纳的连续字节前缀。派发后取消、掉线或退出而缺少可靠回执时，Host 保留未知区间，重试沿用现有请求去重。关闭处理器须等待实际资源关闭，Host 在真实关闭得到证明时记录清理成功。[参考包](../../packages/plugin-sdk/examples/reference-transport/)

已打开的连接可声明可选的 `lineControls`。Host 只发布连接实际声明的 DTR、RTS 能力，通过现有 `session.control` 验权并调度。控制和 Raw 读取可并行等待，Host 继续用同一会话 owner 发布字节。控制回执可确认实际值、明确未提交或记录结果未知。未证实的线路值不能更新下一代连接的回执。未提供这项能力的已签名连接继续使用原读写合同。

自动登记使用原激活主体及 epoch，重核当前授权、来源、执行信任与内容证明；首次人工激活失败不当作 owner 崩溃自动重试。同包显式启用可合并等待，但仍各自验权且不延长总预算，真实失败状态发布后才归还名额。相容升级只在安装 CAS 成功后以原主体登记精确新归档；撤权或扩大权限不导入新版。按需触发分别核验原主体登记资格和此次调用者权限，不重新派发旧业务。

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

taskContext 只表示当前父任务与执行 owner 的关联。服务端在接纳和效果提交前复核调用者、插件与父任务 scope 的交集；插件完整执行信任不替代调用者的设备权限。动态贡献Action仅要求其声明的permissions，显式声明metadata.read时仍须检查；Query继续要求metadata.read与声明权限。内部按需登记不向业务caller索取额外能力。父任务当前性及目标范围独立递归检查，即使Action权限声明为空，也必须符合所有父层的Host/精确Target边界；内层Host不能扩大祖先资源范围，目标检查本身不授API权限。已接纳 independent 任务超过根请求的 24 小时窗口后可继续提交新子动作，父取消、撤权、停用或 owner/Host 重启会关闭接纳，并按父子结算规则保留实际结果。断开客户端不生成新身份或扩大 scope。

Host持久派发后只向实际owner交付taskContext及父Operation身份；原Call/公开Operation不携带明文。handler可通过task.actions.invokeChild({actionId,target,params,expectedRevision?,leaseId?,revealTarget?})请求子动作，返回的是接纳Operation；Host分配独立requestId/operationId并固定根、mode和插件版本证据。Node私有桥保持异步有界回执，SDK串行确认子键，在快照/入队前检查8项及2MiB预算。Host按真实接纳工作是否入队标记确定的接纳前拒绝，SDK仅首次确定拒绝时释放未消耗键；已有未确认接纳继续只允许同键同参重试，不按错误码猜测是否执行。handler另可通过task.operations.get(selector)按operationId或(parentOperationId,childKey)读取Operation；复用原查询的当前资源/引用和结果权限，结果仍保留ActionResult的kind/value结构。两类私有请求共享8个在途名额；读取使用Host持有的实际job及原查询名额至完成，只读派生上下文不能用于动作接纳，原任务结束、owner/epoch或授权变化后拒绝晚交付。父处理器返回后关闭新接纳，已接纳子项继续执行，父等待真实终态；父取消传播到在途子孙，Unknown清理前原子归并父摘要。当前实现叠加原调用者、插件声明和父Host/精确资源范围，实际效果复用原授权链；不向插件委托人工控制。

`context.workers.start` 在动作异步链内创建的worker归属该实际任务，保留既有包/全局计数与V8限额；注册、查询和独立后台链仍按包管理。任务取消只停止所属worker，实际exit后才释放资源和结算；handler早返回只暂存结果并关闭新worker及私有SDK准入，不能靠晚回调转成后台任务。已有worker自然完成后可成功；早返回后实际停止剩余工作则Cancelled，意外worker故障以NODE_WORKER_INTERRUPTED结算所属任务Interrupted，已完成子结果保留、子Unknown仍传播。worker全部退出后handler确认的有效领域结果保留成功，Rust继续校验输出schema。

故障/失败清理的私有action_stopping只启动既有五秒停止期限，独立于Host的取消请求记录，重复通知不续期；未确认实际退出不提前完成或归还名额。主线程仍发心跳但worker卡在原生调用时，超期沿原容器监督回收并按真实不确定性结算。

返回值归一化（含同步handler对象的then getter）仍在该任务作用域内；handler完成后立即关闭准入，再于同作用域执行JSON序列化。JSON getter/toJSON不能把worker转成包级工作，私有SDK也不能在序列化期重新接纳。合法领域值仍沿原校验与成功路径，不以一概拒绝getter对象替代实际生命周期责任。

Host动作的`task.progress.report({completed,unit,total?})`复用Operation进度：计数为U64十进制字符串，completed单调、unit及total固定，不能超过total；未知字段、显式null及关闭后的报告拒绝。报告只替换最新快照，复用原心跳轮转交付，不逐报告入控制队列。Rust监督线程只更新有界slot，由原任务等待者在锁外写Store；观察失败不提前释放实际工作、不覆盖领域回执。最终观察与领域结果合帧超限时省略观察，保留原合法终态及完整结果；Store另在写入前检查完整Operation并留控制封套余量，拒绝超大观察不改原记录。观察是尽力交付，缺样本不表示零或没有工作。

`Operation.workerObservation`归属当前实际派发的任务，包含liveWorkers、peakWorkers及可选lastMemory。原生`Worker.getHeapStatistics()`的used_heap_size汇总为v8HeapUsedBytes，measuredWorkers标明覆盖数量，sampledAt取组成样本中最早的实际采样完成时刻；它不包含整个进程或外部缓冲区内存。退出后live可降为零，最后内存样本继续保留，不伪造零。采样不等待worker响应，每个worker最多一个在途原生查询。

`host.metrics.node`只公开当前实际Node实例的聚合PID、RSS、live/peak及Host接收样本的单调年龄，不包含任务身份或正文；RSS来自一次原生`process.memoryUsage.rss()`全进程读数，不按worker重复累加。缺少字段表示未取得样本，实例退出后不继续发布旧缓存。任务观察读取沿现有Operation资源/结果授权，Store内部写入同时限定Host epoch、插件实例、真实派发和非终态，CancelRequested仍可记录已发生事实。原名额、V8限制、心跳及停止期限不变。

## 4. 三类通道与资源预算

控制/取消/心跳、批量原始流、派生流使用分开的队列与调度预算；UI 刷新进一步合并，不能把逐字节原始事件塞入控制消息。每个订阅独立 cursor 与 credit，Host 核定最大批字节、未确认字节、队列长度和处理预算；worker/UI 不能无限申请 credit。具体 wire 字段复用流合同，预算配置与测量阈值统一在 Host 实现及性能基线维护。

原始流以资源所属 Host 的 sessionEpoch 与 seq 为权威。Node 消费者慢时报告缺口、停止相应消费者或从 capture 补读，不阻塞 Rust 录制，不用新 seq 隐藏缺口。credit 用尽暂停该订阅投递，已占用队列有界；取消、授权撤销和监督心跳保持独立可达。派生帧、字段和图表样本关联原始字节区间、解析器版本、配置摘要、单位及质量；出现缺口或新 epoch 时重置解析状态。

后台动作可以调用 `task.streams.read(StreamReadParams)`，读取 Host 留存窗口的 `StreamReadResult`。Host 按实际任务身份交集检查会话的 `content.read`，并在实际发送页前复核任务与权限。请求和回复通过 Node 私有管道的独立 Raw 队列，帧头区分通道。控制优先于下一帧 Raw，已经开始写入的帧最多携带 256 KiB 页数据和固定封套余量。Raw 请求最多四个在途，工作随 Host 所属任务登记，页内存租约持续至实际写入或丢弃。取消可以提前结束 Node 等待，工作完成后归还名额并丢弃已退休的正文。页大小、过期和下一页位置沿用 [原始事件与独立 reader](./stream-and-operations-v0.md#原始事件与独立-reader)。

后台动作可以显式调用 `task.streams.followSession(params, hooks)`。它复用 `StreamReadParams`，从指定事件序号读取同一 Host 实例及会话代次。每个任务最多持有一个跟随者，从既有四个 Raw 名额中预留一席，直至结束或释放。SDK 等待上一个异步回调返回才推进对应页，也不会为新的会话代次重新附着。

`onConnect` 对留存范围中的真实打开事件触发一次，`onReceive` 交付 RX 事件，`onSend` 交付带已知和未知范围的最终 TX 回执。已发布的 TX 意图尚无结算时，流不提前通知断开。`onError` 交付源缺口、留存过期、遗失的 TX 结算证据及底层故障。插件收到缺口后先丢弃未完成的解析状态，回调完成后 SDK 才沿获准游标继续。收到真实终态时，故障和结算缺口先于 `onDisconnect`。撤权、取消及回调错误结束跟随并释放读取者。它们不被当作会话断开。

后台动作调用 `task.streams.publishDerived({sources,quality,unit?,value})` 发布 JSON 值，数字允许小数。Host 核对每个来源范围属于同一个精确会话代次及留存原始事件，并生成 `parserId`（实际动作 ID）、`parserVersion`（实际登记包版本）与 `configurationDigest`（应用默认值等规范化后的动作入参 JSON 的 SHA-256，键按序编码）。发布和提交时复核会话 `content.read` 及任务授权。最多八个来源区间，合计最多引用 100 个事件。带字节范围时必须给出方向，`complete` 不能跨越源缺口或与 `gap|partial|unknown` 并用。

派生发布单独使用四个在途名额和 32 KiB 请求帧。控制帧优先，Raw 与派生回复交替获得发送机会。提交成功返回 `{operationId,position}`，运行任务取消时仅未提交的发布失效，已留存的数据可由有权读者继续分页。派生读取见 [原始事件与独立 reader](./stream-and-operations-v0.md#原始事件与独立-reader)。

### 协议解析器

签名清单在 `contributes.parsers` 声明解析器动作。目标限定为 `session`，执行归属为 `resource_host`，声明须包含 `content.read`。后台在 `register` 内调用 `context.parsers.register(id, handler)`。Host 校验已登记 ID 和签名清单，并通过常规 `catalog.list` 公开获准解析器。调用沿用 `action.invoke`、精确会话代次及 Operation 终态，处理器可以从起始游标拉取 Raw，并按上述方式发布派生值。登记随后台运行代次，停用或撤销信任后即从目录退役。图表参考包演示跨事件组帧、来源范围、游标与撤权。 [图表参考包验收](../acceptance.md#图表参考包后台采样)

页面重开按 [快照与订阅](./host-v0.md#快照与订阅) 先拿快照再接续增量，过期 cursor 走公共恢复流程；不能把上代 instanceEpoch 的增量合入新状态。

### 签名主题

主题引用归档完整性清单中的 JSON 文件。每个签名包最多声明 16 个主题，每份资源最多 4096 字节。安装内容校验按原文件摘要读取资源，再对照 `resourceSchema` 和固定的 `{accent: "#RRGGBB"}` 类型。额外字段、CSS、脚本及 URL 均不能作为主题令牌。未签名的包不提供主题。

后台通过 `context.configuration.registerQuery` 或 `registerAction` 登记配置处理器，并通过 `context.contributions.register` 选择主题 ID。`node.themes.list` 以本机 Host 为目标，返回同一活跃登记中已选且仍获准的主题。结果只有包 ID、主题 ID、归档摘要、显示名和颜色。桌面和已配对浏览器使用同一查询，LAN 对端不提供此目录。

共享设置可选的 `nodeTheme` 保存上述两个 ID 与归档摘要，缺省时使用原强调色。仅确切匹配当前列表时应用主题色。离线、撤权、停用或归档变更时回到基础设置，已保存的引用可以由用户重新选择或清除。主题选择沿用共享设置的 revision 校验。

## 5. Web UI 与客户端效果

桌面 WebView 与浏览器加载同一份预构建 UI。UI 在独立受控 iframe 中运行，无 Node、require、process 或 Tauri 全局；隔离文档不能获取任意系统路径、宿主对象或通用原生 IPC。宿主在验证 frame 来源/所属包/版本/页面实例后建立专用消息端口；每个消息校验生成 schema 与当前授权，不能仅信任消息内 actorId。重建 frame 使旧端口失效，迟到消息不能命中新实例。

`node.views.assetRead` 由可信客户端以视图打开 Operation 为 `operation` 目标发送。参数为 `{viewId,offset,path?}`，首次省略 `path` 读取预构建入口。Host 从持久回执取得业务目标，读取前后复核目标代次、当前授权、源操作声明的权限及同一实际插件登记。视图与打开动作均须已登记，旧登记的回执在插件重新激活后失效。只读 `action.check` 使用同一权限与范围校验。

`contributes.views` 的每项可声明 `feed: "derived"`。这类视图可在生产 Operation 运行中打开，等待首个样本，成功后仍可读取已发布的留存和缺口。桌面桥固定生产任务和目标会话代次。省略 `feed` 时，打开动作成功后交付目标会话的 Raw 数据。

回复 `node_view_asset` 绑定包 ID、版本、归档摘要、激活 ID、视图、业务目标、入口与资源路径。路径指向完整性清单中的包内文件。每段最多 32768 字节，offset 为段起点或文件末尾，回执携带总长度与文件 SHA-256。Host 对比构造内容证明时取得的段摘要，客户端拼接后按整文件摘要校验。包资源读取有独立并发预算。

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

三个签名参考包见 [SDK 示例](../../packages/plugin-sdk/README.md)。交付证据见[验证基线](../plan.md#验证基线)，v1 冻结条件见[M3 契约冻结](../acceptance.md#m3-契约冻结)。
