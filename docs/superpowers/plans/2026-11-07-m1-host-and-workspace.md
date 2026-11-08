# M1 独立 Host 与最小工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现独立 Host 持有设备、原始流与任务，GUI、CLI、标准 MCP 操作同一会话，提供基本 Text/HEX、录制与只读回放的可验证 M1 软件闭环。

**Architecture:** Rust core 定义领域与 wire DTO，Host 拥有授权、持久操作和资源生命周期；所有适配器调用同一个 registry/dispatcher。M1a 交付 Virtual、受限本地 IPC、CLI/MCP 与生成客户端；M1b 接串口/PTY、capture、共享设置和桌面工作区。浏览器仍为隔离 preview，M2 再成为 Host 客户端。

**Tech Stack:** Rust 1.99.1、Tokio、Serde、现有 Specta、Schemars 1.2.3、rusqlite 0.41.1、官方 rmcp 3.9.0、React 19、TypeScript 6、Tauri 2、pnpm；具体版本由实施提交的锁文件固定。

**Spec:** [设计](../specs/2026-11-07-serial-workbench-design.md)、[功能矩阵](../specs/2026-11-07-serial-workbench-feature-matrix.md)、[Host v0](../../contracts/host-v0.md)、[流与操作 v0](../../contracts/stream-and-operations-v0.md)、[逐项 M1 覆盖](./2026-11-07-m1-coverage.md)。

## Global Constraints

- “旧软件的 API、数据格式和插件体系不提供兼容或迁入”；复用合理算法时保留 Apache-2.0/第三方归属，不复制旧 API 或 capture v1—v5 读取器。
- “全部插件关闭后，基座仍能枚举、连接、Text/HEX 收发、记录回放、查看任务和诊断”。core/Host/CLI/MCP 不依赖 Tauri、Node 或 GUI 存活。
- “M1 设备与最小工作区”：独立 Host、Virtual/PTY/OS 串口、Text/HEX、设置、发送回执、原始录制/只读回放；GUI/CLI/MCP 首条闭环。
- “Windows 10 22H2；Windows 11 24H2/25H2，26H2 进入新增测试清单”；macOS 14 arm64/x64；Ubuntu 22.04/24.04、Debian 12 x64 glibc。平台证据分开记录，不静默抬高下限。
- Host 协议精确 `"0.1"`，新 capture 格式 `"0.1"`；U64 为十进制字符串，requestContext 由执行 Host 签发；actor 由认证绑定；所有调用包含 epoch 和 revealTarget。
- resultRetentionMs 至少 `"604800000"`；requestContext 接纳窗口 `"86400000"` ms；时限 `"1"`—`"2147483647"` ms，只有明确的立即检查允许 `"0"`。
- 手写 TS 不使用 any/enum，原生交互经过 `src/lib/tauri.ts`；Rust DTO 生成公共类型/schema；HashRouter、中英词典、语义 token、useUnsavedWork 沿用。
- M0 清理/合同独立审阅通过并 squash 合入 main 后开始；M0 是前置条件，不是产品完成。M1a 按下文的基础、功能闭环两个里程碑交付，M1b 按下文已闭合的独立切片交付；各里程碑的实现、测试、审阅修正和配套文档合为一个提交，不逐测试或一两行修改提交。全部分支线性，同步只用 rebase/fast-forward，短名分支完成即删除，提交主题/正文与 PR 文案使用中文。
- 软件验证使用 Virtual、独立软件对端、PTY、进程级 IPC 和无头 UI；真实窗口、硬件、驱动与最低系统验收单列，按 M6 或已安排独立环境执行。
- 用户已要求现在启用 CI/CD：日常主要本机验证、兼顾各平台；积累到 M0/M1 等大节点手动触发完整三平台 CI。独立 CI runner 可执行真实桌面，本机仍不擅自弹窗；不恢复每次提交/PR自动运行。

## 交付边界调整

用户指出已完成内容连续五小时没有后续提交，因此将原 M1a 的单次出口拆为两个完整里程碑，功能范围和验收要求保持原计划：

| 里程碑       | 内容                                                                                                       | 出口                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| M1a 基础     | Task1—4：生成契约、持久接纳与恢复、本机 IPC 与授权、统一目录与状态投影；期限统一使用包含系统休眠的原生时钟 | 独立 Rust/TS/工程检查与审阅通过后集中提交，经 PR squash 合入             |
| M1a 功能闭环 | Task5—7：Virtual、发送与原始流、CLI/MCP                                                                    | 基础里程碑之上完成原 M1a 软件场景、手动四目标 CI，再集中提交与 PR squash |

基础里程碑不创建 CLI/MCP 空程序；Task7 实现后再将两个包加入 workspace。已完成且可独立验收的边界应及时交付，不把等待后续功能作为长期积压修改的理由。

M1a 两个里程碑已分别通过 PR #34、PR #35 合入。M1b 实施中再次出现已完成内容长期积压，因此先交付可独立使用、审阅和验证的“CLI/MCP 启动配置”切片：统一解析 profile 与日志级别、记录脱敏配置来源、保持机器输出，并同步指南。其余设备、录制、桌面和软件验收继续按原范围推进；该切片不代表 Task11 全部或 M1b 出口完成。每个可交付切片仍将实现、测试、审阅修正和文档集中为一个中文提交，经 PR squash 合入并清理短期分支。

## Review Focus

1. 两进程同配置并发启动、忙实例、失效发现记录不得产生双 Host 或抢活锁：Task 3 进程计数测试。
2. 写入发生、结果提交前崩溃，旧请求不得重发；U64 超安全整数不能变值：Task 1/2/5 故障与 wire 测试。
3. 慢读者、撤权后的已排队正文、快照和订阅间隙不能造成泄漏/静默缺口：Task 4/6 双客户端测试。
4. 参数部分应用、BREAK 清线失败和重连不能开放 TX：Task 5/9 后端注入测试。
5. 分卷损坏、验证后源变化、恢复目标碰撞不能覆盖原件；GUI 退出不能停止独立录制：Task 10/12 故障测试。

## 文件与工程边界

执行路径均相对最终仓库根。编写本计划时的源码依据是已清理的 `.claude/worktrees/foundation/`；执行者使用合并后的 main，不从根目录旧来源分支恢复已删除内容。

| 目录/文件                                                                                              | 唯一职责                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `crates/core/src/{wire,identity,error,catalog,operation,session,stream,settings,workspace,capture}.rs` | DTO、值约束、状态机、静态目录定义；无 OS/async runtime/桌面依赖             |
| `crates/core/src/{transport,clock}.rs`                                                                 | 同步后端边界、可控单调时钟；Host 将阻塞 IO 放专有线程                       |
| `crates/core/src/bin/export-contracts.rs`                                                              | 从 DTO/动作类型导出 TS、draft-07 schema、目录和正负 fixture                 |
| `crates/ipc/src/{lib,frame,identity,discovery,windows,unix}.rs`                                        | 共享本机传输、身份证明、运行文件与受保护秘密；不承载业务授权                |
| `crates/host/src/{lib,main,dispatch,registry,limits,state,shutdown}.rs`                                | 业务组装、同一 handler、预算、状态历史、退出                                |
| `crates/host/src/{storage,auth,ipc,device,transmission,capture,files,settings,workspace}/`             | 各领域服务；每目录 `mod.rs` 仅入口，按下文文件分工                          |
| `crates/client/src/{lib,connection,discovery}.rs`                                                      | Rust IPC 客户端；不持设备句柄、不复制业务规则                               |
| `crates/cli/src/{main,args,output}.rs`                                                                 | CLI 解析、JSON 输出及退出码                                                 |
| `crates/mcp/src/{main,server,catalog}.rs`                                                              | 官方 SDK stdio 适配，同 Host 目录的明确领域工具                             |
| `packages/contracts/src/generated/`                                                                    | 生成 `types.ts`、`schemas.json`、`catalog.json`、`validators.mjs`；禁止手改 |
| `packages/host-client/src/{client,projection,utf8,hex,transforms}.ts`                                  | transport 注入、结果校验、快照接续和纯视图/字节转换                         |
| `src-tauri/src/host_bridge.rs`                                                                         | 固定 Host 路径启动/附着，窗口能力转发，不执行串口业务                       |
| `src/features/workbench/`                                                                              | 设备、标签、Text/HEX、发送、capture、任务与 AI 活动呈现                     |

### 已作出的工程选择

1. 基础里程碑建立根 `Cargo.toml` workspace，members 为 `src-tauri,crates/core,crates/ipc,crates/host,crates/client`，resolver=`3`；default-members 为四个无头 crate。Task7 实现 CLI/MCP 时再加入 `crates/cli,crates/mcp`。包名固定 `serial-workbench-{core,ipc,host,client,cli,mcp}`。根 `Cargo.lock` 唯一；将现有 `src-tauri/Cargo.lock` 移至根后由协调者更新，release/dev profiles 也移至根。新 `.cargo/config.toml` 设置 `target-dir="src-tauri/target"` 保留缓存。Cargo workspace 的锁、target 与 profile 规则见[官方说明](https://doc.rust-lang.org/cargo/reference/workspaces.html)。
2. Task 1 同步 `scripts/init-lib.mjs`、`scripts/init-project.test.mjs`、`scripts/version.mjs`、`scripts/version.test.mjs`、`scripts/build-lib.mjs`、`scripts/build.test.mjs`、`scripts/generate-bindings.mjs`、`.github/workflows/{ci,audit}.yml`、`e2e/build.mjs`/测试和文档的锁路径/包选择。`scripts/hosting/github-release.mjs` 继续读桌面 manifest，但显式选桌面包；不把 core 当默认发布包。`scripts/clean-lib.mjs` 保留 target 行为，测试根 workspace 不扩散删除范围。被禁用的 release workflow 在启用前同步其路径，不能留错误模板。以并行 CI 基线 PR 合入后的文件为准：ci.yml 的 rust/bindings 缓存 `workspaces: . -> src-tauri/target`，desktop-e2e 为 `. -> src-tauri/target/e2e`；删除这些步骤的 `working-directory: src-tauri`，根执行 `cargo test --locked --workspace` / `cargo clippy --locked --workspace --all-targets -- -D warnings`。audit.yml 使用 `cargo audit --file Cargo.lock`；pnpm cache覆盖根及packages锁输入。手动触发跑完整累计改动，不再依赖已删除的ci-scope/ci-verified-tree脚本。quality-gate测试按CI基线实际保留入口更新，不能重新加入旧helper。
3. core 用现有 Serde/Specta 加 Schemars；Host 添加 rusqlite（bundled，唯一数据库写线程）、uuid(v4)、hmac 与随机数来源（复用 uuid/getrandom 已锁依赖）、Tokio net/io/process/runtime。MCP 使用 `rmcp = "=3.9.0"` 的 server/transport-io，测试加 client/transport-child-process；不手写 MCP JSON-RPC。TS 加 Ajv 8 作为生成阶段依赖，输出 standalone validator 避免浏览器 eval；Schemars 生成 draft-07，所有格式/范围自定义校验由 core 导出正负向量。新增依赖在任务 PR 记录用途、许可、最低平台与替代评估；精确解析版本提交锁，不在此猜测未检索包 patch。
4. Host 用 `host-v0/state.sqlite3`（新命名空间）保存身份、epoch、授权、接纳/dispatch/回执、CAS 文档与文件引用。SQLite `journal_mode=DELETE,synchronous=FULL,foreign_keys=ON`，事务串行，检查点不阻采集；控制请求有专用队列。不得把 SQL signed INTEGER 用于 U64：存规范十进制 TEXT，在 Rust 检查加法/排序。配置导出为规范 JSON，导入须明确操作；无旧软件格式迁入。SQLite 原子性依赖实际 fsync/设备，测试注入存储失败，真实断电留 M6，见[原子提交](https://www.sqlite.org/atomiccommit.html)。
5. 单实例锁用 `std::fs::File::try_lock`，锁对象整个 Host 生命周期持有；锁文件永不按年龄删除。发现记录原子更新，包含 hostId/epoch/endpoint/PID/版本，不含 secret；只有取得锁的进程可修复遗留 endpoint。当前 Rust 已提供[文件锁](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)。
6. 本地传输：Windows named pipe（当前用户 SID 的显式 DACL、拒远程连接、首实例检查）；Unix 私有 0700 runtime 目录内 0600 Unix socket，核对 peer UID。默认 DACL 可能允许 Everyone 读，必须显式设置，见[微软说明](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。握手还验证 Host 身份及 client credential；注册新 CLI/MCP actor 默认 metadata.read，一次用户授权后复用范围。凭据由 Host 生成，Windows DPAPI current-user 保护、Unix 当前用户私有 0600 credential 文件；不进 argv/URL/日志。M2 再加浏览器配对、轮换和 LAN；M1 不开 TCP 监听。
7. IPC 外壳为四字节大端长度 + UTF-8 JSON `WireFrame={requestId,channel: control|raw|state,body}`；每连接独立受限队列，控制物理连接与原始流物理连接分开、以已认证 attach token 关联。无信用不能挤占停止通道。初始限额在 `limits.rs`：request=1 MiB、page=100、batch=256 KiB、reader=4 MiB、session raw ring=16 MiB、capture queue=16 MiB、session TX queue=4 MiB/128 项、每 Host 16 session/64 reader/256 在途 operation、lease TTL=30000ms；全 Host 原始缓存=128 MiB，reader 配额总计=128 MiB，capture 总计=64 MiB，控制队列=256 项并为 cancel/shutdown 预留32。溢出接纳前拒绝 HOST_BUSY/LIMIT_EXCEEDED；停止后释放预算。默认值是可测起点，Task 13 记录实测后调整并更新握手，不能冒称性能达标。
8. 每个设备一个后端 owner 线程，读周期最多20ms，写分块最多16 KiB并在分块间检查取消、epoch/lease/权限；session.tx 最大解码长度为16KiB，超限在schema校验阶段返回LIMIT_EXCEEDED；更大数据使用显式transfer.file任务，不隐式拆成多个逻辑请求。RX 只分配共享 `Arc<[u8]>` 载荷并送有界环，序列化在 reader 端完成。不做设备 IO 时持 registry/全局锁；每会话独立仲裁，普通 TX 整个请求不交错，按 actor FIFO 轮转防饥饿。未知 OS 写入返回 unknown，不将等待超时当作零副作用。
9. capture 新容器为目录：`manifest.json`、顺序 `volume-000001.swbr`、`index.json`。卷头 magic=`SWBR01\n`；记录为 u32 LE 长度、UTF-8 JSON `CaptureRecord`、32 字节 SHA-256（上限1MiB），含 recordOrdinal 与 RawEvent/最终回执更新，索引记录偏移与范围；卷摘要和前卷摘要串接。默认64MiB/60分钟轮转；完整记录不跨卷。无压缩/mmap/数据库导出；这些留相应后续矩阵切片。

CI 基线已确认保留 `scripts/ci-quality-gate.mjs`、`scripts/ci-quality-gate.test.mjs`，新增 `scripts/ci-workflow.test.mjs`；Task1修改这三个实际入口的workspace/cache断言。四目标为Windows x64、macOS arm64/x64、Linux x64，具体runner标签沿CI基线维护，不凭本机推断。M1a/M1b在审查候选提交上手动触发ci.yml，保存run URL及commit；通过后squash无需每个小提交重复跑，若合并改变内容则重新验证相关范围。

## M1a：核心、Host、CLI/MCP 闭环

### Task 1：公共 DTO、生成契约与 workspace

**Files:** Create 根 `Cargo.toml`、`.cargo/config.toml`、`crates/core/Cargo.toml`、上述 core DTO 文件、`crates/core/tests/wire_contract.rs`、`scripts/generate-host-contracts.mjs`、`packages/contracts/package.json`/`src/index.ts`；Modify 工程选择 1/2 的文件、`package.json`、`pnpm-workspace.yaml`、`vitest.config.ts`、`tsconfig.json`、`eslint.config.js`、`scripts/eslint-boundaries.test.mjs`、锁文件；其他成员随实际实现加入 workspace。

**Interfaces:** Consumes M0 Host/Stream 定义。Produces `pub struct U64(u64)`（私有字段），`impl TryFrom<&str> for U64`、`impl From<u64> for U64`；`pub fn checked_next(&self)->Result<U64,HostError>`；`pub type HostResult<T>=Result<T,HostError>`；`Call,ChildCall,Query,Target,ObjectRef,RevealTarget,Operation,RawEvent,StreamItem,ReaderGap,RawBatch,StreamReadParams,StreamReadResult,StreamSubscribeParams,StreamSubscribeResult,StreamCreditParams,StreamCreditResult,TxReceipt,ConfigReceipt,BreakReceipt,Cursor,Snapshot,Delta,Limits` 精确按合同。`RpcRequest` 为方法名 tagged union；业务 `params` 边界为受限 JsonValue，registry 解为具名 DTO。`ActionSpec::of<I: JsonSchema,O: JsonSchema>(...)` 生成 schema；`pub fn builtin_catalog()->Vec<ActionSpec>`。后续任务添加 DTO 必经本生成链。Operation 的 admission/rootOperationId/childHighWatermark 按修订合同生成，M1 根任务初始化对应字段；ChildCall 的插件执行入口在 M2 实现，M1 不注册尚未实现的子调用能力。

- [x] **Step 1：写 red 测试。** `wire_contract.rs` 断言 `"9007199254740993"` roundtrip，`"18446744073709551615".checked_next()` 为 COUNTER_EXHAUSTED，`01/+1/1e3/JSON number` 拒绝；Call 缺 requestContext/epoch/revealTarget 拒绝；Operation 拒绝 state=`partial`。脚本测试断言根 lock/package 身份和 target 缓存位置。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-core --test wire_contract`；新 crate/未实现 API 失败后才实现。初次加依赖由协调者先生成审阅锁，再恢复 `--locked`；不把缺锁红灯当行为红灯。
- [x] **Step 3：实现 DTO 与导出。** `export-contracts` 只写参数指定目录；生成 `types.ts,schemas.json,catalog.json,fixtures.json`；脚本用 Ajv standalone 生成 validators。`parseReply(value: unknown): RpcReply` 在 contracts index 使用生成验证器，错误为 ContractValidationError；禁止第二份手写 DTO。新 package workspace 包 `@serial-workbench/contracts`/`@serial-workbench/host-client`。新增 `pnpm contracts:generate`/`:check`；保留原 `bindings:*` 用于 Tauri 本地命令。Vitest include/coverage加入 `packages/*/src/**/*.{test,spec}.{ts,tsx}` / `packages/*/src/**/*.{ts,tsx}`，TS include加入packages源码，ESLint对手写packages启用同样unknown/no-any/边界规则而排除generated；防止定向测试实际零匹配。根workspace.package.version与所有成员version.workspace对齐；init/version脚本改为从根读写共享版本，桌面name/default-run仍从src-tauri维护，锁文件逐个核对全部自有包版本，不再假设只有一个本地包。
- [x] **Step 4：执行 green。** 上述 Rust 测试；`node --test scripts/version.test.mjs scripts/init-project.test.mjs scripts/build.test.mjs`；`pnpm contracts:generate` 后 `pnpm contracts:check`；`pnpm version:check`/`pnpm config:check`。TS 运行同 fixture，U64/bytes/nullable 一致；检查 core 的依赖树无 tauri/node。
- [x] **Step 5：纳入 M1a 基础里程碑。** 本任务与 Task1—4 的实现、测试、审阅修正和配套文档集中交付。

### Task 2：持久身份、操作去重与恢复

**Files:** Create `crates/host/src/storage/{mod,db,operations,documents}.rs`、`crates/host/src/auth/{context,identity}.rs`、`crates/host/src/storage/operation_recovery_tests.rs`、`crates/core/src/clock.rs`。

**Interfaces:** Consumes Task1 DTO。Produces `Store::open(path:&Path)->HostResult<Store>`；`Store::begin_instance()->HostResult<HostIdentity>`；`Store::accept(actor:&AuthenticatedActor,call:&Call,digest:&Digest)->HostResult<Acceptance>`，`Acceptance=New(Operation)|Existing(Operation)`；`Store::mark_dispatch(id:&Id)->HostResult<()>`；`Store::settle(id:&Id,outcome:Settlement)->HostResult<Operation>`；`Store::record_result_evidence(id:&Id,value:&OperationValue)->HostResult<Operation>` 保存运行中已确认结果并推进 revision，恢复时保留证据；`Store::recover()->HostResult<Vec<Operation>>`。`Clock: Send+Sync { fn mono_ns(&self)->u64; fn wall_time(&self)->Timestamp; }`，`ContextSigner::issue/validate` 接收 `&AuthenticatedActor,&HostIdentity,&dyn Clock`，返回 `RequestContext`/`HostResult<ValidatedContext>`。新类型由所属模块定义再导出。

- [x] **Step 1：写 red。** H02/H03/H04/H11：并发同参只一接纳；异参 REQUEST_CONFLICT；墙钟倒拨48h不延长24h窗口；重启 epoch+1，原 invoke 拒绝但 get 可查；dispatch 前后 kill 分别 interrupted/unknown。`assert_eq!(backend.write_count(),1)` 独立于 Operation 状态；存储拒写时计数0。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --lib storage::operation_recovery_tests`。
- [x] **Step 3：实现。** 接纳/唯一键事务先于副作用；canonical digest 按合同包含执行模式/revision/lease，排除 revealTarget。保留期7天、在途不淘汰、到期 context 不复活。签发 HMAC-SHA256 随机keyId上下文，固定长度解析与恒时验证；未知 keyId RESULT_EXPIRED。恢复只结算，不自动重开/重发。SQLite 通过有界 writer 线程，发送线程不等待数据库锁而阻 RX。
- [x] **Step 4：执行 green。** 同命令，增加完整 U64 TEXT 保存/读回和未来 DB user_version 拒写/原件 hash 不变。进程级 crash fixture 使用专属 temp profile，故障点仅测试构建启用。
- [x] **Step 5：纳入 M1a 基础里程碑。** 本任务与 Task1—4 的实现、测试、审阅修正和配套文档集中交付。

### Task 3：当前用户 IPC、单实例与授权

**Files:** Create `crates/ipc/src/{lib,frame,identity,windows,unix}.rs`、`crates/core/src/{ipc,auth}.rs`、`crates/core/tests/ipc_contract.rs`、`crates/host/src/ipc/{mod,instance,server}.rs`、`crates/host/src/auth/{mod,grants}.rs`、`crates/client/src/{lib,connection,discovery}.rs`、`crates/host/tests/{instance_lock,ipc_security}.rs`；Modify `crates/host/src/main.rs`。

**Interfaces:** Consumes Store/HostIdentity/ContextSigner。Produces `InstanceGuard::acquire(profile:&Path)->HostResult<InstanceGuard>`；`HostClient::connect(options:ConnectOptions)->HostResult<HostClient>`（async），`HostClient::request(&self,request:RpcRequest)->HostResult<RpcReply>`（async）；`AuthenticatedActor { actor_id:Id,client_id:Id,grant_revision:U64 }` 仅由 auth 构造。`AuthorizeParams { client_id,permissions,targets,expires_at? }`、`RevokeParams { actor_id,permissions,targets }` 生成目录；`AuthService::require(&AuthenticatedActor,permission:&str,target:&Target)->HostResult<()>`。

- [x] **Step 1：写 red。** 同 profile 启动20进程仅1持锁；活锁忙返回 HOST_BUSY；stale PID 不抢锁；发现伪造 hostId 拒绝。错误SID/UID、超长帧、半帧断开、伪 actor、旧 token 均零副作用。新 MCP actor只能 metadata；获得 content 后撤销，旧引用拒绝。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test instance_lock --test ipc_security`。
- [x] **Step 3：实现。** 共享帧、平台连接/peer 与受保护秘密存储归独立 `crates/ipc`，Host/Client 均依赖它；core 只提供生成 DTO。普通 Authenticate 与 AuthenticateUserControl 使用独立凭据，选消息类型或 clientKind 不授予权限；用户控制 cap 只由明确的本地用户入口取得，启动时通过专用继承 stdout pipe 交接（u32 BE 长度 + 1—2048 字节），常规启动不输出 cap。有限期 grant 在签发实例用单调期限，重启后保守失效；永久 grant 按持久授权复用。 Host 二进制支持 `--profile <dir>` 与受限内部启动管道；生产默认从平台应用数据目录生成独立 host-v0 profile。CLI `authorize` 是用户明确控制入口，不因 clientKind 或声明 desktop 提权；桌面授权提示显示 actor/范围，可信启动凭据经继承句柄交接，不允许外部 MCP伪造。去重按执行 hostId，设备 ID 不接受裸路径或其他 Host ID。连接中断只释放 reader/客户端控制，不退出 Host。
- [x] **Step 4：执行 green。** 同命令；Windows 检查真实 pipe DACL，Unix 检查 socket/目录mode与peer credential。未运行平台标待验，不用条件跳过冒充通过；父测试停止其持有 PID，禁止杀同名全局进程。
- [x] **Step 5：纳入 M1a 基础里程碑。** 本任务与 Task1—4 的实现、测试、审阅修正和配套文档集中交付。

### Task 4：统一目录、dispatcher、快照与活动

**Files:** Create `crates/host/src/{registry,dispatch,state}.rs`、`crates/host/tests/{catalog,projections}.rs`；Modify `crates/core/src/catalog.rs`。

**Interfaces:** Consumes Task1—3。Produces `Host::query(actor:&AuthenticatedActor,query:Query)->HostResult<QueryResult>`、`Host::invoke(actor:&AuthenticatedActor,call:Call)->HostResult<Operation>`（均 async）；`Registry::list(actor:&AuthenticatedActor,params:CatalogListParams)->HostResult<CatalogPage>`；`ProjectionStore::snapshot(scope:&Id)->HostResult<Snapshot>`、`subscribe(scope:&Id,after:&Cursor)->HostResult<Subscription>`。`QueryResult`/`ActionResult` 是生成 tagged union；没有 `unknown` 成功载荷。每个 handler 的 actionId、schema、授权、state scope、取消和 reveal 映射注册一次。

- [x] **Step 1：写 red。** H05/H06/H08：快照10后提交11/12再订阅均收到；旧cursor返回 CURSOR_EXPIRED；撤权清空未投递正文；换权限后旧pageToken CATALOG_CHANGED。错误 target.id/sessionId 拒绝。所有目录项都有合法 pageId，查询也产生活动但轮询复用原记录。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test catalog --test projections`。
- [x] **Step 3：实现。** dispatcher 顺序为认证/权限/epoch/规范化参数/容量/去重/持久接纳/调度，真正副作用前复查授权/epoch/lease。内部 QueryContext 绑定活动ID；状态 scope 独立 revision和ring历史。`host.activity`、`host.operations`、`host.devices`、`workspace:<id>`、`session:<id>` 为固定scope规则。状态队列耗尽结束订阅并要求新快照，不丢增量继续假装连续。
- [x] **Step 4：执行 green。** 同命令与 `pnpm contracts:generate`/`:check` 顺序运行。验证未授权动作不被发现、直接invoke仍拒绝；已授权错误详情不包含路径/secret。
- [x] **Step 5：纳入 M1a 基础里程碑。** 本任务与 Task1—4 的实现、测试、审阅修正和配套文档集中交付。

### Task 5：Virtual 会话、发送仲裁与控制状态机

**Files:** Create `crates/core/src/transport.rs`、`crates/host/src/device/{mod,virtual_backend,sessions}.rs`、`crates/host/src/transmission/{mod,scheduler,leases,controls}.rs`、`crates/host/tests/{session_tx,control_state}.rs`。

**Interfaces:** Consumes Host/Store/Clock。Produces `trait Transport: Send { fn capabilities(&self)->TransportCapabilities; fn read(&mut self,limit:usize,wait:Duration)->BackendResult<ReadBlock>; fn write(&mut self,bytes:&[u8],wait:Duration)->BackendResult<BackendWrite>; fn configure(&mut self,config:&SerialConfiguration)->BackendResult<ConfigApplication>; fn control(&mut self,command:ControlCommand)->BackendResult<ControlResult>; fn close(&mut self)->BackendResult<()>; }`。`BackendWrite { accepted_ranges,unknown_ranges,error }` 不把错误丢失前缀；`ReadBlock` 保存stream/message语义。`DeviceService::open(target:&Target,params:OpenParams)->HostResult<OpenResult>`、`TransmissionService::submit(operation:&Operation,params:TxParams)->HostResult<TxReceipt>`（async）；其余 handler 名为 `configure/control/break_signal/purge/wait_boundary/drain/queue_status`，输入输出使用对应生成 Params/Receipt。

- [x] **Step 1：写 red。** S01—S06/S11：同设备两 open只一次；不同配置冲突；5字节只接受3返回 partial；dispatch无回执unknown；旧epoch排队写0次；部分配置gate关闭；BREAK清线失败隔离且重连0次；purge不改既有TX；lease过期不续活。Clock fake验证queueWait/writeWait/ttl独立起算。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test session_tx --test control_state`。
- [x] **Step 3：实现。** Virtual 正式可选设备，默认 deterministic echo，可配置脚本化独立对端fixture。会话ID在Host命名空间、同资源单owner，open/reopen持久推进epoch。完整配置模型：baudRate U64、dataBits `5|6|7|8`、parity `none|even|odd|mark|space`、stopBits `one|onePointFive|two`、flowControl `none|rtsCts|xonXoff|dsrDtr`、读/写/重连时限；wire dataBits 用字符串枚举避免含混计数。readOnly 从 Host gate 检查全部 TX/config/control，观察仍可进行；`session.setReadOnly` 用 `{readOnly:bool}`、expectedRevision和device.modify，解除只读必须是独立明确操作，不在TX中自动解除。注册 session.close/tx/configure/control/break、lease三动作、takeover、队列四动作和连接查询。
- [x] **Step 4：执行 green。** 同命令；两个session一方阻塞不阻另一方、actor公平性和取消结算测试。人工接管停止目标actor新写、终结旧队列，恢复跟随不恢复权限/队列。
- [ ] **Step 5：纳入M1a交付。** 保留本任务已验证修改，连同审阅修正和配套文档在M1a出口统一提交，不创建单独的中间提交。

### Task 6：原始流与有界独立 reader

**Files:** Create `crates/host/src/stream/{mod,ring,reader,credit}.rs`、`crates/host/tests/stream_budget.rs`；Modify `crates/host/src/lib.rs`、`crates/core/src/stream.rs`。

**Interfaces:** Consumes RawEvent/Transport/Snapshot。Produces `StreamHub::append(event:RawEvent)->HostResult<()>`；`StreamHub::read(params:StreamReadParams)->HostResult<StreamReadResult>`；`StreamHub::subscribe(actor:&AuthenticatedActor,params:StreamSubscribeParams)->HostResult<StreamSubscribeResult>`；`StreamHub::credit(actor:&AuthenticatedActor,params:StreamCreditParams)->HostResult<StreamCreditResult>`。事件内存载荷为Arc字节，wire编码只在边界；保存最终TX意图并关联结算回执，不用晚到TX覆盖事件序号。

- [x] **Step 1：写 red。** S07/S19/S20/S21：快reader与capture hash相同、慢GUI准确reader_gap；批次items明确区分source与reader_gap，投影缺口没有eventSeq且不改源序号；initialCreditBytes=0可用初始after游标授首批额度；重复累计grant不加倍；超前/非批边界ack拒绝；无ack不能无限credit。缺口/epoch变化重置UTF-8消费。任何超大单事件在采集处拆为≤16KiB记录，不能通过overflow丢尾。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test stream_budget`。
- [x] **Step 3：实现。** RX方向offset按后端实际完整长度，TX按意图长度，eventSeq单调；原始源缺口与reader投影缺口分开。JSON实长扣credit；队列和全局配额都计载荷+元数据/编码缓冲，不只计payload。GUI drop_with_gap，capture默认stop；flow_control只有后端声明且用户明确许可。保留控制通道；正文撤权即时释放待投递缓存。
- [x] **Step 4：执行 green。** 同命令，注入8MiB输入、4MiB reader配额，观测peak不超过声明上限加一个批次的固定编码暂存；停止请求在fake慢reader情况下有响应，测试不要求真实时钟精度。
- [ ] **Step 5：纳入M1a交付。** 保留本任务已验证修改，连同审阅修正和配套文档在M1a出口统一提交，不创建单独的中间提交。

### Task 7：CLI 与官方 MCP 的同 handler 闭环

**Files:** Create `crates/cli/src/{main,args,output}.rs`、`crates/mcp/src/{main,server,catalog}.rs`、`crates/mcp/tests/stdio_roundtrip.rs`、`crates/host/tests/client_parity.rs`；Modify registry/生成物由协调者独占。

**Interfaces:** Consumes HostClient、generated CatalogPage/Call/Query。Produces CLI `serial-workbench-cli catalog --json`、`context --out <file> --json`、`query <actionId> --target-json <file> --params-json <file> --json`、`invoke <actionId> ... --request-id <uuid> --request-context-json <file> --json`、`operation get/cancel <id> --json`、`operation get --request-id <uuid> --request-context-json <file> --json`、`authorize/revoke`、`host stop`；所有命令接受 `--profile <dir>`。用户已确认采用显式 Host 签发上下文文件，调用和重试复用同一文件，不自动管理跨进程上下文缓存。MCP `serial-workbench-mcp --profile <dir>` STDIO；`McpBridge::new(client:HostClient)->Self`，官方 `ServerHandler::list_tools/call_tool` 转发目录和调用。操作示例见[开发指南](../../development.md#独立-hostcli-与-mcp)。

- [x] **Step 1：写 red。** SDK client启动MCP子进程，initialize/list_tools/call_tool，Virtual open→TX→读流→operation.get→close；CLI/HostClient/MCP三路径取得相同sessionId/epoch/回执。无授权仅元数据工具，授予后通知tools/list_changed；分页token和业务错误结构可读。stdout仅协议/机器结果，日志stderr。
- [x] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-mcp --test stdio_roundtrip`，再 `cargo test --locked -p serial-workbench-host --test client_parity`。
- [x] **Step 3：实现。** 每个actionId对应独立工具，工具名为 `swb_`+actionId逐字节转义（仅ASCII字母/数字保留，其余包括下划线为 `_xHH_`）；目录验证长度/唯一。工具输入是该动作参数加target/expectedRevision/lease/executionMode；actor/context/epoch由已认证client填充，保留调用者requestId映射。长任务即时返回Operation，取消必须显式operation.cancel，MCP取消通知只取消适配器等待。订阅内容不塞进无限工具返回。使用[官方 Rust SDK](https://docs.rs/rmcp/3.9.0/rmcp/)；动态列表实现SDK trait，不保留旧六工具协议。
- [ ] **Step 4：执行 green。** 上述命令；对每个M1目录项做schema可发现/adapter可调用表驱动测试，业务结果由领域测试负责。Host重启后适配器重attach并查旧O，不换ID自动重试；无GUI时client目标动作返回CLIENT_REQUIRED。实际Codex客户端交互验收单列，不把SDK对端冒充真实产品客户端。
- [ ] **Step 5：M1a 功能闭环提交与集成。** 已交付的基础里程碑之上，Task5—7 实现、测试、审阅修正和文档全部通过后，统一提交 `feat(host): 完成M1a共享Host与CLI和MCP闭环`，PR 自审后 squash 合入 main 并删除分支；账本只标对应软件切片，继续 M1b。

## M1b：真实串口、录制与桌面工作区

Task 8/9 的后端与 Task10 的capture可在Task5/6接口就绪后并行；Task11客户端可消费已生成接口并行开发。共享manifest/lock/registry/generated由协调者串行集成，所有任务最后汇合Task12/13。

### Task 8：目录、设备身份、收藏与安全重连

**Files:** Create `crates/host/src/device/{discovery,identity,reconnect}.rs`、`crates/core/src/device.rs`、`crates/host/tests/device_identity.rs`。

**Interfaces:** Consumes DeviceService/Store/Clock。Produces `DeviceDescriptor { device_id,host_id,system_name,description?,manufacturer?,driver?,fingerprint,capabilities }`；`DeviceFingerprint { transport,vid?,pid?,serial_number?,topology_path?,evidence }`，缺失字段保持None；`IdentityMatcher::match_device(saved:&DeviceFingerprint,candidates:&[DeviceDescriptor])->MatchResult`，`MatchResult=Exact(Id)|RequiresRebind(Vec<Id>)|Missing`；`DeviceService::refresh()->HostResult<Vec<DeviceDescriptor>>`、`rebind(params:RebindParams)->HostResult<DeviceBinding>`。

- [ ] **Step 1：写 red。** 两同型号无serial不可按COM顺序自动选；已绑定设备重编号但可靠唯一证据允许恢复；拓扑变化/多候选RequiresRebind；用户明确rebind后再开。收藏和最近CAS冲突保留草稿；断连后旧队列拒绝，新epoch保存显示缓冲。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test device_identity`。
- [ ] **Step 3：实现。** M1每500ms异步目录差分轮询并提供立即refresh，避免平台事件丢失；仅变化发布revision。OS字段用实际来源，无法查占用者只给已知错误与系统检查步骤。最近记录在成功open时更新；收藏/重绑定由workspace.modify动作保存。自动重连默认关闭，开启后初始500ms、×2至30000ms、默认10次，可配置；每次重新验证身份，清线/config gate未结算不尝试。
- [ ] **Step 4：执行 green。** 同命令含fake时钟退避取消；一次目录失败保留最后快照并标stale，不把全部设备当拔除。注册 device.list/refresh/rebind、favorites.save、recent.list，GUI/MCP复用。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 9：OS 串口、PTY 与平台能力

**Files:** Create `crates/host/src/device/serial/{mod,windows,unix,linux,macos}.rs`、`crates/host/tests/{serial_backend,pty_roundtrip}.rs`、`docs/serial-platform-capabilities.md`；Modify相关target dependencies由协调者完成。

**Interfaces:** Consumes Task5 Transport与Task8目录。Produces `SerialProvider::enumerate()->HostResult<Vec<DeviceDescriptor>>`；`SerialProvider::open(device:&DeviceDescriptor,configuration:&SerialConfiguration)->HostResult<Box<dyn Transport>>`。后端错误 `BackendError { code,os_code?,known_accepted_ranges,unknown_ranges }`；向用户错误去掉路径/未经证实的进程名。

- [ ] **Step 1：写 red。** 独立OS调用适配替身测试5/6/7/8、mark/space、1.5 stop、dsrDtr编码和不支持组合拒绝，读回不能复制请求；Windows partial overlapped write取消保存范围，Unix EIO/ENODEV断连；PTY独立进程对端任意分块字节hash一致。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test serial_backend --test pty_roundtrip`；Unix PTY仅目标平台运行，Windows不将跳过计入PTY通过。
- [ ] **Step 3：实现。** 使用现有windows-sys和Unix libc直接平台API，避免用缺少Mark/Space/1.5/DSR-DTR的高层配置枚举缩减产品模型。Windows CreateFile独占、OVERLAPPED IO/CancelIoEx、DCB/GetCommState、ClearCommError、EscapeCommFunction、PurgeComm；枚举SetupAPI读硬件/驱动属性。Linux termios/termios2 ioctl支持非标准baud，CMSPAR依能力、TIOCEXCL、TIOCMGET、TIOCOUTQ、TIOCSBRK/TIOCCBRK；macOS IOKit目录、termios/IOSSIOSPEED，系统未支持组合精确UNSUPPORTED_CAPABILITY。OS映射函数与unsafe封装局限到平台文件，驱动读回决定能力。参考[DCB](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb)和[termios](https://man7.org/linux/man-pages/man3/termios.3.html)，不得以sleep模拟已确认drain或线状态。
- [ ] **Step 4：执行 green。** 同命令；真实PTY验证RX/TX/purge/drain取消；mock只证明平台调用参数，硬件速率、输入边沿/收到BREAK和控制线电平列M6。M1提供输出控制与输入采样，unsupported显式显示。阻塞drain放专有可取消后端路径，不能卡Host退出；无法证明结束则unknown并隔离句柄。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 10：有界 capture、验证前缀与只读回放

**Files:** Create `crates/core/src/capture.rs`、`crates/host/src/capture/{mod,format,writer,verify,recovery,replay,text_export}.rs`、`crates/host/src/files/{mod,references}.rs`、`crates/host/tests/{capture_integrity,capture_recovery,replay_readonly}.rs`、`docs/contracts/capture-container-v0.md`。

**Interfaces:** Consumes StreamHub/Store/Operation。Produces `CaptureService::start(params:CaptureStartParams,owner:&Operation)->HostResult<ObjectRef>`、`stop(ref:&ObjectRef)->HostResult<CaptureSummary>`、`verify(ref:&ObjectRef)->HostResult<VerificationReport>`、`recover_prefix(params:RecoverPrefixParams)->HostResult<ObjectRef>`（async）；`ReplayService::open(ref:&ObjectRef)->HostResult<OpenResult>`；`FileService::register(params:RegisterFileParams,actor:&AuthenticatedActor)->HostResult<ObjectRef>`。`CaptureRecord { record_ordinal:U64,entry:CaptureEntry }`，`CaptureEntry=Event(RawEvent)|TxSettlement(TxReceipt)`，TX结算可晚于意图但必须唯一引用operationId。文件对象由本地可信用户选择/CLI显式登记获得作用域，不允许业务params任意路径。

- [ ] **Step 1：写 red。** S08—S10/S15/S16：满盘capture failed且快reader继续；卷2损坏止于连续前缀；恢复原件hash不变；源变化/目标碰撞拒绝；索引缺失不能complete；replay.open设备写次数0，unknown尾段仍unknown；partial TX回执在capture roundtrip不丢。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test capture_integrity --test capture_recovery --test replay_readonly`。
- [ ] **Step 3：实现。** 格式按工程选择9；正常stop完成flush/sync/独立readback验证才complete，水位单调且verified≤synced≤flushed≤written，包括manifest/index。create_new默认；append仅同format/source/config且前段已验证，先新卷再提交索引；replace需要显式expectedFingerprint，旧目标先归档再原子发布，失败保留原件与证据。恢复始终另存且no-clobber，源句柄身份+hash二次校验；未来格式只读拒写。容量默认1GiB、磁盘余量128MiB，达到即停止并保留证据；默认raw，M1不给未实现redacted选项，传redacted返回UNSUPPORTED_CAPABILITY而非偷偷存raw。只读回放按原时序/最快两模式，可暂停/seek并重置读者；单步/断点和设备transmit留M4。文本导出保留timestamp/direction/offset与替换字符标记，可回查原始文件。
- [ ] **Step 4：执行 green。** 上述命令+固定样本从捕获到独立读取器比对全部事件/最终回执hash；注入慢盘、只读目录、卷跨界取消、manifest提交失败。文件路径抵御父目录跳转、symlink/reparse替换和目标竞态；metadata权限不暴露正文/真实路径。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 10a：裸文件发送、分块节流与任务取消

**Files:** Create `crates/core/src/transfer.rs`、`crates/host/src/transmission/file_transfer.rs`、`crates/host/tests/file_transfer.rs`；Modify `crates/host/src/transmission/mod.rs`、registry/生成契约（协调者负责）。

**Interfaces:** Consumes Task5 TransmissionService、Task10 FileService。Produces `FileTransferParams { source_ref:ObjectRef,offset:U64,length:U64,chunk_bytes:U64,bytes_per_second:U64,inter_chunk_ms:U64,write_wait_ms:U64 }`、`FileTransferResult { requested:U64,accepted:U64,unknown:U64,receipts_ref:ObjectRef,peer_acknowledged:bool }`；`FileTransferService::run(operation:&Operation,params:FileTransferParams)->HostResult<FileTransferResult>`（async）。actionId=`transfer.file`，target=session，executionMode必须independent，permission为content.read+device.modify；lease由owner内部申请exclusive，不让调用者为每块创建新普通TX。

- [ ] **Step 1：写 red。** `file_transfer_preserves_partial_and_cancel`：5字节源分2字节块，第二块接受1后取消，`assert_eq!(result.accepted, U64::from(3)); assert_eq!(backend.bytes(), &[1,2,3]); assert!(!result.peer_acknowledged);`。错误source revision、文件变更、旧epoch均在相应块提交前拒绝；取消后未读块不再读、不再入队。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test file_transfer`。
- [ ] **Step 3：实现。** 默认chunk=4096、最大16384；bytesPerSecond正数上限按设备capability与Host预算，interChunkMs允许0=无额外延时、否则合同timer范围；单调deadline令牌桶不累积无限突发，最多一块信用。每块读FileRef固定revision并按共同TX路径持久意图/回执；保留整个owner租约直到取消/结果结算，不允许普通TX插入文件。文件读失败保留已写前缀；回执列表超过maxBatchBytes放授权ObjectRef。M1仅原样字节，文本转码/字符与行延时由M4扩展，不悄悄改文件。
- [ ] **Step 4：执行 green。** 同命令，fake clock验证块间限速/取消无需真实sleep；独立软件对端校验SHA-256，区分Host接受与对端证据。GUI/MCP/CLI相同调用取得同operation和进度，reader继续采集。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 11：Host 权威设置、工作区与生成 TS 客户端

**Files:** Create `crates/host/src/settings/mod.rs`、`crates/host/src/workspace/mod.rs`、`crates/host/tests/shared_documents.rs`、`packages/host-client/src/{client,projection,utf8,hex,transforms}.ts` 与同名测试；Modify `crates/core/src/{settings,workspace}.rs`、`src/lib/{settings-model,settings-sync}.ts`、`src/providers/settings.tsx`、`src/providers/settings-context.ts`、`src-tauri/src/storage.rs`。

**Interfaces:** Consumes Store/ProjectionStore/generated DTO。Produces `SettingsService::read()->HostResult<SettingsSnapshot>`/`save(expected_revision:U64,value:SharedSettings)->HostResult<SettingsSnapshot>`；`WorkspaceService::save(expected_revision:U64,value:WorkspaceDocument)->HostResult<WorkspaceSnapshot>`。TS `createHostClient(transport: HostTransport): HostClient`，`HostTransport.request(request:RpcRequest,signal?:AbortSignal):Promise<unknown>`、`HostTransport.openChannel(request:Query,onFrame:(value:unknown)=>void,signal?:AbortSignal):Promise<()=>void>`；`HostClient.query/invoke` 返回生成QueryResult/Operation，`subscribe(scopeId:string,listener:(delta:Delta)=>void,signal?:AbortSignal):Promise<()=>void>`。`IncrementalUtf8.push(bytes:Uint8Array,boundary:boolean):string`，`encodeSend(input:string,mode:"text"|"hex",ending:LineEnding):Uint8Array`。

- [ ] **Step 1：写 red。** H09：两个client基于revision3保存，仅一个成功；外部更新不覆盖草稿；未来format拒绝且原件hash不变。UTF-8每个拆块位置同结果，gap/seek重置半字符；HEX无效输入零invoke；行尾none/CR/LF/CRLF/custom预览等于最终bytes。StrictMode挂卸载两次仅存活一个订阅、晚到结果忽略。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test shared_documents`；`pnpm exec vitest run packages/host-client/src`。
- [ ] **Step 3：实现。** SharedSettings包含语言、主题/token、字体/缩放、motion、更新检查/networkMode/runInBackground偏好和默认终端设置；布局模板包括sidebar/panel尺寸。client窗口几何、当前页/焦点/滚动/follow/未提交编辑留客户端。当前v7设置只作为字段与默认值设计参考，不读取迁入；新formatVersion=0.1，所有默认值由Rust生成，TS模型复用生成类型。桌面storage只保存client实例状态/图库文件，不再第二份共享设置。WorkspaceDocument含具名视图、设备绑定/连接配置、Text/HEX模式/命名/色/图标/pin、layout模板、capture引用；load只恢复配置与可验证显示尾部，连接/发送/脚本不自动启动。新增JSON export/import与`SWB_PROFILE`/`SWB_LOG_LEVEL`启动覆盖，来源可查，敏感字段只引用，不接任意环境变量执行。
- [ ] **Step 4：执行 green。** 两命令、contracts生成/检查、`pnpm typecheck`。新host测试scope revision与导出JSON稳定排序，导入未来版本、损坏和未知字段保持原件。浏览器preview继续单独storage，不使用主机credentials或假称连接真实Host。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 12：桌面桥、最小工作区与 AI 可见操作

**Files:** Create `src-tauri/src/host_bridge.rs`、`src/lib/host-client.ts`、`src/providers/host.tsx`、`src/features/workbench/{device-panel,session-tabs,stream-view,send-panel,capture-panel,operation-panel,activity-panel,workspace-layout}.tsx`及对应测试、`e2e/browser/workbench.spec.ts`；Modify `src/pages/overview.tsx`、`src/routes.tsx`、`src/commands/{types,shortcuts}.ts`、`src/providers/commands.tsx`、`src/lib/tauri.ts`、`src-tauri/src/{lib,bindings,lifecycle,commands,system_commands}.rs`、`src/i18n/{zh-CN,en}.ts`、`src/lib/native-error.ts`。

**Interfaces:** Consumes Task7/10/11。Produces Tauri `host_request(request:RpcRequest,state:State<DesktopHostBridge>)->NativeResult<RpcReply>`、`host_subscribe(request:Query,channel:Channel<Delta>,state:State<DesktopHostBridge>)->NativeResult<Id>`、`host_unsubscribe(subscription_id:Id,...)->NativeResult<()>`；原始批用独立Channel<RawBatch>、不混Delta；RawBatch、StreamItem 与 ReaderGap 直接消费 Task1 依合同生成的类型，不再手写 events-only 副本。TS门面 `getHostClient():HostClient`，provider调用此门面；所有系统服务仍只从tauri.ts进入。目录pageId `workbench/settings/diagnostics` 和panelId `devices/terminal/send/capture/tasks/activity` 固定。

- [ ] **Step 1：写 red。** 无头UI：两标签同端口仅一个open、Text/HEX切换不多订阅；上滚/冻结仅停刷新，capture继续；查找UTF-8文本/HEX字节按原offset跳转；只读模式无法发送/控制；从MCP活动定位同会话且草稿不丢，迟到结果不抢新焦点；label颜色外有名称。旧状态/卸载/StrictMode无悬挂监听。
- [ ] **Step 2：执行 red。** `pnpm exec vitest run src/features/workbench src/providers/host.test.tsx`；原生bridge测试 `cargo test --locked -p serial-workbench --lib host_bridge`（先pnpm build准备dist）。
- [ ] **Step 3：实现。** 工作区有设备侧栏、会话标签、Text/HEX并排/切换、发送输入/行尾预览/回执、capture与任务面板、Host指标和缺口。panel折叠/resize有键盘替代，M1不引入复杂dock框架。M1跟随当前AI activity定位输入/进度/结果，暂停跟随只停导航；接管调用Host动作。窗口动作/剪贴板/系统设置/更新诊断由Host注册client目标能力转发已有Tauri服务；无观看窗口返回CLIENT_REQUIRED，不写另一套handler。Host维护公开设置，客户端仅执行平台效果并回传receipt。CLI/MCP可发现这些功能，禁止保留只能GUI触发的业务按钮。文件发送界面复用Task10a的transfer.file owner与回执。
- [ ] **Step 4：执行 green。** 上述命令、`pnpm bindings:generate`/`:check`（顺序）、`pnpm typecheck`、`pnpm test:ui`。Playwright使用明确preview fixture提供生成契约状态；进程级parity测试证明真实Host，二者分开记录。原生GUI/拖出多窗/DPI/屏读真实验收留后续独立环境。四类诊断向导基于实际open error、编码模式、Gap/队列、disconnect证据提供下一步；不伪造驱动、供电或固件信息。
- [ ] **Step 5：纳入M1b交付。** 按[交付边界调整](#交付边界调整)集中交付已闭合切片，不逐测试或修正提交。

### Task 13：退出、进程边界、软件验收与 M1 PR

**Files:** Create `crates/host/src/shutdown.rs`、`crates/host/tests/shutdown.rs`、`scripts/test-host-scenarios.mjs`/`.test.mjs`、`docs/m1-software-validation.md`；Modify `scripts/{app-build,build-lib,portable}.mjs`及对应测试、`src-tauri/tauri.conf.json`、`.github/workflows/ci.yml`、`docs/{README,development,testing,architecture,product-scope}.md`、`docs/superpowers/acceptance/feature-status.json`、相关README。

**Interfaces:** Consumes所有服务。Produces `Host::shutdown(mode:ShutdownMode)->HostResult<ShutdownReport>`（async），`ShutdownMode=Settle|CancelAndSettle`；report含未结算operation/隔离session/证据ref。`DesktopExitChoice=KeepHost|StopHost|Cancel`只管理客户端选择；独立Host退出必须走handler。新增 `pnpm test:host` 调用进程场景脚本，不启动桌面。

- [ ] **Step 1：写 red。** capture运行时关闭GUI连接仍写入；显式stop先停止接纳、cancel/清线、capture finalize、释放句柄/锁；清线失败保存unknown和隔离状态，重启不重发。MCP/CLI退出只断客户端；库进程无tauri/Node依赖。脚本缺失/错架构Host拒绝启动，不回退PATH旧版本。
- [ ] **Step 2：执行 red。** `cargo test --locked -p serial-workbench-host --test shutdown`；`node --test scripts/test-host-scenarios.test.mjs scripts/build.test.mjs scripts/portable.test.mjs`。
- [ ] **Step 3：实现。** 打包固定相邻可执行文件/资源路径，desktop仅启动已打包同发行组件Host；Windows后台进程隐藏控制台。`app:build`先构建Host/CLI/MCP再Tauri，artifact清单记录版本/hash/协议；M2补Node/runtime与安装升级事务。退出/更新调用Host quiesce，结算失败保留当前版本/任务证据，不把关闭GUI当Host已退出。场景脚本启动临时profile且只回收其自有进程。
- [ ] **Step 4：执行 green与里程碑验收。** 顺序运行 `pnpm verify`、`pnpm test:ui`、`pnpm contracts:check`、`pnpm bindings:check`、`cargo test --locked --workspace`、`cargo fmt --all -- --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`pnpm test:host`。只在新变化/失败/明确疑点下扩大或重复。测试脚本跑T01/T03/T04/T05/T08和T06 M1预算切片：三客户端相同会话、partial/unknown、UI慢读者、满盘/崩溃、10分钟合成负载，记录RSS/队列峰值/吞吐/p50/p95/p99控制延迟；不据此声明72h/3—12Mbps真机通过。手动触发已启用ci.yml，在独立runner执行四目标编译/测试和已有原生桌面场景，记录实际运行平台；最低系统/硬件电气范围继续M6，不因本机没有其他OS而阻塞可运行的CI软件验收。
- [ ] **Step 5：M1b 里程碑提交与集成。** Task8—13（含10a）全部所需检查与独立审阅通过后，统一提交 `feat(workbench): 完成M1设备录制与桌面软件闭环`；PR 说明字段、权限、窗口生命周期和实际未测范围，squash 合入 main，删除本地/远端分支并核对全历史无 merge commit。账本按各ID的软件/硬件/发行范围链接证据，继续 M2。

## 邻接合同补充与自审结论

这些是已作选择的实施补充，由对应任务在Rust DTO出现时更新合同，不是留给实施者的TBD：Task1补目录action schema/生成方式；Task3补local IPC frame/当前用户凭据、授权与启动握手；Task5补SerialConfiguration，Task10a补文件发送owner；Task10补capture记录/追加覆盖/引用授权；Task11补SharedSettings/WorkspaceDocument/客户端系统能力回执。若M0独立审阅改变公共字段，以协调者合入的合同修订本计划同名接口后再执行，不同时维护两个版本。

自审：全部阶段含M1的矩阵ID在覆盖文件逐项落Task；每Task具Files/Interfaces/red/green/提交点；五个Review Focus均有故障测试；Call/Query/Operation/U64/epoch/actor命名沿M0；partial只作TxReceipt.outcome；控制与原始流独立配额；不恢复旧TX；GUI/CLI/MCP来自同目录。此文的命令是实施时执行步骤，编写计划时未运行Cargo、GUI或修改产品代码。
