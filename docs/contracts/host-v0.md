# Host v0

本文定义新独立 Host 的 M0 合同，实施阶段与权威来源见 [索引](./README.md)。GUI、CLI、MCP、Node 后台和远端转发调用相同业务 handler；客户端适配器只负责认证、传输、呈现与客户端系统交互。

## Wire 基元与身份

JSON 字段统一 camelCase。`U64` 是 `0|[1-9][0-9]*` 的十进制字符串，范围 `0` 至 `18446744073709551615`；禁止符号、小数、指数、前导零和 JSON number。所有计数、长度、offset、序号、revision、epoch、时间间隔和单调时间均使用 U64。接收端先按字符串校验再转整数；JavaScript 可用 BigInt 计算，再以字符串序列化。溢出返回 `COUNTER_EXHAUSTED`，不回绕。`Timestamp` 是 UTC RFC3339 字符串；仅用于展示/审计，不能代替单调时钟判定期限。

Host 的期限时钟在系统休眠期间继续前进，同一实例的时钟句柄共享时钟域。异步等待最多每 20ms 复查单调期限，期间只读取时钟。启动无法初始化时钟返回 `CLOCK_UNAVAILABLE`；运行期失去可信计时则终止 Host，下一次启动按持久接纳、dispatch 和清线证据恢复。平台来源与换算见[时钟实现](../../crates/host/src/clock.rs)。

`Id` 为非空、最长 128 个 ASCII 字符的不可解释标识，允许 `[A-Za-z0-9._:-]`；Host 生成的实体 ID 用小写 UUID，调用者生成的 `requestId` 也用小写 UUID。`Digest` 是小写 64 位十六进制 SHA-256。字节用标准带 padding Base64；二进制传输可替换载荷编码，但保留相同长度与摘要。缺失表示未提供，`null` 只在字段明确允许时使用。

| 字段              | wire 与作用域                                         | 生命周期                                                                                    |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `hostId`          | Id；一个用户数据配置的 Host 身份                      | 持久保存并绑定身份密钥；复制配置到另一运行身份须重建 hostId/密钥，不能两机冒充同一 Host     |
| `instanceEpoch`   | U64；hostId 内的运行代次，从 `"1"` 起                 | 每次 Host 启动在对外服务前持久递增；无法保存则不接受副作用                                  |
| `protocolVersion` | string；本规范只支持 `"0.1"`                          | 与发行版本分离，握手精确匹配                                                                |
| `catalogVersion`  | U64；当前 Host 注册表全局版本                         | 可用贡献或其契约变化时持久递增；权限过滤不另建业务目录版本                                  |
| `actorId`         | Id；执行 Host 认可的主体                              | 由认证绑定；转发保留始发身份及委托链，正文不能自行声明身份                                  |
| `requestId`       | UUID；同一执行 hostId、actorId、requestContext 内唯一 | 一个逻辑副作用永不换 ID 或上下文重试，也不复用旧 ID                                         |
| `requestContext`  | Host 签发的最长 2048 字节不透明 Base64URL 认证令牌    | 绑定 hostId、actorId、instanceEpoch 和接纳时限，客户端原样透传；作用见去重规则              |
| `operationId`     | Id；执行 Host 内唯一                                  | Host 接纳副作用时创建；跨重启查询不变                                                       |
| `taskContext`     | Host 签发的最长 2048 字节不透明 Base64URL 任务凭据    | 绑定当前实例、父 operation、actor 与执行 owner；只供该 owner 提交子动作，不是外部请求上下文 |
| `childKey`        | U64；同一 parentOperationId 内从 `"1"` 递增           | 一个子动作固定一个键；Host 持久水位阻止回收后的旧键再次接纳                                 |
| `sessionId`       | Id；所属 Host 内的逻辑连接                            | 同物理资源复用；删除后不复用 ID                                                             |
| `sessionEpoch`    | U64；sessionId 内实际打开代次                         | 每次重新取得句柄持久递增；旧代次工作不能进入新连接                                          |
| `revision`        | U64；单一目标资源或状态投影内的提交版本               | 原子提交递增，不能跨资源比较；同 ID 重建不得回退                                            |
| `cursor`          | `{hostId,instanceEpoch,scopeId,position}`             | scopeId 为 Host 分配的状态投影或原始流身份；position 为 U64，表示已消费到的位置             |

`Target={hostId,kind,id,sessionId?,sessionEpoch?}`。`kind` 是已登记的资源种类，基座 v0 值为 `host|device|session|operation|workspace|settings|capture|file|plugin|client`；插件种类使用 `<pluginId>:<name>` 并注册 schema。操作现有会话必须同时传 `sessionId` 与 `sessionEpoch`，二者缺一拒绝。`id` 是 kind 的资源 ID，不接受任意系统路径；Host 本身以 hostId 作为 id。

`ObjectRef={hostId,kind,id,revision?}` 是授权范围内的对象引用，kind 使用 Target 的种类；大结果以 `file` 或业务注册种类返回。引用不携带访问令牌，不自动授予读取权。`RevealTarget={workspaceId?,sessionId?,pageId,panelId?,resultRef?}`：各 ID 是目录登记的 GUI 位置，`resultRef` 为 ObjectRef；`pageId` 必填。handler 校验或补全目录默认位置，客户端不能以定位字段扩大权限。

## 附着、版本与目录

一个数据配置仅允许一个持锁 Host。发现记录只是连接提示，客户端必须完成认证和握手；启动锁由 OS 排他机制管理，不因超时直接抢活锁。Host 健康但暂忙时返回 `HOST_BUSY`，客户端附着同一实例。关闭 GUI 不释放 Host 启动锁。

以下为逻辑 RPC 名，不规定具体 IPC 路径；本地 IPC、同源 HTTP/WebSocket 和 LAN 适配器均按相同 DTO 实现。所有查询经过权限过滤，并产生关联的活动与 revealTarget；内部轮询复用已有活动，不重复导航。

| RPC                  | 输入                                                                                                                                                     | 成功结果                                                                                                               | 特定错误                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `host.attach`        | `supportedProtocolVersions: string[]`、`clientKind: desktop\|browser\|cli\|mcp\|node\|peer`、`clientId: Id`、可选 `expectedHostId: Id`；认证凭据在传输层 | `hostId,instanceEpoch,protocolVersion,catalogVersion,actorId,clientId,limits,requestContext,requestContextAcceptUntil` | `UNAUTHENTICATED`、`HOST_ID_MISMATCH`、`PROTOCOL_UNSUPPORTED`；后者含允许公开的支持版本与升级目标 |
| `catalog.list`       | Query 信封，params 为 `pageSize: U64,pageToken?: string,catalogVersion?: U64`                                                                            | `catalogVersion,items,nextPageToken?`                                                                                  | `CATALOG_CHANGED`、`INVALID_PAGE_TOKEN`                                                           |
| `action.query`       | Query 信封，以 actionId 选择已经登记的 query                                                                                                             | `QueryResult={kind,value}`，value 为该动作的具体领域结果                                                               | 动作 kind、参数、目标或权限不符时拒绝                                                             |
| `action.invoke`      | Call 信封                                                                                                                                                | `operation: Operation`                                                                                                 | 接纳前稳定错误；接纳后通过 Operation 发布结果                                                     |
| `action.invokeChild` | ChildCall 信封，仅供 Host 已派发任务的执行 owner                                                                                                         | `operation: Operation`                                                                                                 | `OPERATION_NOT_RUNNING`、`REQUEST_CONFLICT`、`RESULT_EXPIRED`                                     |
| `operation.get`      | Query 信封，params 选择 `operationId,requestContext?`、`actorId,requestId,requestContext` 或 `parentOperationId,childKey` 之一                           | `operation: Operation`                                                                                                 | `NOT_FOUND`、`RESULT_EXPIRED`                                                                     |
| `operation.cancel`   | Call 信封，target 为 operation；params 为 `reason: user\|revoked\|takeover\|shutdown`                                                                    | 取消请求自身的 operation，结果引用被取消 operation                                                                     | `PERMISSION_DENIED`；已终态时返回现有终态，不改写                                                 |
| `host.shutdown`      | Call 信封，target 为 host；params 为空对象                                                                                                               | 停止请求自身的 operation，结果为 `ShutdownRequested={instanceEpoch: U64}`                                              | `PERMISSION_DENIED`；仅本地用户控制身份的 `auth.manage` 可调用                                    |
| `state.snapshot`     | Query 信封，params 为 `scopeId`                                                                                                                          | `hostId,instanceEpoch,revision,cursor,state`                                                                           | `NOT_FOUND`                                                                                       |
| `state.subscribe`    | Query 信封，params 为 `scopeId,after: Cursor`                                                                                                            | `subscriptionId: Id`，之后增量事件                                                                                     | `CURSOR_EXPIRED`、`EPOCH_MISMATCH`、`PERMISSION_DENIED`                                           |
| `subscription.close` | Query 信封，params 为 `subscriptionId`                                                                                                                   | `closed: true`                                                                                                         | 未存在也返回 closed，不停止业务任务                                                               |
| `object.read`        | Query 信封，params 为 `ref: ObjectRef,offset: U64,length: U64`                                                                                           | 授权载荷及 `revision,length,nextOffset?`                                                                               | `PERMISSION_DENIED`、`REVISION_CONFLICT`、`RESULT_EXPIRED`                                        |

`limits` 必含 `maxRequestBytes,maxPageItems,maxBatchBytes,maxReaderQueueBytes,resultRetentionMs,maxLeaseTtlMs`（均 U64），在 attach 前也对握手限流限长；具体容量由 M1 实测配置并在 handshake 返回。maxLeaseTtlMs 不得超过 `"2147483647"`，时限单位、范围与计时器转换见 [发送回执](./stream-and-operations-v0.md#发送回执)。v0 `resultRetentionMs` 最小值为 `"604800000"`（终态后七天），在途 operation 不因保留期淘汰。超出接纳容量返回 `HOST_BUSY`/`LIMIT_EXCEEDED`，不能先执行再丢去重记录。

目录项必含 `actionId,kind,inputSchema,outputSchema,targetKinds,executionLocation,permissions,stateScopes,eventTypes,cancellation,revealTarget`。`kind=query|action`；`executionLocation=resource_host|client`；`cancellation=none|cooperative`。各 schema 是 JSON Schema 对象，由生成契约/插件注册校验，不能用任意代码字符串替代领域动作。排序按 actionId 字节序；pageToken 是绑定 catalogVersion、actorId、授权版本和过滤条件的不透明字符串；翻页中注册或授权变化返回 `CATALOG_CHANGED`，重取第一页。未安装/停用或未授权的功能不出现在可调用清单中。已知 actionId 的直接调用仍重新校验。

目录 `outputSchema` 描述领域结果；`action.query` 的 `QueryResult` 另加 `kind/value` 判别包装，专用查询 RPC 直接返回领域结果。适配器按真实返回层级声明输出，不能用领域 schema 校验整个包装。`Operation.result` 使用生成的 `ActionResult={kind,value}`；没有任意 JSON 成功兜底。目录摘要变化时在 Host 存储事务内递增唯一 catalogVersion，attach 读取当前版本；相同目录重启不递增。

本地控制连接第一次 `catalog.list` 在读取目录前建立该连接唯一的变化监听：先监听授权变化，再计算当前 actor 经授权过滤、按 actionId 排序后的真实 ActionSpec 摘要。后续仅可见摘要或目录版本变化时投递 `{type:"catalogChanged",catalogVersion,visibilityToken: Digest}`，不携带 actor、授权规则或资源正文；授权变化不递增 catalogVersion。监听同时等待原授权的最早有效单调期限，到期重算；已过期期限不重复触发。通知使用有界单槽合并最新值，连接关闭即结束。MCP 初始化先真实读取目录建立监听，再将该通知转为工具列表变化通知。

`host.shutdown` 在完成持久接纳、派发和 `shutdown_requested` 结果结算后才请求停止接纳，并依次等待可归属任务、设备 owner 与数据库检查点完成，最后释放实例锁。回执表示已持久请求停止，不表示实例已经退出。CLI 等待原 hostId/instanceEpoch 实际结束后才报告该实例停止；已认证请求后的断连不能导致重发。原 profile 的 OS 锁释放可确认停止，发现新 epoch 也可确认旧实例结束，但新实例仍运行时不能报告整个服务关闭。

## 调用、结果与错误

`Query={protocolVersion,hostId,instanceEpoch,actorId,requestId,actionId,target,params,revealTarget}`；`Call` 在 Query 上增加必填 `requestContext: string` 以及可选 `expectedRevision: U64,leaseId: Id,executionMode: interactive|independent`。actionId 为目录稳定 ID；params 为该动作输入 schema 的对象。外部副作用使用 Call，已接纳任务的子动作使用下述 ChildCall；查询的 requestId 只关联活动，不建立副作用去重。会话修改、设置与工作区保存必须带 expectedRevision；无需 CAS 的动作由目录 schema 明确声明。

未提供 executionMode 时规范化为 interactive；独立 capture/发送回放等任务须显式传 independent，handler 拒绝不支持的模式为 INVALID_ARGUMENT。target.hostId 必须等于执行 hostId；target.kind=session 时 id 必须等于 sessionId，不能利用两个不同字段选择不同资源。

hostId/instanceEpoch 指执行 Host，不是入口转发 Host。执行端校验真实认证 actorId 后再校验信封；不一致返回 `ACTOR_MISMATCH`。若请求曾接纳，允许在当前实例以原 actor/request 查询旧结果；旧 epoch 的 action.invoke 始终拒绝，不能利用去重绕过代次校验。断线后的正确流程是 attach、operation.get，然后决定是否提出新的明确操作。

```json
{
  "protocolVersion": "0.1",
  "hostId": "11111111-1111-4111-8111-111111111111",
  "instanceEpoch": "7",
  "actorId": "22222222-2222-4222-8222-222222222222",
  "requestId": "33333333-3333-4333-8333-333333333333",
  "requestContext": "ZXhhbXBsZS1ob3N0LWlzc3VlZC10b2tlbg",
  "actionId": "session.tx",
  "target": {
    "hostId": "11111111-1111-4111-8111-111111111111",
    "kind": "session",
    "id": "44444444-4444-4444-8444-444444444444",
    "sessionId": "44444444-4444-4444-8444-444444444444",
    "sessionEpoch": "9007199254740993"
  },
  "params": { "bytesBase64": "DQo=", "writeWaitMs": "1000" },
  "executionMode": "interactive",
  "revealTarget": { "pageId": "workbench", "panelId": "terminal" }
}
```

示例 requestContext 仅为编码占位，真实调用须使用执行 Host 签发值。

`Operation` 必含 `operationId,executionHostId,actorId,requestId,admission,rootOperationId,childHighWatermark,actionId,target,executionMode,state,revision,revealTarget,acceptedAt,owner`。`admission` 是判别联合：根请求为 `{kind:"request",requestContextDigest: Digest}`，子动作为 `{kind:"child",taskContextDigest: Digest,parentOperationId: Id,childKey: U64}`，不能把 taskContext 摘要放进 requestContextDigest。根的 rootOperationId 为自己的 operationId；子动作沿用父的 rootOperationId。childHighWatermark 初值 `"0"`，记录该 operation 已接纳的最大 childKey。令牌本身不进入公开活动。`acceptedAt` 为 Timestamp；owner 是 `{kind: host|plugin, id: Id, version?: string}`，表示负责结算的 handler/插件版本；依赖用 `dependencies: [{id,version,digest}]` 固定。可选字段为 `startedAt,settledAt,resultExpiresAt`（Timestamp）、`progress`、`result`、`error`。`progress={completed: U64,total?: U64,unit: string}`；`result` 是动作 schema 定义的内联结果或 `{resultRef: ObjectRef}`。输入持久保存为受限记录或 ObjectRef，并记录参数摘要，不把敏感输入复制到公开活动。

state 的全部 wire 值与允许转移见 [操作结算](./stream-and-operations-v0.md#操作结算)。`partial` 是具体结果 outcome，不是 Operation 状态；已结算的部分 TX 可为 `succeeded` 且 outcome=partial。调用者必须读取领域结果，不能把 succeeded 解释为完整发送。

RPC 外层为 `{ok:true,result}` 或 `{ok:false,error}`。`Error={code,message,retryable,details?,operationId?,revealTarget?}`；message 为已脱敏的人类说明，调用者按 code 处理。details 必须符合该错误的 schema，不能放原始异常、路径或正文。retryable 只表示条件改善后可重查/重试当前逻辑请求，不能生成新 requestId 自动重发副作用。

基础 code：`INVALID_ARGUMENT`、`UNAUTHENTICATED`、`ACTOR_MISMATCH`、`PERMISSION_DENIED`、`HOST_ID_MISMATCH`、`PROTOCOL_UNSUPPORTED`、`HOST_BUSY`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`UNSUPPORTED_CAPABILITY`、`EPOCH_MISMATCH`、`REVISION_CONFLICT`、`REQUEST_CONFLICT`、`RESULT_EXPIRED`、`OPERATION_NOT_RUNNING`、`COUNTER_EXHAUSTED`、`CATALOG_CHANGED`、`INVALID_PAGE_TOKEN`、`CURSOR_EXPIRED`、`CLIENT_REQUIRED`、`FUTURE_FORMAT`、`STORAGE_UNAVAILABLE`。领域错误由 [流与操作](./stream-and-operations-v0.md) 增补。冲突 details 只返回调用者有权看的当前版本/状态；未授权对象统一返回 PERMISSION_DENIED，不泄露是否存在。

## 去重与持久状态

Call 的去重键为 `(executionHostId,actorId,requestContextDigest,requestId)`；记录同时绑定 actionId、Target、executionMode、expectedRevision、leaseId 和规范化 params 的 Digest。规范化在 Rust schema 校验并补齐默认值后执行：对象键按 UTF-8 字节序，数组保持顺序，字符串按 JSON 转义且不做 Unicode 归一化，U64 保持十进制字符串；v0 参数内普通 JSON number 仅允许有限且精确的安全整数，其他数值用 schema 规定的十进制字符串。revealTarget、连接凭据、活动展示字段不进入摘要；语义不变的透明转发保留整个 Call 的请求身份，不把已接纳操作内部的新动作伪装为原请求。

Host 在 attach 签发带认证码的 requestContext，内部绑定 hostId、actorId、当前 instanceEpoch、随机上下文 ID、签发 keyId 和源端单调接纳截止点。v0 接纳窗口为 `"86400000"` ms（24 小时），requestContextAcceptUntil 是仅供展示的 Timestamp。请求上下文不授予权限；仍须当前传输认证。新任务可通过再次 attach 获取新上下文，重试旧任务必须携带旧上下文，不能重新标记为新任务。

1. 校验权限、epoch、schema 和容量后，持久写入 queued 接纳记录及唯一键；失败返回 STORAGE_UNAVAILABLE，副作用为零。
2. 相同键与相同摘要返回同一 operationId，不再次排队；不同目标、参数、租约或执行模式返回 REQUEST_CONFLICT，原任务不变。
3. handler 在首次副作用前持久标记 running/dispatch 意图，完成后持久写回回执再发布终态。恢复时 queued 且确定未 dispatch 的工作标 interrupted；有 dispatch 意图但缺少可靠回执标 unknown，并保留已知接受范围。绝不自动重发。
4. 终态结果至少保留 attach 宣告的期限。正文到期后可用 tombstone 保留去重键、摘要、operationId、终态分类和到期时间；只有接纳窗口仍有效时才需保留 tombstone。有效上下文中同参返回现有 O/RESULT_EXPIRED，异参返回 REQUEST_CONFLICT。
5. 上下文到期后 action.invoke 返回 RESULT_EXPIRED，即使结果仍保留也不接纳重发；调用者改用 operation.get。已过期上下文且终态保留期已满时可回收全部结果和 tombstone，不要求永久历史索引。在途 Operation 永不按上下文期限淘汰；其执行/取消/结算继续，结算后再起算结果保留期。
6. requestContext 绑定 instanceEpoch，Host 重启后旧上下文一律到期；旧操作仍可查。运行内按源端单调时钟检查截止点，墙钟回拨不延长窗口。签发 keyId 不复用，退休/未知 keyId 一律不接纳；不把未知 key 当新上下文。旧 key 可在本实例所有相关接纳窗口结束后回收，因为过期上下文没有接纳路径。当前 key 上伪造认证码返回 UNAUTHENTICATED，退休/未知 keyId 返回 RESULT_EXPIRED；两者均零副作用。

本规范选择有期限接纳上下文和窗口内持久去重，保证历史可回收且旧请求不能重新执行。operation.get 先找持久记录；存在则按当前权限返回，令牌到期不妨碍查询；不存在且给出了旧/退休上下文时返回 RESULT_EXPIRED（表示已无法从保留记录确定原结果，不表示未执行）。未带上下文且 operationId 未找到返回 NOT_FOUND，不能据此重发。备份恢复必须保留去重记录与实例代次；无法证明旧运行身份已退出或代次不回退时，恢复为新 Host 身份并重新配对。副作用结果 unknown 保持到结果保留期限，后续证据通过 revision 追加核实记录；不改写历史 TX，不把 unknown 自动变成未执行。

设置/工作区/插件公开配置分别拥有格式版本与 revision，按 expectedRevision CAS 原子替换。格式校验、迁移与备份失败保留原件；未来格式普通保存返回 FUTURE_FORMAT。持久布局是模板，运行队列/租约不从模板恢复执行。共享提交先持久化再发布对应 revision；客户端草稿冲突保留并由用户合并。

## 父任务与子动作

Host 将已接纳 operation 派发给 owner 时，签发 taskContext，绑定执行 hostId、instanceEpoch、parentOperationId、rootOperationId、actorId、executionMode 和本次 owner 实例。凭据只交给该执行上下文，不能从公开 Operation 取回，也不能通过提交 parentOperationId 自行领取。它证明任务归属，权限仍取当前调用者授权、插件授权与父任务受控 scope 的交集；Host 在子动作接纳与实际副作用前分别复核。

`ChildCall={protocolVersion,hostId,instanceEpoch,actorId,taskContext,parentOperationId,childKey,actionId,target,params,revealTarget,expectedRevision?,leaseId?}`。parentOperationId 为 Id，childKey 为从 `"1"` 起的 U64，其余类型沿用 Call；子动作不能自选 requestId、requestContext、rootOperationId 或 executionMode。执行 Host、actor 与执行模式继承父任务，target.hostId 必须是该执行 Host；透明 LAN 转发原样携带此信封。Host 为新子动作分配自己的 requestId 与 operationId，并写入 `admission.kind="child"`。相同字节的两次有意发送也必须使用不同 childKey。

接纳按父 operation 串行执行，业务执行可以并行：

1. 父任务必须仍为 running，taskContext 必须属于当前 epoch 和仍在执行的 owner。取消请求、停用、撤权或父结算先关闭新子动作接纳；分别返回 OPERATION_NOT_RUNNING 或 PERMISSION_DENIED，不推进水位。父停止后查询旧子项改用 operation.get，不以 invokeChild 续活父任务。实例变化返回 EPOCH_MISMATCH。有效 taskContext 不因根 Call 的 24 小时接纳窗口届满而失效；独立任务超过该窗口仍可提出新的子动作，但不能借此重发根请求或复活已停止父任务。
2. 去重键为 `(executionHostId,parentOperationId,childKey)`，摘要绑定 actor、owner、actionId、Target、executionMode、expectedRevision、leaseId 和规范化 params。已保留键同参返回同一子 Operation，异参 REQUEST_CONFLICT；父 Call 的同参重试只返回父 Operation，不再次派发插件或遍历重建子动作。
3. 新键必须等于 childHighWatermark+1。Host 在同一持久事务中写入 queued 子记录、父水位及其新 revision，失败均不提交，零副作用。大于下一键的乱序请求返回 INVALID_ARGUMENT，不能跳号；小于等于水位但记录已回收时返回 RESULT_EXPIRED，不能接纳为新任务。SDK 串行等待每次接纳结果；响应丢失先按 `(parentOperationId,childKey)` 查询或用同键重试，确认后才分配下一键。已接纳子任务可同时执行，队列/在途容量继续受 Host 限额约束；容量不足不消耗键。
4. 子动作和根动作遵循相同 dispatch/回执/unknown 规则。查询可用 operationId 或 `(parentOperationId,childKey)`，按当前读取权限返回；后者在父记录存在且键已回收时返回 RESULT_EXPIRED。父记录也已回收时返回 NOT_FOUND，不能据此重发。子终态结果按各自 settledAt 保留至少 resultRetentionMs；回收子记录前把必要结算事实原子归并到父的有界摘要，包含是否存在未知副作用。父只需保留一个水位及在途/保留期内的子记录，不要求永久逐子项 tombstone。
5. 父取消会请求停止全部已接纳未终态子任务，并在各子动作真正 dispatch 前再次检查取消与授权。已发生效果仍按各自回执结算；父须等全部已接纳子任务终态后才能结算，不能遗留脱离父任务的运行子项。任一子项有 unknown 副作用时父也结算为 unknown，不能被结果到期掩盖；确定的部分/失败由父领域结果如实汇总。Host/owner 重启不重新执行父或子任务；已有子结果只查询，不以新 childKey 自动补发 unknown。

## 快照与订阅

`state.snapshot` 在线性化点 S 返回状态及 cursor C；增量订阅 `after=C` 只返回严格晚于 S 的提交。读取快照与开始订阅之间的事件从有界历史补齐，不能要求客户端依赖碰巧及时的监听注册。`Delta={cursor,previousCursor,revision,eventType,payload}`；同一 scope 内串行且 cursor 单调，previousCursor 是同订阅上一次投递位置。状态字段与该 scope 的 revision 在一次提交内更新。

客户端忽略 cursor 已处理的重复事件，遇到 previousCursor 不匹配停止应用并重新取快照；不可把后到的旧 epoch 消息混入当前状态。历史不足返回 CURSOR_EXPIRED，details 提供 `scopeId,oldestCursor,snapshotRequired:true` 和已授权的 `captureRef?`；快照重新建立状态，录制补读用于原始数据完整性。原始流的真实缺口使用 Gap，见 [事件模型](./stream-and-operations-v0.md#原始事件与独立-reader)。

每个 subscriptionId 独立队列与限额。投递后再撤权的历史记录不能撤回；服务端立即停止后续敏感输出，清空未投递队列并结束订阅为 PERMISSION_DENIED。重建订阅与引用读取均复核授权。多资源快照只有显式同 scope 的提交才原子，不提供跨 Host 全局顺序。

`session:<sessionId>` 状态 scope 在会话重新打开后保持 ID 和递增 revision。新 sessionEpoch 的 Target、状态与 revision 在一次提交中更新；旧订阅清空并以 `EPOCH_MISMATCH` 结束，早于这次提交的游标返回 `CURSOR_EXPIRED`。客户端重新取得快照后接续，新代次授权不能读取旧代次历史。

本地增量消息为 `{type:"delta",subscriptionId,delta:Delta}`。错误终止使用 `{type:"subscriptionEnded",subscriptionId,error}`；错误只含稳定 code 与固定说明，不含正文、引用或 details。终止通道只允许本连接已登记的订阅，即使正文权限已撤销也能报告终止；若连接队列连终止通知也无法容纳，则关闭连接，客户端重新附着并取快照。显式 `subscription.close` 返回 `closed:true`，不存在时同样返回；它不停止 Host 业务。队列和历史同时按条数、字节限制，溢出清空该订阅正文并通过独立终止槽报告 `CURSOR_EXPIRED`，不静默跳过增量。

`host.activity` 与 `host.operations` 的公共投影仅发布明确元数据，禁止携带 Call.params、credential、完整 Operation.result 或 error.details。查询活动按 actorId/requestId 复用，当前 Host 保留最多 1024 条最近活动；操作投影从持久 Store 读取最多 256 条在途优先的近期记录，完整保留结果仍通过 operation.get 按当前原始资源权限查询。

## 本地 IPC 与用户控制

本机传输使用四字节大端长度和 UTF-8 JSON，帧体为 `WireFrame {requestId,channel,body}`。`channel` 为 `control/raw/state`，`body.type` 选择生成的消息类型；先检查 1 MiB 长度上限再读取正文。只有完整帧边界的 EOF 表示正常关闭，半帧、非法 UTF-8/JSON 或未知字段均拒绝。公共类型由 core 导出，平台连接、受保护秘密与有界帧 IO 由共享 IPC crate 实现。

Windows 使用当前用户 SID 的显式 DACL、拒绝远程连接的 named pipe，并检查真实 peer 的进程 token SID；Unix 使用私有 0700 runtime 目录、0600 socket 和真实 peer UID。实例锁覆盖整个 Host 生命周期；PID、文件年龄和发现记录不能代替锁。只有持锁的 Host 能准备遗留 endpoint 并原子发布发现记录，记录包含身份、epoch、endpoint、PID 和协议版本，不包含秘密。

客户端先发送 nonce，验证绑定协议版本、hostId、epoch 和双方 nonce 的 Host proof，再提交自己的凭据。身份 pin 从受保护本地存储取得，不能从发现记录自建信任。新外部客户端只注册元数据身份；已有 clientId 的错误或缺失凭据不能覆盖原授权。控制连接与原始流连接分开，raw attach token 绑定活控制连接、actor 和 epoch；控制连接结束后 token 失效。Host 分配的 connectionId 只用于连接资源和投递归属，不进入 Call 或去重身份。同 actor 的另一连接退出不能清除本连接订阅，也不能停止 Host 业务任务。

`authenticate` 使用普通客户端凭据，`authenticateUserControl` 使用独立的本地用户控制 capability；选择消息类型或声明 desktop/CLI kind 都不授予权限。Host pin、普通凭据和用户控制 capability 相互独立。用户控制 capability 只从明确的本地用户入口取得，不由普通 IPC 领取；内部启动通过专用继承 stdout pipe 传递四字节大端长度和 1—2048 字节 capability，常规启动不输出 capability。秘密不进入 argv、URL 或日志；Windows 用 current-user DPAPI，Unix 用当前用户私有文件保存。

通用 action.query 与专用 RPC 共用 actionId 到物理通道的映射：stream.read/subscribe/credit 只能走 raw 连接，其他控制请求不能经 raw 执行；专用 method 与信封 actionId 必须一致。state 订阅按 connectionId/channel 归属，连接关闭后才完成的订阅创建也必须立即释放。Host 持有从持久接纳开始的任务；关闭时停止连接并等待这些任务结算后才释放实例锁。

## 权限、客户端与 LAN

授权由用户控制入口建立，作用域包含执行 Host、workspace/资源、actor、有效期及具体能力。初始外部客户端仅有 `metadata.read`（元数据/限量脱敏摘要）；`content.read`（原始流、日志/文件正文）、`device.modify`（已登记设备操作）、`code.execute`（任意 JS/TS/外部命令）、`plugins.manage` 各自授予；工作区/设置修改用目录独立权限 `workspace.modify`/`settings.modify`。普通设备授权不能运行自由代码，可信插件的 OS 执行信任也不替代代理调用者的 API 权限。

`auth.manage` 仅供本地用户控制身份使用，不能授予普通 API actor。本地用户授予的 `expiresAt` 在当前实例转换为单调截止点，墙钟回拨不延长授权。有限期授权不跨 instanceEpoch 续租，Host 重启后需重新明确授权；未设置期限的授权保留并逐次复核。授权和撤销持久提交成功后再更新可用范围，旧 actor、引用和排队事件不能保留已撤销的权限。

结果、快照、progress、事件、错误 details、ObjectRef 与导出内容统一按当前授权过滤；引用读取逐次复核。导入/生成/打开项目只准备数据，不自动执行。秘密只显示 Secret 引用；设备内容、终端序列、导入文件和插件输出带来源标记，不能建立授权。注册动作预先声明权限，handler 在接纳与实际副作用前复核。

共享状态包括连接、配置、任务、工作区与插件公开业务。导航、焦点、滚动、编辑草稿、跟随状态和窗口布局实例属于 clientId。所有功能（含查询）有 revealTarget；查询轮询更新原活动。暂停跟随只改变导航，人工接管撤销该 AI 对目标的新修改、取消排队写入并结算在途工作。窗口/剪贴板动作必须指定 client target；不存在具备能力的客户端返回 CLIENT_REQUIRED，details 为 `requiredCapabilities: string[]`，后台业务继续可运行。

本地 IPC 仅当前 OS 用户可访问。浏览器由 Host 同源提供页面/API，默认仅绑定 loopback，校验 Host header、Origin 与 WebSocket 握手身份；无 Origin 的非浏览器客户端走独立认证入口，不能借缺省 Origin 绕过浏览器检查。首次配对经本地可信用户入口确认，凭据不放 URL/日志；具体凭据存储与轮换在 M2 传输实现验收。

LAN 入口显式启用，配对绑定 Host 密钥身份并使用认证加密链路，发现广播不建立信任。B 唯一持口；A 转发 actorId/requestId 与执行 B 的 target/epoch，B 依据受验证的委托链和自身共享权限取交集。时序敏感工作固定 B，通用派生可在 A；Operation 的 executionHostId 与依赖版本创建后不迁移。文件先经受控传输在 B 建立 ObjectRef，禁止把 A 路径当 B 路径。A GUI 关闭不等于 A Host 失联；交互租约与独立任务分别按 [租约合同](./stream-and-operations-v0.md#会话与租约) 结算。

## Host 验收向量

下表均使用当前已授权 actor；“零副作用”指未新增设备写入/配置变更，不妨碍记录诊断活动。

| ID  | 输入前态                                                                 | 动作                                                             | 可见结果与副作用                                                                                               |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| H01 | Host epoch=`7`，sessionEpoch/revision/cursor.position=`9007199254740993` | JSON 编解码、生成绑定与 Node SDK 往返，再加一                    | 字符串完全相等，加一为 `9007199254740994`；number/指数/前导零拒绝，零设备副作用                                |
| H02 | actor A 的请求 R 已接纳 operation O，最终字节 `0D0A`                     | 同 R 同参并发/断线重试；再同 R 改为 `0A` 或换 target             | 同参均 O、只一次实际 TX；异参 REQUEST_CONFLICT，O 不变                                                         |
| H03 | O 已终态超过保留期，上下文过期，正文/tombstone 已回收；Host 重启         | 原上下文同 R 同参/异参，按 O+旧上下文查询                        | 均 RESULT_EXPIRED，零新 TX；有效窗口内异参仍按 H02 拒绝                                                        |
| H04 | Host epoch 从 `7` 到 `8`，session 从 `2` 到 `3`                          | 用旧 Host epoch invoke，再用当前 Host/旧 session epoch invoke    | 均 EPOCH_MISMATCH；当前 epoch 可查询旧 O；旧队列不进入新句柄                                                   |
| H05 | snapshot 在 C=`10` 返回，订阅前已有 `11`,`12`                            | subscribe after 10；重复投递 11；另以已淘汰的 1 订阅             | 依次得到 11/12，重复不重复应用；旧游标 CURSOR_EXPIRED，重取快照；无静默跳过                                    |
| H06 | actor 可读原始内容，已取得 resultRef，敏感事件尚在队列                   | 用户撤销 content.read，再读取旧引用/取快照/轮询错误结果          | PERMISSION_DENIED 或脱敏投影，无正文/路径泄漏；未投递敏感队列清除                                              |
| H07 | 已配对 A/B；B epoch=5；B 有独立原始录制                                  | A 传 B 的 action、同 requestId；A 用本地授权尝试 B code.execute  | 普通许可动作在 B 执行，身份不变；未授 B 代码权限拒绝，录制继续                                                 |
| H08 | 目录 V 的第一页已读；插件安装或授权变更                                  | 使用旧 pageToken 读取下一页                                      | CATALOG_CHANGED，重取目录按 actionId 稳定排序；不遗漏或重复偷偷拼页                                            |
| H09 | 设置 revision=4，客户端草稿基于 3；存档为未来格式                        | 分别提交旧 revision、普通覆盖未来格式                            | REVISION_CONFLICT/FUTURE_FORMAT，原件与草稿保留；队列不从配置恢复                                              |
| H10 | 设备写权限存在，代码权限不存在；无 GUI 客户端                            | 调用已登记 TX、自由脚本、剪贴板写入                              | TX 按范围接纳；脚本 PERMISSION_DENIED；剪贴板 CLIENT_REQUIRED；三者不相互授权                                  |
| H11 | 上下文 X 已过期且记录已回收；另一长任务仍 running                        | 墙钟回拨 48h、重启 Host，再用 X invoke；查询长任务               | X 始终 RESULT_EXPIRED，后端写计数不变；新 epoch 才签发新上下文，长任务按恢复证据 interrupted/unknown，保留可查 |
| H12 | 插件父 P 已接纳，水位为 0，具有三次 TX 的受控授权                        | 依次接纳 childKey=1/2/3 发送 01/02/03；重复第二键；再重试父 Call | 各产生不同子 O，三个 TX 各一次；重复第二键返回同 O，异参 REQUEST_CONFLICT；父重试不再派发，root/parent 可查    |
| H13 | P 水位为 0，SDK 两个接纳请求发生乱序                                     | 先发 childKey=2，再发 1；1 的响应丢失后同键查询/重试，再发 2     | 首次 2 INVALID_ARGUMENT 且无副作用/水位不变；1 只接纳一次，再接纳 2；业务可并行，不把未接纳键视为已执行        |
| H14 | independent P 已运行 25h，根 requestContext 过期，taskContext 当前有效   | 接纳下一子 TX；撤销 actor 或插件 device.modify 后再提交下一键    | 首次按现有 scope 接纳，根请求仍不可重发；撤权后 PERMISSION_DENIED、水位不变，已排队未 dispatch 的效果停止      |
| H15 | P 仍 running，水位为 100；键 1 的子结果已过保留期并回收                  | 同键 1 同参/异参 invokeChild；再发键 101                         | 键 1 均 RESULT_EXPIRED、零重发；键 101 可接纳；仅一个持久水位阻止旧键复活，不需永久子历史索引                  |
| H16 | P 有一个已接纳在途子 TX，另一子项已结算 unknown                          | 取消 P 提交成功后再请求第三个子动作；查询父子并等待清理          | 新接纳关闭，未 dispatch 的子项停止；在途回执保留，全部子项终态后 P 为 unknown，根/子 ID 均不自动补发           |
