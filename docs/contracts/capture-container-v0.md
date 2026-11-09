# Capture 容器 0.1

本文定义原始录制和只读回放的容器、验证与恢复格式；任务语义见[流与操作](./stream-and-operations-v0.md#录制验证与回放)，独立 reader 验证入口见[测试](../testing.md#独立录制格式)。

## 目录与记录

容器是一个目录，包含 `manifest.json`、`index.json` 和从 `volume-000001.swbr` 开始的连续卷。每卷以七字节 ASCII `SWBR01\n` 起始。随后重复小端 u32 JSON 长度、该长度的 UTF-8 `CaptureRecord` JSON、32 字节 JSON 内容的 SHA-256。单条 JSON 最大 1 MiB，记录完整写在同一卷内。默认卷大小 64 MiB，卷最长 60 分钟，先达到者触发下一条记录换卷。

每条记录有从 1 开始的 `recordOrdinal` 和 `entry`。事件保留源 host/session/epoch、事件序号、配置、时钟与字节范围。TX 结算以 owner operationId、真实源 hostId/instanceEpoch/sessionId/sessionEpoch 和 byteStart/byteEnd 唯一关联一块 TX 意图；文件发送的多个块可属于同一 owner，同源同块的重复结算仍被拒绝。独立 `TxSettlement` 使用 `CaptureTxSettlement { hostId, instanceEpoch, receipt }`，来源须与 manifest.streams 中声明的 hostId、instanceEpoch、sessionId、sessionEpoch 一致，不从 sessionId 猜测 Host。accepted 与 unknown 区间原样保存，未结算块在报告中按 operationId 去重聚合。ReaderGap 独立于源事件序号。

索引列出每条记录的卷号、文件偏移和编码长度；卷清单列出起止序号、长度、摘要和前卷摘要。路径不从容器元数据取值，读取器根据 ordinal 生成固定卷名。未知格式返回 FUTURE_FORMAT，原件保持不变。

## 完成与恢复

`written/flushed/synced/verified` 均表示完整连续 recordOrdinal 前缀，满足 verified ≤ synced ≤ flushed ≤ written。正常停止先落盘卷、索引与 manifest，再重新打开并读取，核对记录/卷摘要、前卷链、索引偏移与源序号。只有索引与内容相符且读回通过时才标 complete。设备明确声明的 Gap 保留并使 sourceContinuous=false，不混淆容器完整性。

verify 在首个缺失/损坏记录停止，不跨越坏卷。恢复校验 verificationId 和指纹，另存已验证连续前缀，在发布前再次核对源身份和内容；新件为 incomplete，包含 recoveredFrom 与 verifiedPrefix。源变化返回 SOURCE_CHANGED，目标存在返回 TARGET_EXISTS，均不覆盖原件或既有目标。

默认 create_new。append 仅接受同格式/来源/配置且整个已有前缀验证通过的容器，从新卷继续。Host 根据每个源的已录末序号与新订阅位置记录 `capture_paused` ReaderGap，保留停止期间未录入的真实事件范围；无法确定旧源位置时，在修改原容器前拒绝追加。replace 要求 expectedFingerprint；候选同步验证后先归档旧目标，再以不覆盖方式发布候选。失败保留归档和候选证据。

默认容量 1 GiB，保留磁盘余量 128 MiB。达到限制、慢盘导致订阅溢出或写盘失败只停止该 capture。raw 为默认；M1 接到 redacted 返回 UNSUPPORTED_CAPABILITY。

## 文件引用与回放

文件登记仅接受可信用户选择或 CLI 显式登记，保存客户端登记与写入归属；读取按原授权 Target 当前的 metadata.read 或 content.read 权限判断，同作用域已授权的其他客户端可以读取，不自动获得 grant。业务动作使用 ObjectRef，固定文件必须携带 revision，正在录制的资源可省略 revision。metadata 不返回真实路径或文件正文。

回放读取独立文件 reader，不创建设备 Transport。支持最快和原时序；暂停不发送，seek 推进 readerGeneration 并重置时序基点。文本导出按源、方向和 epoch 增量解码 UTF-8；缺口与流结束处结算未完成字符，非法字节明确标记替换。JSONL 保留源 timestamp、方向、原始 byte offset、卷及记录偏移；跨记录文本通过 sourceSpans 逐段记录原始字节范围与记录位置。

回放回复中的 `records` 使用 `inline` 或 `reference` 项。普通记录在 `inline.record` 中原样提供；无法放入当前有界回复的记录返回 `reference`，包含 `recordRef`、`recordOrdinal`、`jsonBytes` 与原始 JSON 的 `jsonSha256`。引用类型为 `capture_record`，固定 revision 为 1，并继承原源的读取授权，不自动增加 grant。

统一 `file.read` 按 offset 分块读取引用，每次最多返回 64 KiB 解码后的字节，正文经 raw 连接发送。客户端按 offset 拼接后核对原 JSON 长度与 SHA-256，再解析为同一个 `CaptureRecord`；源 host/session/epoch、时钟、序号和最终 TX 区间保持不变。容器的 1 MiB 记录上限不会扩大 IPC 的 1 MiB 帧上限，也不会通过截断记录满足帧限制。每次分块读取都重新检查当前原源授权。

## 无会话尾部查询

`capture.tail` 是经 `action.query` 调用的 Raw 正文查询，目标为 `file` 或 `capture`，按原授权目标检查当前 `content.read`。请求使用 `CaptureTailParams`：`captureRef`、缺省为 100 的 `maxRecords`（1–100）、缺省为 262144 的 `maxBytes`（1–262144），数值均为十进制字符串。预算包含整个 `CaptureTailResult` 的 JSON 编码。

结果返回实际 `captureRef`、本次 `sourceFingerprint`、`state`、`verifiedPrefix`、`containerComplete`、`sourceContinuous`、`firstRecord` 和 `records`。记录是已验证连续前缀的连续末段，按 ordinal 升序，保留 Gap、Unknown TX 和历史来源身份；空结果的 `firstRecord` 为 `verifiedPrefix + 1`。损坏容器可以返回首个坏记录之前的验证前缀，不跨越坏段。大记录使用上述 `capture_record` 引用，长度与摘要来自实际读取并验证的原始 JSON；包含引用的完整回复仍放不下时返回 `LIMIT_EXCEEDED`。

本代仍活动的 capture 返回 `CAPTURE_ACTIVE`，不读取尾部、不停止录制。已非活动且合法无 revision 的 capture 经目录、captureId 和指纹核验后读取快照；已发布时返回真实固定 revision。固定旧 revision 和源变化分别按既有 `REVISION_CONFLICT`、`SOURCE_CHANGED` 拒绝，不更新工作区引用、重新登记或自动授权。验证后绑定、读取和返回前发现源变化时整次失败，不交付部分记录。

该查询不创建 Operation、Replay Session 或 verification lease，不修改录制原件。每个 Host 同时接纳一个尾部扫描，忙时返回 `HOST_BUSY`；等待者取消后，扫描仍持有名额至实际结束。扫描在阻塞工作线程执行，仍需遍历并哈希容器；有界的是尾部物化、回复及并发数。局部文件句柄随请求工作完成释放。查询前后与 IPC 发送前复核授权，Raw 写入期间沿现有撤权路径中断。

## 引用、内容修订与队列预算

创建位置使用 `kind=file` 的授权位置引用。`capture.start` 创建独立 `kind=capture` 引用，其 id 与 manifest.captureId 一致；位置引用不会作为录制结果返回。Host 私有登记保存客户端与 parentRef，每次动作都重新验证原授权；派生引用不会自动获得读取权限。动作涉及的源会话和目标位置分别按 content.read 与 workspace.modify 检查。

正在录制的引用省略 revision，表示同一录制资源的活动状态。完成后发布固定内容 revision，追加前推进内容 revision，使旧固定引用明确冲突；替换创建新的 captureId。保留期内的历史 Operation 使用已保存的原授权归属复核当前读取权限，其查看不要求旧内容 revision 仍为当前值；实际内容读取仍检查固定 revision。旧引用遇到新容器必须返回 REVISION_CONFLICT，不能沿原路径静默读取新件。归档保留旧内容；引用和内部存储文档的 revision 分开维护，移动私有存放位置不冒充内容变化。

正常 finalize 的 sourceFingerprint 只取最后一次独立读回确认的内容。verify 的租约绑定扫描时的源身份、长度、真实指纹、连续前缀和逐记录摘要，不长期持有卷文件句柄。Host 最多保留 16 个租约，按创建顺序回收；过期 verificationId 返回 NOT_FOUND。恢复请求取用后消费租约，失败同样释放，Host 关闭时清理剩余租约。恢复和文本导出在消费快照时重开并核验卷身份与长度，在读取期间持有这些句柄，逐条比较实际读取 JSON 与验证快照摘要，发布前继续检查源身份和全量指纹。metadata 返回可用的固定引用与公开元数据，不返回路径或正文。

捕获队列为每个 capture 16 MiB、每个 Host 合计 64 MiB；配额包括上游订阅 reader 的预留、队列元数据、队列内容和正在写入的一批。克隆入队内容前申请字节配额，直到写入或失败结算后释放。消息槽位仅作额外数量上限。任一预算不足停止该捕获并保留已写证据，不等待 RX 为磁盘或读者腾出空间。

实际创建、元数据提交与发布沿同一已核验目录能力执行：Unix 使用持有的父目录 dirfd，Windows 保留祖先目录句柄与 reparse 检查。正常 stop 在最终同步、独立读回或结果发布失败时返回原错误并公开 Failed 终态，不遗留 Recording。录制 owner 的运行进度只在 durable synced 水位增加后持久写入，单位为 records；进度写入失败也停止录制并保留证据。
