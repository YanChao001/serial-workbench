# 流与操作 v0

本文使用 [Host v0](./host-v0.md) 的 U64、Target、ObjectRef、Call、Query、Operation 与错误信封。所有新增字段遵守其编码规则；本文的范围/序号均是十进制字符串，区间统一左闭右开 `[start,end)`。

## 会话与租约

设备使用 `{hostId,deviceId}` 命名空间，Host 对实际物理设备建立一个持口锁和一个 sessionId。系统串口句柄由 Rust 持有；插件 TransportProvider 可持自身后端句柄，但逻辑连接、租约、TX 和关闭责任仍归 Host。两个客户端同时 `device.open`，Host 在同一锁下检查并打开一次：相同配置附着既有会话；不同配置返回 `CONFIGURATION_CONFLICT` 和可读的当前 revision，不能静默重配。标签克隆复制视图配置，同端口复用同一会话；仅脱离视图不会关闭连接。

Session 投影包含 `sessionId,deviceId,sessionEpoch,revision,configurationRevision,state,configuration,readOnly,txGate,controlState,capabilities,lease?`。`state=closed|opening|open|disconnected|closing`；打开成功进入 open 并发布新 sessionEpoch，失败回 closed/disconnected 且保存稳定错误。连接重开先完成上代关闭/清线结算，再递增代次，不自动重放旧队列。`txGate=ready|configuration_pending|control_unknown|closing|disconnected`；gate 非 ready 拒绝新 TX。capabilities 按真实后端声明字段配置、信号、队列、drain、purge、有限 BREAK、流控、时间精度与报文语义；不支持的能力返回 UNSUPPORTED_CAPABILITY，不伪造成功。

普通发送也经过仲裁，但无需独占持有整个观察会话。Host 为单次普通动作创建内部 `ordinary` 调度占用，确保一次 TX 提交的字节不与其他发送穿插；其余调用者只能观察/排队。显式租约类型为 `transaction`（发出至响应/超时全过程）和 `exclusive`（传输/工具任务全过程）；两者互斥且阻止普通 TX、配置和控制线插入。观察者和 reader 不获得写权。

`Lease={leaseId,sessionId,sessionEpoch,actorId,ownerOperationId,kind,state,executionMode,expiresAtMonoNs}`，kind 为 `ordinary|transaction|exclusive`，state 为 `active|revoking|released|expired`。`expiresAtMonoNs` 是资源 Host 的单调时钟 U64，不可拿 A 的时钟比较 B 的期限。Lease 由 Host 创建，不能客户端自造。

| 动作 ID            | params                                    | 结果/语义                                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `device.open`      | `configuration: SerialConfiguration`      | `sessionId,sessionEpoch,revision,reused: boolean`；相同资源/config 并发只开一次 |
| `session.close`    | 空对象                                    | 等待句柄、在途写入及清线结算后返回最终 session 状态                             |
| `lease.acquire`    | `kind: transaction\|exclusive,ttlMs: U64` | Lease；需要 device.modify；目标 epoch 与 txGate 检查                            |
| `lease.renew`      | `leaseId,ttlMs`                           | 当前 Lease；只允许同 actor/owner 与 active 租约，不能续活已失效租约             |
| `lease.release`    | `leaseId`                                 | 先结算在途工作，再 released；未完成清线不释放为可写                             |
| `session.takeover` | `actorId,reason: user`                    | 由有控制管理权限的用户操作，撤销指定 actor 对该会话的修改权并返回结算状态       |

接管只撤销指定 actor 对该 session 的 `device.modify`，取消并等待其排队、执行和持租操作真实结算；其他 actor 的任务继续。接管不以 clientKind 推定身份。明确重新授权只允许新请求，旧授权代次下的排队操作不会复活。

显式 acquire 自身 operation 成为 ownerOperationId，并在持租期间 running；释放/过期完成后才结算。普通动作 operation 为自己的 owner。独立任务 handler 可在内部申请租约，ownerOperationId 固定任务 ID。租约 TTL 与操作 deadline 分别控制控制权和业务时限。续租 TTL 必须受 Host 协商上限约束，租约既在入队也在真正提交后端前检查，权限/epoch 同时复核。

交互执行 `executionMode=interactive` 依赖发起 Host 的续租；A Host 失联后 B 到期将 active→revoking，终结未开始 TX，为已开始的写入请求合作取消，结算后 expired。独立执行 `executionMode=independent` 在 B 接纳后由 B 的任务负责人续租，A 断网不取消；创建时向用户显示执行 Host 和断网行为。B 撤销共享/人工接管均停止该远端 actor 新修改并取消其在途独立任务，按真实取消点结算；B 本地独立任务继续。

租约过期或释放不是副作用回滚。清线/后端取消无法确认时，任务发布 unknown 并把资源置 control_unknown；租约可以完成账面结算，但 session 的隔离 gate 不开放，接管者不能立刻写入。关闭共享只释放远端权限，仍有本地使用者的连接/录制保持。恢复跟随和重新授予控制是独立动作，已终结旧队列不复活。

隔离后的显式 `device.open` 是新操作：控制线必须 clear，本进程存在旧 owner 时先确认实际清理和线程退出，再实际独占打开并完整配置新 sessionEpoch；持久隔离记录在新打开成功前保持。原未知操作仍为终态，历史与未知范围不改写，也不补发；后台自动重连不能借此解除隔离。

## 操作结算

Host 是 Operation 记录权威，owner 指定执行 handler 或受监督插件任务，取消由 owner 结算。客户端 AbortSignal、传输超时、关闭标签只停止调用者等待/订阅；调用 `operation.cancel` 才发出合作取消请求。插件停用必须停止接纳并结算其可归属任务，Rust 自持原始采集不随插件 UI 关闭。子动作使用 [父任务与子动作](./host-v0.md#父任务与子动作) 的 ChildCall 和 admission，父取消关闭新接纳并请求取消全部在途子项；父在已接纳子项全部终态后才结算，未知子效果传播为父 unknown。

| state              | 含义                                           | 允许后继                                                  |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| `queued`           | 接纳记录已持久化，尚未进入副作用执行           | running、cancelled、interrupted                           |
| `running`          | 负责人正在执行，可能已有副作用                 | cancel_requested、succeeded、failed、interrupted、unknown |
| `cancel_requested` | 取消信号已交给负责人，尚未完成结算             | succeeded、failed、cancelled、interrupted、unknown        |
| `succeeded`        | 负责人取得可确定的领域结果                     | 无；仍须检查领域 outcome/接受范围                         |
| `failed`           | 已确定失败，结果保留此前已知副作用             | 无                                                        |
| `cancelled`        | 负责人已停止剩余工作并完成清理                 | 无；结果保留取消前的发送/写盘事实                         |
| `interrupted`      | 重启/worker 消失中断任务，已知副作用均已记录   | 无；有未确定副作用必须用 unknown                          |
| `unknown`          | 执行已停止或失去负责人，至少一段副作用无法确定 | 无；追加核实证据，不能重新执行原请求                      |

后五种为结算终态。终态不可回 queued/running，复核作为关联的独立查询/操作记录，原历史保留。unknown 是已结算的不确定结果，不是可安全重试信号。cancel_requested 不提前释放句柄、租约或 worker 配额。取消与完成竞态以负责人的真实回执定终态；取消到达前已完成仍 succeeded。

进行中的 TX 可先持久化尚未知晓范围的恢复证据；即使此时 result 含 unknown 范围，queued/running/cancel_requested 仍未结算。客户端以 Operation 实际终态决定结果告警，不能提前把该恢复证据当作发送未知或失败。

Host 重启核对持久接纳/dispatch/回执记录，把未完成任务标 interrupted 或 unknown；自动发送不恢复运行。Node 主宿主崩溃终结其任务；Rust 原始采集继续。插件自持连接报告 disconnected，恢复产生新 sessionEpoch。完整退出 Host 先停止接纳、协商/结算各 owner 再退出；无法清理的状态持久记录，下一启动保持相应 gate 并提示恢复。

## 原始事件与独立 reader

`TransportSemantics=stream|message`。stream 后端读块只是采集块，不是协议帧/文本行；message 保留后端消息边界及类型。消息发生拆分时使用 `messageId,fragmentOffset,messageLength,messageType`，前三项分别 Id/U64/U64，messageType 为后端 schema 枚举；WebSocket 文本/二进制与 UDP 报文不能在传输中被混成无边界流。

`RawEvent={hostId,instanceEpoch,sessionId,sessionEpoch,eventSeq,configurationRevision,kind,time,payload}`。eventSeq 在 sessionEpoch 内从 `"1"` 连续递增；kind 的全部 v0 值为 `rx|tx_intent|tx|gap|configuration_boundary|lifecycle|control`。configurationRevision 指该事件采集/提交时最近完成的配置尝试 revision；即使结果不确定也推进，并在 boundary 中标明 uncertain。Session.configuration 保留最后完整确认的值，不把该对象冒充为不确定期间的实际配置。

`time={clockId,sourceMonoNs,sourceWallTime?,receivedWallTime,precision}`；clockId 为源 Host 的 instanceEpoch 时钟域 Id，sourceMonoNs 为 U64，sourceWallTime/receivedWallTime 为 Timestamp。precision 含 `source: host_read|device|line_capture|sample_clock,resolutionNs: U64,syncMethod: string`；可选 `offsetEstimateNs` 为有符号十进制字符串、`offsetErrorNs,rttNs` 为 U64。源/接收墙钟仅用于展示，顺序由源 eventSeq 决定；A 转发 B 事件不替换其源时间，可在副本元数据追加本机接收时间。离线波形另带 `sampleClockId,sampleStart,sampleEnd,sampleRateHz`，sampleRateHz 为 schema 校验的正十进制字符串，不伪装成主机读块精度。

RX payload 为 `{bytesBase64,byteStart,byteEnd,message?}`，区间是当前 sessionEpoch、RX 方向的逻辑字节流位置，按完整后端接收长度推进。采集块拆为至多 16 KiB 的 RX 记录，完整保留尾部和 message 分片位置。

TX 意图 `tx_intent` 的 payload 为 `{operationId,bytesBase64,byteStart,byteEnd}`。Host 在持久接纳 New 前预留发送队列、最终字节及结算元数据容量，预留不占 eventSeq 或 TX offset；仅 New 后立即提交最终意图。合法预留遇到源终止仍保存不可变意图与最终审计回执，但不能恢复源、旧 epoch 或 I/O 权限；失败或重复请求释放预留。只有意图按完整字节长度推进 TX 方向 offset。最终 `tx` 的 payload 为 [发送回执](#发送回执)，按 operationId 关联意图，保留同一最终字节和区间并取得自己的后续 eventSeq；它不再次推进 offset 或重复计入发送字节。接受范围可以是意图的子集，未知范围不伪装成已发送。意图和回执均为不可变源事件，晚到回执不覆盖原序号，未结算意图不阻塞后续 RX。方向各自计数，不跨 RX/TX 混用 offset。

RawEvent 的源端 gap payload 为 `{reason,missingEventRange?,missingByteRange?,direction?,knownExtent}`。reason 为 `network_loss|backend_loss|purge|source_unknown`，表示源 Host 观察到的后端缺失或清空；range 均为 `{start,end}`，byte range 还带 `direction: rx|tx`；knownExtent 为 boolean。可确定范围必须填写；设备只报告溢出但丢失量不可知时 knownExtent=false，不捏造序号/字节数。这条 gap 自身拥有正常的源 eventSeq，不为未观察到的后端字节虚构 RawEvent。

读者丢失使用独立 `ReaderGap={hostId,instanceEpoch,sessionId,sessionEpoch,reason,missingEventRange,missingByteRanges?}`，reason 为 `reader_overflow|capture_overflow|capture_paused|network_loss`，描述该 reader/capture/转发副本未得到的源事件；missingEventRange 必填且精确，missingByteRanges 如已知则为 `{direction: rx|tx,start,end}[]`。TX 字节损失归属于丢失的意图；仅缺少最终回执时记录事件缺口，不重复记录意图字节损失。省略字节范围表示无法确定完整字节损失，空数组表示已知没有丢失 RX/TX 字节。ReaderGap 不含 eventSeq、配置 revision 或虚构源时间，不写入其他 reader 或源权威流。源端 RawEvent gap 与 ReaderGap 都要求解析器重置连续帧状态，不跨缺口拼帧。

派生来源 `SourceRange={hostId,sessionId,sessionEpoch,eventStart,eventEnd,byteStart?,byteEnd?,direction?}`；字节范围存在时 direction 必填。`DerivedProvenance={sources: SourceRange[],parserId,parserVersion,configurationDigest,quality,unit?}`；quality 为 schema 注册的字符串数组，基座标记 `complete|gap|partial|unknown|transformed`。数字采样派生另携 sample clock 与区间。任何降采样/过滤/脱敏保留来源与变换标记，显示降采样不等于源缺口。

`stream.read` 使用 Query，params=`sessionId,sessionEpoch,startEventSeq,maxEvents,maxBytes`；结果=`events: RawEvent[],nextEventSeq,hasMore`，两个最大值 U64，hasMore 为 boolean。读取范围已不在保留历史时返回 CURSOR_EXPIRED 与可用的 captureRef，不把读者缺失伪装成源 RawEvent。`stream.subscribe` params=`scopeId,after: Cursor,queueBytes: U64,initialCreditBytes: U64,overflowPolicy: drop_with_gap|stop|flow_control`，返回 subscriptionId；沿用快照/游标规则与 Host maxReaderQueueBytes/maxBatchBytes。flow_control 只有后端支持且用户明确允许时启用，失败转 stop 并发布错误。每个 reader 的队列、游标、投递进度独立；一个 reader 丢弃不能推进另一 reader。GUI 通常 drop_with_gap，协议/capture 可 stop 或受许可流控。原始录制有独立写盘队列，慢视图不反压设备。控制、批量原始流、派生输出分别设有界队列，停止/状态通道保留独立容量，不能被原始流队列挤死。

推送批为 `RawBatch={subscriptionId,cursor,previousCursor,items: StreamItem[]}`，items 非空；`StreamItem` 是判别联合 `{kind:"source",event: RawEvent}` 或 `{kind:"reader_gap",gap: ReaderGap}`。原始流 scopeId 为 `raw:<sessionId>:<sessionEpoch>`，固定同一源 Host/sessionEpoch，Cursor 仍绑定 hostId/instanceEpoch，与状态 `session:<id>` scope 分开。客户端使用 Host 签发的 sessionId/sessionEpoch 构造初始 after 游标。Cursor.position 是该 reader 已覆盖到的最后一个源 eventSeq，初始为 `"0"`；一个 source 项覆盖该序号，一个 reader_gap 项覆盖 missingEventRange。投递项按源范围连续递增、不重叠，缺失范围必须先投递 reader_gap 才能继续后续 source 项。previousCursor 为上一次已发送批的 cursor（首批为订阅 after），cursor 为本批最后覆盖的源序号；只含 gap 的批也有可确认游标。例如 after=99 丢失 `[100,151)` 时，gap 批 cursor=150，后续源 151 的批 previousCursor=150、cursor=151。源端 RawEvent 的 eventSeq 始终不变。

单批 UTF-8 JSON 序列化的实际字节数不超过 maxBatchBytes，source 和 reader_gap 的全部载荷及批信封一并计费，不按缺失字节数收费；不计传输帧/TLS 开销，其他编码须先协商计费规则。initialCreditBytes 是初始可投递额度，可为 `"0"`；不得超过 queueBytes，queueBytes 不得超过 maxReaderQueueBytes。单个完整项连同批信封超过预算时停止并返回 LIMIT_EXCEEDED，不能截断原字节。待投递 Gap 也占队列预算，相邻未投递缺失范围可合并；已投递的批不可改写。连一条缺口说明也无法有界保留时，以独立控制通道停止为 READER_OVERFLOW，不静默省略 Gap，不绕过数据 credit 发送。

`stream.credit` 是订阅控制 Query，params=`subscriptionId,ackCursor,grantedBytesTotal`；ackCursor 是本 reader 已完整处理的最后一批游标，grantedBytesTotal 为自创建以来累计批准投递字节数（包括 initialCreditBytes），均不得回退。服务端仅在 writer 完成整帧写入后推进 `sentBytesTotal` 与可 ACK 的完整批边界，进入 IPC 队列不算已发送。服务端记录 `sentBytesTotal`（累计已投递 U64）与 `acknowledgedBytesTotal`（根据已确认批边界累计的 U64），只在本批字节数不超过 `grantedBytesTotal-sentBytesTotal` 时发送；结果返回 `ackCursor,grantedBytesTotal,sentBytesTotal,acknowledgedBytesTotal`。包含 reader_gap 的批按相同边界 ACK，确认代表客户端已处理缺口说明，不宣称收到了缺失原字节。相同 subscriptionId/cursor 的同批重投保持内容不变，不重复增加 sentBytesTotal；客户端只应用一次，并可重复发送相同累计确认，不让重投或确认重试加倍额度。始终要求 `grantedBytesTotal-acknowledgedBytesTotal<=queueBytes`，包含未确认的在途数据，不能靠不确认却不断补额度制造无界队列；ackCursor 必须是订阅初始 after 游标或已发送完整批的边界，且不得回退或超过已发送游标。初始 after 的已确认字节数为 `"0"`，允许 initialCreditBytes=0 时先据此授予首批额度；旧/超前或批中游标拒绝 INVALID_ARGUMENT。credit 仅控制当前订阅投递，不能替代原始流读取授权或暂停设备采集。余额耗尽时保持有界排队，达到队列上限按 overflowPolicy 排入 ReaderGap/停止/授权流控；订阅重建后信用与计数重新开始，旧 subscriptionId 的确认不影响新订阅。

M1a Host 的源环预算为每会话 16 MiB、全 Host 128 MiB；reader 为每个最多 4 MiB、合计 128 MiB，最多 64 个，单批最多 256 KiB，RX 单条最多 16 KiB。内存预算包含载荷、元数据、待确认批、IPC 排队和编码暂存；共享字节在最后一个 Host 所有者释放时归还，重投共享同批内容。`stream.read` 的结果和暂存也使用同一 reader 总预算，预算随内部回包移交，写完、拒绝或断连时释放。内存预算与按 RawBatch 实际 JSON 字节计费的 credit 分开计算；队列连自身元数据也容纳不下时返回 LIMIT_EXCEEDED。

订阅保存创建时的授权代次和生命周期标记。撤权后再授权不能复活旧批，session epoch 改变后须重新取得游标并订阅；旧批尚未开始写入时丢弃，已开始写入时终止该物理连接，避免残帧与下一帧拼接。raw 连接依附自己的控制连接；只断 raw 不结束状态订阅，断控制连接会清理其 raw reader，同 actor 的其他连接独立。

## 发送回执

`session.tx` 的 params 为 `bytesBase64,writeWaitMs`，可选 `sourceInputRef: ObjectRef,transforms: [{id,version,configurationDigest}],queueWaitMs: U64`。提交字节已完成编码、字符映射、行尾和校验；协议/传输字节直接提交，不再走终端改写。单次最终字节长度为 1..16384，Host 解码并验证长度后冻结最终字节及摘要；回执与原始 TX 记录该最终内容，例如 LF→CRLF 的 payload 是 `0D0A`。

TX 结果为 `TxReceipt={operationId,sessionId,sessionEpoch,outcome,bytesBase64,byteStart,byteEnd,acceptedRanges,unknownRanges,backendError?,peerAcknowledged}`。outcome=`accepted|partial|rejected|unknown`；各 range 为相对于本次 bytes 的 `{start,end}` U64 区间，互不相交且不超长度。accepted 表示整个字节序列已被后端接受；partial 表示仅部分已接受、其余确定未接受；rejected 表示全未接受；unknown 表示至少一段无法判断，保留已知接受区间。peerAcknowledged 固定 false，只有上层协议另出应答证据可确认对端；驱动接受不表示线路已发完。

后端按顺序写入时 acceptedRanges 通常为前缀，但不强制所有 TransportProvider 假装具备前缀证明。没有回执的尾段进入 unknownRanges，不能填成零。应用排队期间取消、尚未 dispatch 时 outcome=rejected、accepted/unknown 均空；已写 3/5 后取消时保留 `[0,3)`，剩余若确定停止则 partial/cancelled；驱动仍不确定则 unknown/unknown。TX 日志先保存意图，后关联回执，不能因取消删除历史。

所有时限由执行 Host 单调时钟判定。U64 wire 值进入 JS timer 前须校验并转换为有界安全整数；v0 单次可配置时限范围 `"1"` 至 `"2147483647"` ms，`"0"` 仅按相应 schema 明确表示立即检查，不表示无限。更长任务使用截止时间和分段等待，不能把十进制字符串直接传 setTimeout。Rust 与 Node 使用相同单位及起算点。

| 字段                 | 起算点与范围                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `queueWaitMs`        | 接纳进入队列起，到获得仲裁；到期终结未开始部分，不更改已执行项      |
| `readWaitMs`         | 本次等待读调用起，到至少一块数据可用；只影响 reader                 |
| `writeWaitMs`        | 本次后端写入开始起；到期记录已知接受/未知范围并结算                 |
| `interByteIdleMs`    | 最近一个接收字节/读块的源时间起；精度取决于来源，不能推断线级间隔   |
| `responseWaitMs`     | 协议定义的发送/排空边界起；事务 schema 必须明确该边界，迟到应答另标 |
| `reconnectBackoffMs` | 一次失败/断开已结算起，到下一身份核对与打开尝试；不包含旧队列重放   |
| `ttlMs`              | 执行 Host 接纳 acquire/renew 时起；续租不会延长已过期租约           |

客户端 RPC 的等待超时是传输层设置，与以上业务超时独立。传输超时后先查 operation，不提交新 ID 自动补发。

## 配置、控制线与队列

`SerialConfiguration={baudRate,dataBits,parity,stopBits,flowControl,readWaitMs,writeWaitMs,reconnectBackoffMs}` 是完整配置，所有字段必填；baudRate 为正 U64，枚举及正时限按生成 schema 校验。`session.configure` params=`requested: SerialConfiguration`，回执 requested 也保持同一完整类型，Call 必带 expectedRevision。Host 在持口端仲裁，保存请求值与逐字段结果：`ConfigReceipt={requested,fields,readback,revision,boundaryEventSeq,txGate}`。fields 项为 `{field,status: applied|rejected|unknown,actual?}`；actual 有值时必须是真实字段值，不接受 null，无法读回时省略；readback 是实际可读回字段对象，未支持读回的值不得填成请求值。配置只有部分字段 applied 或任一字段 unknown 时进入 configuration_pending，停止新 TX 和发送任务；不静默“回滚成功”。操作已知部分应用可 succeeded 且 txGate=configuration_pending，无法确认则 unknown。完成显式完整配置并核实全部必要字段后才恢复 ready。每次配置尝试的 confirmed、partial 或 unknown 结果都推进 configurationRevision，并用于随后的 RX；configuration 对象仅在完整确认时更新。owner 在配置结果返回后暂停 RX，直到该 receipt、边界和状态发布完成；失败保持 configuration_pending 并终止该源，不能放行未描述的新 RX。revision 在发布该结果时推进，boundaryEventSeq 指 `configuration_boundary` 原始事件，payload 含 `revision,certainty: confirmed|uncertain,receiptRef`，receiptRef 为 ObjectRef。不能回溯改写此前数据的配置。

`session.break` params=`durationMs`，由持口端单调计时执行有限 BREAK。controlState=`clear|asserting|asserted|clearing|unknown`；先持久登记清线责任，再 assert。到期、取消、错误、撤权和断连均进入 clearing；assert 和 clear 各有 `status: confirmed|failed|unknown,at: Timestamp,error?`，共同构成 BreakReceipt。clear confirmed 后才允许释放隔离并 ready；clear failed/unknown 时暂停 TX 与自动重连，保留清线责任和操作结果。手动恢复动作必须在源端确认线已清或已释放设备，不允许前端定时器假设成功。

控制线动作 `session.control` params=`line: dtr|rts,value: boolean`，结果记录请求值与可证实实际状态；流控占用相同线路时返回 `CONTROL_CONFLICT`。输入信号的边沿能力由 capabilities 声明；采样值不能冒充精确边沿。

| 动作 ID                   | params                                                     | 成功/未知边界                                                                                                         |
| ------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tx.waitBoundary`         | `throughOperationId: Id,queueWaitMs`                       | 等该时刻之前应用队列项结算；新入队项不延长等待，不说明 OS TX 已空                                                     |
| `tx.queueStatus`（query） | 空对象                                                     | `pendingBytes: U64,observedAt: Timestamp` 或 UNSUPPORTED_CAPABILITY；只是驱动观测                                     |
| `tx.drain`                | `writeWaitMs`                                              | 驱动 drain 的确定结果/超时/未知；不确认对端已接收                                                                     |
| `session.purge`           | `direction: rx\|tx\|both,scope: application\|driver\|both` | `direction,scope,outcome: completed\|partial\|unknown,affectedOperationIds,ranges,unknownExtent`；按 backend 能力执行 |

purge 中 ranges 是带 direction 的字节区间，unknownExtent 为 boolean。application purge 终结指定方向应用未处理队列，不影响已进入驱动的发送；driver purge 只报告驱动提供的范围，未知时如实标记。等待取消只停止等待；purge/超时均保留既有历史和回执，发布 gap/control 连续性边界。不能把 TX 队列空、drain、清空和收到对端响应视为同一状态。

领域 code：`CONFIGURATION_CONFLICT`、`CONFIGURATION_PENDING`、`CONTROL_CONFLICT`、`CONTROL_UNKNOWN`、`LEASE_CONFLICT`、`LEASE_EXPIRED`、`QUEUE_TIMEOUT`、`WRITE_TIMEOUT`、`BACKEND_DISCONNECTED`、`READER_OVERFLOW`、`CAPTURE_IO_FAILED`、`SOURCE_CHANGED`、`TARGET_EXISTS`、`CAPTURE_INCOMPLETE`、`CAPTURE_CORRUPT`。这些 code 采用 Host Error 结构；可重试也必须遵守原 requestId 的去重与结果查询。

## 录制、验证与回放

新录制格式 `formatVersion="0.1"`，M1 定义其容器编码与生成 schema；这是新体系首版，不承诺旧软件录制、插件包或缓存格式的读取/迁移。格式版本独立于协议版本；读取未来格式返回 FUTURE_FORMAT，文件只读保留。M0 先固定以下逻辑结构与验证语义，容器选型不得削弱它们。

Capture 包含 `captureId,formatVersion,mode,sourceHosts,streams,volumes,index,state,watermarks`。mode=`raw|redacted`，redacted 明确记录变换摘要，未经用户选择不另存原始副本。streams 固定源 host/session/epoch/配置及时间精度；原始事件保留源序号、最终 TX 意图与实际回执、源 Gap、控制和生命周期事件。TX 意图和回执按 owner operationId 关联任务，块结算以真实源 host/session/sessionEpoch 与 byteStart/byteEnd 区分；同一文件发送 owner 的不同块合法，同源同块重复结算仍拒绝。完整性报告按块跟踪尚无最终回执的意图，并将 unsettledOperations 聚合为去重的 operationId；视图按源字节范围更新该任务的结果而不重复显示字节。捕获某 reader/转发副本时，ReaderGap 作为独立记录保存，只有捕获 recordOrdinal，不虚构源 eventSeq；完整性报告将其覆盖源范围计为不连续。B 的原始录制为来源权威，A 的副本必须标网络缺口，不能改造源序号制造完整性。

volume 项包含 `volumeId,ordinal,recordStart,recordEnd,length,digest`，ordinal/recordStart/recordEnd/length 为 U64；manifest/index 固定分卷顺序、哈希、事件区间与前后关联。每个写盘记录分配独立 `recordOrdinal`，从 `"1"` 起；多源交错以捕获序号记录，源顺序仍由其 eventSeq 决定。watermarks 为 `{written,flushed,synced,verified}`，均表示所有分卷的连续、完整 recordOrdinal 前缀，初值 `"0"`，关系 `verified<=synced<=flushed<=written`。索引/manifest 的持久状态也须计入水位，不能仅看 payload 文件长度。

| 水位       | 准确含义                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------- |
| `written`  | 完整记录已由写调用接受，仍可能在应用缓冲                                                      |
| `flushed`  | 应用缓冲已排到文件/OS，未宣称介质持久                                                         |
| `synced`   | 文件与必要元数据的持久化同步调用成功                                                          |
| `verified` | 对已 synced 的字节独立重新打开/读取，校验结构、长度、序号、hash、卷关联与索引后确认的连续前缀 |

capture state=`recording|finalizing|complete|incomplete|failed`。正常 stop 进入 finalizing，flush、sync 全部卷和索引，再独立验证；仅全部一致且无未声明缺口时 complete。预期内容中明确记录的设备 Gap 仍可成为结构完整 capture，但完整性报告必须区分 `containerComplete: true` 与 `sourceContinuous: false`。写盘失败/满盘立即停止该 capture 订阅并记 CAPTURE_IO_FAILED，已接受部分保留为 failed；Host 继续采集且其他 reader 不阻塞。异常退出/缺尾为 incomplete；不伪造同步/验证水位。

| 动作 ID                 | params                                                                       | 结果                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `capture.start`         | `sessionIds: Id[],mode,targetRef: ObjectRef,overflowPolicy`                  | 独立 operation，result 指 capture；targetRef 是授权创建位置，不是裸路径                               |
| `capture.stop`          | `captureRef: ObjectRef`                                                      | 完成 finalizing 后返回 capture state/watermarks/完整性报告                                            |
| `capture.verify`        | `captureRef`                                                                 | `verificationId: Id,sourceFingerprint: Digest,verifiedPrefix: U64,volumeResults,recoverable: boolean` |
| `capture.recoverPrefix` | `verificationId,sourceFingerprint,targetRef`                                 | 新 captureRef，state=incomplete、`recoveredFrom` 与 verifiedPrefix；原件不改写                        |
| `replay.open`           | `captureRef`                                                                 | 只读 replay 会话，能力只含 read/seek/pause/step，打开不发设备字节                                     |
| `replay.transmit`       | `captureRef,targetSessionId,targetSessionEpoch,selection,rate,previewDigest` | 独立发送任务；需要 device.modify 与明确预览确认范围                                                   |

volumeResults 项包含 volumeId、`status: verified|missing|corrupt`、verifiedPrefix 与可公开错误。sourceFingerprint 覆盖被验证源文件的身份、长度及内容摘要；verify 后保存只读源句柄/身份依据，另存前再次核对全部相关源。源变化 SOURCE_CHANGED；目标已有文件 TARGET_EXISTS；两种失败均不覆盖原件/既有目标。恢复仅复制跨卷连续验证前缀，遇缺卷/损坏停止，不跳过拼接；先写独占新临时目标并同步验证，再以不覆盖语义发布。失败保留可诊断临时证据，不把半成品标完整。

replay.transmit 的 selection 为按源方向及 SourceRange 组成的明确选择，rate 为正十进制字符串及单位；预览固定目标、源 TX 接受区间、最终字节、速率和范围摘要。默认仅可选已确认 accepted 字节；unknown 尾段不可推定重放。用户选择发送其他捕获字节必须作为新的明确发送意图独立预览授权，不修改原始 TX 事实。设备模拟另登记独立任务，查看 capture 不启动模拟。执行前重新校验 previewDigest、源指纹、目标 epoch 与权限。

## 可迁为测试的验收向量

每例需要独立后端计数器或文件检查确认副作用，单看 GUI toast 不满足验收。计时使用可控单调时钟；字节列用 HEX 仅便于阅读，wire 用 Base64。

| ID  | 输入前态                                                        | 动作                                                      | 可见结果与副作用                                                                                                                     |
| --- | --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S01 | 物理 P 未打开，配置 C，客户端 A/B 同时请求                      | A/B 各自 requestId 调 device.open(P,C)，B 再用 C2         | open 后端计数=1、同 sessionId/epoch；C2 CONFIGURATION_CONFLICT，配置未变                                                             |
| S02 | 输入 LF，变换 LF→CRLF；后端最多接受 1 字节                      | 提交 bytes=`0D0A`，查询 O                                 | outcome=partial、acceptedRanges=[0,1)、原始 TX 存 0D0A；线路只已知接受 0D，不能宣称完整 LF                                           |
| S03 | 已持久 dispatch；后端可能接受 3/5，落结果前崩溃                 | 重启 attach；按原 requestId 查询，再原请求 invoke         | O=unknown、已知范围保留、其余 unknownRanges；同请求不再 TX，重启不自动恢复队列                                                       |
| S04 | session epoch=2，事务排队，重开后 epoch=3                       | 旧 lease/epoch 实际准备写入                               | EPOCH_MISMATCH 或 LEASE_EXPIRED，后端写次数=0；新 epoch reader 正常                                                                  |
| S05 | config revision=8，baud=9600/parity=none                        | CAS8 请求 baud=115200/parity=even；后端只应用 baud        | 逐字段 applied/rejected，readback 真实，revision=9，uncertain boundary，txGate=configuration_pending；新 TX 拒绝，完整确认配置后恢复 |
| S06 | BREAK assert 已 confirmed，duration=10ms                        | 到期或取消时注入 clear 失败，再请求 TX/自动重连           | clear failed/unknown、O 失败或 unknown、control_unknown，TX/自动重连均停；责任未隐去，不向新持有者放行                               |
| S07 | 快 reader Q1、慢 reader Q2、capture Q3；Q2 满                   | 持续投递序号 100—200                                      | Q1/Q3 原字节 hash 一致，Q2 有准确 Gap/或停止；解析器跨 Gap 不拼帧，源采集不因慢 GUI 阻塞                                             |
| S08 | capture written=100/flushed=90/synced=80/verified=70            | 注入满盘，继续设备 RX                                     | capture failed/CAPTURE_IO_FAILED，水位不虚增，原件前缀保留；其他 reader 继续，停止通道可响应                                         |
| S09 | 卷1完整、卷2中段损坏、卷3存在                                   | verify，再 recoverPrefix 至新目标                         | verifiedPrefix 截止卷2首个损坏前的连续记录，不跳到卷3；新件 incomplete，原件字节不变                                                 |
| S10 | verify 得 fingerprint F、恢复边界 K                             | 修改任一源卷后另存；另一路目标已存在                      | 分别 SOURCE_CHANGED/TARGET_EXISTS；原源和既有目标均不被覆盖，验证证据保留                                                            |
| S11 | 应用队列含 O1/O2，O1 已进驱动；OS 尚有字节                      | waitBoundary(O1) 取消，再 purge(application,tx)，再 drain | 等待取消不撤 O1；仅未执行 O2 终结，历史 TX 保留；drain 自己报告完成/未知，不假装对端响应                                             |
| S12 | A interactive 租约及 B 接纳的 independent 任务 T；B 本地任务 L  | A Host 失联至租约到期，再 B 撤销 A 共享                   | 首步交互未执行写入终结、T/L 继续；撤销后 T 按取消点结算，L 继续；A 重连查旧 O，不复活队列                                            |
| S13 | transaction 等待应答，普通发送 N 排队                           | 到 responseWaitMs，注入迟到响应并释放事务                 | 事务超时有终态，迟到响应标来源/归属；N 在租约结算后执行，不插入事务字节中                                                            |
| S14 | 浏览器插件 UI 正订阅、Host capture/任务运行                     | 关闭 UI/AbortSignal，再打开                               | 只释放 subscription，capture/任务继续；快照+cursor 重建状态；显式 cancel 才结算任务                                                  |
| S15 | capture 中 TX accepted [0,3)、unknown [3,5)                     | replay.open；再显式 preview/transmit                      | open 后端写计数=0；发送预览默认仅 3 字节，unknown 不自动重放；目标 epoch 改变则拒绝                                                  |
| S16 | recording 已停，全部卷 synced，索引缺失/错误                    | finalize 独立读回验证                                     | CAPTURE_INCOMPLETE/CAPTURE_CORRUPT，不能 complete 或提高 verified 越过索引可证前缀                                                   |
| S17 | UDP 两报文分别为 01、0203；WS 分片一消息                        | read/subscribe/capture/replay 往返                        | 原报文/消息边界、类型和片段 offset 保留；切块不变成协议帧，字节 hash 一致                                                            |
| S18 | 两机源时钟偏移 2s，B eventSeq 连续，A 接收乱序                  | 按来源读回并展示时间线                                    | 源序号/clockId 不改写，接收时间独立，偏移与误差可见；跨机不假设统一单调时钟                                                          |
| S19 | reader credit=1000，已发送800字节；另 reader正常                | 同一累计grant=1800确认发两次，再发旧确认/超前ack          | 两次结果仍grant=1800，剩余额度不翻倍；旧/超前拒绝，慢reader满队列按策略处理，其他reader和停止通道继续                                |
| S20 | Q1/Q3 完整接收源 100—151；Q2 after=99 丢失 `[100,151)`          | 给 Q2 足够 credit，解码只含 reader_gap 的批，再投源 151   | gap 无 eventSeq，cursor=150/previous=99；源151批 previous=150；Q1/capture 源 hash/seq 不变，解析器先重置再处理151                    |
| S21 | Q2 初始 credit=0，after=99；待投 gap 批 G 大小为 g、源批 E 为 e | 用 after 授额；投递 G/E 并重投 G，重复累计 grant 与 ACK   | 首批可起步且零额度不越额发 Gap；G 只应用/计费一次，ACK G 仅确认说明且累计 g，ACK E 累计 g+e；同 grant 不翻倍、批中游标拒绝           |
