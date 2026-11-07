# M0 契约与执行基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可进入 M1 的线性 Git 基线、完整需求状态账本、Host/Node v0 契约和四目标 runtime/平台清单。

**Architecture:** 先将干净主库与市场基座分别经 PR 集成，再从 main 在一个 M0 里程碑中集中交付规划、账本与工程契约。需求矩阵保留唯一需求定义；账本只存状态和证据引用。Rust DTO 在 M1 成为可生成类型/schema 的唯一来源，M0 文档先确定跨客户端与资源生命周期语义。

**Tech Stack:** Markdown、Node 工程脚本/`node:test`、现有 pnpm/Prettier；开发 Node 26.13.0、pnpm 12.16.1、Rust 1.99.1。

**Spec:** [总设计](../specs/2026-11-07-serial-workbench-design.md)、[功能矩阵](../specs/2026-11-07-serial-workbench-feature-matrix.md)、[总推进计划](./2026-11-07-serial-workbench-roadmap.md)。

## Global Constraints

- 本计划继承总推进计划的全部 Global Constraints；范围包含 218 原项、28 旧补充和 LAN-01，共 247 条唯一追踪记录。
- `FUT-10`、`CONN-19` 为排除；`NET-13` 为后续；`FUT-08` 本轮完成 Host 浏览器客户端，零安装 Web Serial 留后续。
- M0 定义 v0 供 M1/M2 验证，M3 才冻结首版受支持契约；M0 完成不能计为串口功能已实现。
- 清爽重构要求优先：进入 M1 前全删旧插件栈，不兼容旧软件 API/数据/插件；文件所有权和验收见 [干净基座计划](./2026-11-07-m0-clean-foundation.md)。
- 新增工程脚本输出/帮助使用英文；自有文档、解释性注释、提交主题/正文和 PR 文案使用中文。全部分支线性，只用 rebase/fast-forward 同步；短名分支完成即合入并删除。
- M0 的规划、账本、合同、测试、审阅修正和文档集中为一个里程碑提交，不执行以下任务中间的单独 commit。
- 对旧代码的可复用判断来自实际源码；迁入时保留实际 MIT 许可和归属，不继承旧项目的通过状态。

## Review Focus

- 矩阵增删、重复 ID 或别名被错误合并：Task 2 用差集、重复和精确计数回归阻止账本漏项。
- 规划状态被当作已通过证据：Task 2 拒绝没有证据的 `passed`，范围跳过必须引用排除/后续依据。
- 大序号、旧 epoch 和未知副作用被错误重试：Task 3 明确 wire 表示与状态机，并用 M1 验收向量固定。
- 远端路径、跨身份结果和插件自授权：Task 3/4 明确提交边界、文件引用复核与执行位置，提供越权向量。
- runtime 可下载却不满足最低系统或离线依赖：Task 5 分开静态兼容核对与目标机器实际离线结果，尤其检查 Linux `libatomic`。

## 文件与责任

| 文件                                                         | 责任                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `docs/superpowers/acceptance/feature-status.json`            | 按 ID 保存 scope、software/hardware/release 状态和证据引用 |
| `scripts/check-feature-status.mjs`、相邻测试                 | 核对矩阵 ID、账本完整性和状态约束                          |
| `docs/contracts/README.md`                                   | 契约索引、v0/v1 状态及事实来源                             |
| `docs/contracts/host-v0.md`                                  | 实例、客户端、能力目录、授权、设置、文件和版本协商         |
| `docs/contracts/stream-and-operations-v0.md`                 | 会话、原始/派生流、TX/控制、任务、录制和恢复               |
| `docs/contracts/node-extension-v0.md`                        | 正式包、后台/Web UI、worker、贡献/信任/升级生命周期        |
| `docs/contracts/runtime-distribution.md`                     | runtime 精确来源/hash/许可、目标依赖、组件组合和验证入口   |
| `docs/adr/0027-shared-host-and-node-extensions.md`           | 独立 Host 与 Node 的长期取舍、代价及旧 ADR 覆盖范围        |
| `docs/superpowers/plans/2026-11-07-m1-host-and-workspace.md` | 依据 M0 契约编写 M1 精确接口、文件、测试和提交任务         |

Task 2、Task 3/4 和 Task 5 可在 Task 1 的开发基线完成后并行，分别拥有账本/脚本、契约、runtime 文档；`package.json`、索引、ADR 与最终 M1 计划由协调者集成。Task 3 先约定动作/流信封，Task 4 再引用；共享字段由 Task 3 维护。

## Task 1：整理既有基线与工具链

**Files:** 既有 `4c2dc63` 空壳切片、`1e2b17c`/`a5c6d41`/`ee2f446` 设计切片；本轮计划文档。基线内容以实际差异复核。

**Interfaces:** Consumes：已备份的既有来源提交（含 `76dfea7`），不要求保留来源分支；Produces：经 PR squash merge 的空壳/规划基线和可运行指定检查的开发环境。

- [x] **Step 1：核对本地与服务端。** 执行 `git status --short --branch`、`git log --oneline --all -8`、`git fetch origin`；读取当前 `main` 保护与合并设置。应为 squash-only、线性历史、禁强推/删除、零人审批、自审。不要把 `.cache/` 中旧快照当作当前服务端结果。
- [x] **Step 2：准备本地工具。** 使用 `.nvmrc` 指定 Node 和 `packageManager` 指定 pnpm；优先工作区内的已验证工具缓存，缺少时从上游获取并核 hash，避免改变系统全局安装。运行 `node scripts/doctor.mjs`，必要项应通过；未安装依赖才执行 `pnpm install --frozen-lockfile`。脚本入口使用 `pnpm run doctor` 或直接 Node，避免与 pnpm 自身 `doctor` 命令混淆。
- [x] **Step 3：保存规划并隔离基线集成。** 来源提交已完整备份；从 main 隔离清理基座，实际交付见 [主库基座 PR #1](https://github.com/YanChao001/serial-workbench/pull/1)。原来源分支迁入后删除，不长期保留。
- [x] **Step 4：完成干净基座并验证。** 先按[清理切片](./2026-11-07-m0-clean-foundation.md)并行删除旧栈，配置/锁/绑定串行集成。 运行 `pnpm verify`、`pnpm test:ui`；随后串行运行 `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`、Cargo fmt/clippy、`cargo check --locked --manifest-path src-tauri/Cargo.toml` 和 `pnpm bindings:check`。已有 `dist/` 后执行 Rust，Cargo/绑定串行。Rust 测试筛选核对是否启动真实 GUI；原生窗口留独立环境。失败先定位并修复相关问题，结果及必要未测范围写 PR。
- [x] **Step 5：完成基线与 M0 PR。** [市场基座 #1](https://github.com/YanChao001/serial-workbench-plugins/pull/1) 和主库基座 #1 已分别 squash 合入，gitlink 使用市场实际主线 SHA。规划、账本与合同经 [M0 PR #32](https://github.com/YanChao001/serial-workbench/pull/32) 集中审阅后 squash 合入；来源和已完成的本地/远端分支、工作树已备份校验并删除。

完成条件：市场、公共壳与规划切片各有 PR，`main` 无新 merge commit；开始后续任务时工作区与实际基线清楚。现有分支不因改名、强推或 reset 丢失来源。

## Task 2：需求状态账本与完整性检查

**Files:** Create `docs/superpowers/acceptance/feature-status.json`、`scripts/check-feature-status.mjs`、`scripts/check-feature-status.test.mjs`；Modify `package.json`（新增 `planning:check`）。

**Interfaces:**

- Consumes：功能矩阵表格中的 247 个原样 ID；需求、归属、阶段与验收正文仍以矩阵为准。
- Produces：`readMatrixIds(markdown: string): string[]` 与 `validateFeatureStatus(matrixIds: string[], document: unknown): string[]`，返回完整错误列表；CLI 读仓库固定路径，有错误退出 1，通过退出 0。
- JSON 顶层为 `schemaVersion: 1`、`features`；每项只有 `id`、`scope`、`scopeNote`、`software`、`hardware`、`release`。`scope` 为 `included | excluded | deferred`；各阶段对象为 `status` 与 `evidence`，状态为 `not-started | in-progress | passed | failed | blocked | not-applicable`，证据为 PR/Release 链接数组。

- [x] **Step 1：写失败测试。** 用小型 Markdown/JSON fixture 断言有效映射返回 `[]`；重复 ID、缺失/额外 ID、未知 schema/状态、没有证据的 `passed` 都返回具体错误。断言 `excluded/deferred` 必须有 `scopeNote`，`included` 不得将 software 标为 `not-applicable`；未来账本 schema 只读拒绝校验通过。
- [x] **Step 2：验证红灯。** `node --test scripts/check-feature-status.test.mjs` 应因导出模块不存在而失败；确认不是 fixture/语法问题。
- [x] **Step 3：实现边界校验及初始账本。** 从矩阵提取 ID，不复制需求正文或导入旧进度。初始纳入软件均为 `not-started`，硬件/发行也不假定已通过；排除/后续按 Global Constraints 填 scope 和矩阵锚点。共享实现保留全部别名行。运行时输入按 `unknown` 语义逐层检查，不写宽松透传。
- [x] **Step 4：验证绿灯。** 运行定向测试和 `pnpm planning:check`；实际矩阵断言唯一 ID 数量为 247，按 ID 集合完全相等。另核对 `FUT-08` 仍为 included，scopeNote 区分本轮 Host 客户端和后续 Web Serial。
- [x] **Step 5：完成账本集成。** 命令入口与检查已接入本阶段交付；由 Task 6 统一提交和合并，账本只链接证据。

## Task 3：Host、流、操作与持久状态 v0

**Files:** Create `docs/contracts/README.md`、`host-v0.md`、`stream-and-operations-v0.md`。

**Interfaces:** Consumes：总设计第 3—6、8、11—12 节；Produces：供 M1 Rust DTO 与 handler 实现的稳定命名、字段语义和验收向量，供 Task 4 引用的动作/订阅信封。

- [x] **Step 1：写实例和动作合同。** 固定 `hostId`、`instanceEpoch`、`protocolVersion`、`catalogVersion`、`actorId`、`requestId`、`operationId`、`sessionId`、`sessionEpoch`、`revision`、`cursor` 的作用域与 wire 表示；大序号不能经过 JS 浮点数丢精度。定义 attach/handshake、目录查询、动作调用、operation 查询/取消、snapshot+cursor 与增量订阅的输入/结果/错误及支持版本。
- [x] **Step 2：写所有权和副作用状态机。** 明确唯一物理持口、多个独立 reader、配置 CAS、普通/事务/独占租约、过期/接管/撤权、任务负责人和真实终态。去重覆盖 actor/request/target/摘要、相同请求返回已有 operation、冲突拒绝、到期 tombstone 和崩溃 unknown；不得把取消等待当作未发送。
- [x] **Step 3：写流、TX、控制和录制合同。** 区分流式/报文式、RX/TX/Gap/配置生效边界、源端单调/墙钟/接收时间、字节区间与派生来源。定义最终 TX 字节/accepted/partial/unknown、独立超时、配置部分成功暂停 TX、BREAK assert/clear 责任、应用队列/OS 队列/drain/purge 的区别。录制定义 written/flush/sync/verified、水位与终态、跨卷验证和前缀另存、只读回放与显式发送回放、未来格式与源文件冲突保护。
- [x] **Step 4：写权限与客户端规则。** GUI/CLI/MCP 使用同一 handler；元数据/脱敏摘要、正文/原始流、设备修改、任意代码、插件管理分别授权。结果/快照/进度/事件/错误/引用统一过滤和重新复核。客户端导航/草稿/焦点与共享业务分开；所有功能有 `revealTarget`。浏览器 loopback 同源校验与配对；LAN 固定执行 Host，转发保留 actor/request，文件用引用而非跨机路径。
- [x] **Step 5：写可直接迁为测试的向量并复核。** 至少包含：两个客户端同端口只开一次；`2^53+1` 序号往返；同 ID 同参/异参/过期；旧 epoch 写入；部分/unknown 查询；配置部分应用；BREAK 清线失败；快照与订阅交界/游标过期；慢 reader/满盘；源变化/目标碰撞；撤权后读取旧结果引用；A 失联租约终止/B 独立任务继续。每例写输入前态、动作、可见结果及副作用。由独立审阅者对照设计找漏项，协调者修订。
- [x] **Step 6：完成合同校验。** 三份文档格式、路径/标题链接及字段一致性已核对；由 Task 6 统一提交和合并。

## Task 4：Node 插件合同与旧栈替换边界

**Files:** Create `docs/contracts/node-extension-v0.md`、`docs/adr/0027-shared-host-and-node-extensions.md`；Modify `docs/adr/README.md` 和仍适用 ADR 的相互入链。旧栈删除清单与结果由基座 PR 留证，不创建永久兼容或替换教程。

**Interfaces:** Consumes：Task 3 的身份、动作、流、operation 和结果引用；Produces：M2 包加载器/后台/Web UI SDK 的合同及 M0 旧栈删除验收依据。

- [x] **Step 1：定义正式包和后台接口。** 写 manifest 字段/schema/版本门、预构建 JS/依赖/平台资源、完整性与签名、离线安装不执行 install/postinstall、register/dispose、激活/停用/升级，以及后台任务状态所有权。所有业务贡献同时提供 schema、权限、状态和 GUI 定位；后台不依赖窗口。
- [x] **Step 2：定义数据和 UI 边界。** 控制/批量原始流/派生流分通道且有 credit/队列预算；插件代表调用者保留身份。Web UI 在无 Node/Tauri 的 iframe 中加载，消息桥复用 Task 3 合同；主题/焦点/输入法/键盘、订阅释放/恢复、离屏导出分别有验收例。脚本与重计算放可终止 worker/子进程。
- [x] **Step 3：定义监督与信任验收例。** 普通已授权操作不重复确认；任意脚本/外部工具/插件管理有各自授权。覆盖 worker 崩溃、主 Node 挂起重启、Rust 录制继续、插件持口后端断开新 epoch、升级停止接新任务、同源相容升级继承信任、来源身份变化重新确认和运行中撤权。
- [x] **Step 4：完成实际删除验收。** 基座已删除旧 Rust/前端/SDK/示例/fixture/市场/构建链，依赖树、入口扫描和生产构建结果见基座 PR；合理公共职责继续使用，用户磁盘原件不因源码清理删除。M3 只验证新体系安装包，不恢复旧清单或适配层。
- [x] **Step 5：记录 ADR 与索引。** ADR 只记录共享 Host/可信 Node 的问题、选择、代价和旧决策的覆盖范围，协议细节链接合同。逐步实施时更新当前指南；M0 不把规划写成现有能力。核对格式/链接及与 Task 3 的一致性后纳入 M0 统一里程碑提交。

## Task 5：runtime 与四目标分发基线

**Files:** Create `docs/contracts/runtime-distribution.md`。M2 再按此表实现机器可读清单和下载/验签/打包工具。

**Interfaces:** Consumes：总设计最低平台和 Task 4 包/ABI 约束；Produces：精确 Node 版本、四目标归档 URL/SHA-256、安装后固定位置、许可来源、系统依赖、组件组合和实际验收入口。

- [x] **Step 1：选定并核对上游。** 首选 Node `26.13.0` LTS，与开发版本一致；以该 tag 的 `BUILDING.md` 和发布 SHA 清单核对四目标，不从开发 `.nvmrc` 推断分发兼容。上游声明之外仍要记录实际平台运行结果。Windows 10 的供应商支持条件和 Linux `libatomic` 单列，产品目标变化必须问用户。
- [x] **Step 2：锁定四个归档及许可。** 初次查询的上游基线如下；实施时再次按完整 URL 获取并核对，实际包校验后才标已验证：

| target                     | 上游文件                            | SHA-256                                                            |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `x86_64-pc-windows-msvc`   | `node-v26.13.0-win-x64.zip`         | `dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a` |
| `aarch64-apple-darwin`     | `node-v26.13.0-darwin-arm64.tar.gz` | `d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6` |
| `x86_64-apple-darwin`      | `node-v26.13.0-darwin-x64.tar.gz`   | `525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e` |
| `x86_64-unknown-linux-gnu` | `node-v26.13.0-linux-x64.tar.xz`    | `d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997` |

归档根为 `https://nodejs.org/download/release/v26.13.0/`；保留 Node 及所含第三方完整许可，native addon/工具分别按实际版本补充。按上游签名清单核对来源和完整性，不把 hash 当发布者身份。

- [x] **Step 3：定义应用内布局与验收矩阵。** runtime 按应用资源固定绝对路径启动，PATH 不参与选择；Host、GUI、CLI/MCP、runtime、插件组成一套有兼容声明的组件。区分“上游信息核对”“包 hash 核对”“最低目标机器离线启动”“安装/升级/签名”。四目标均覆盖环境没有 Node/npm、错架构/损坏 runtime、缺依赖和后台任务升级；未取得目标环境的结果保留待验。
- [x] **Step 4：核对分发基线。** 文档记录上游版本链接、核对日期和相关平台条件；目标系统与格式逐项对照设计，依赖引入与许可影响写 PR。纳入 M0 统一里程碑提交。

上游依据：[26.13.0 发布说明](https://nodejs.org/en/blog/release/v26.13.0)、[SHA 清单](https://nodejs.org/download/release/v26.13.0/SHASUMS256.txt)、[该版本平台要求](https://github.com/nodejs/node/blob/v26.13.0/BUILDING.md#platform-list)。

## Task 6：M0 集成验收与 M1 接续

**Files:** Modify `docs/README.md`、总推进计划与本计划勾选状态；Create `docs/superpowers/plans/2026-11-07-m1-host-and-workspace.md`；相关当前指南只随实际行为同步。

**Interfaces:** Consumes：Task 2—5 的已审阅交付；Produces：M0 PR、可执行的 M1 文件/接口/测试计划和状态账本入口。

- [x] **Step 1：交叉审查。** 逐节对照设计和矩阵：每一合同有实际负责人；插件/浏览器/LAN 复用同一操作和数据授权；错误、epoch、revision、cursor、request/operation 不互相替代；M3 冻结检查各有后续验证任务。补齐遗漏后由协调者更新索引。
- [x] **Step 2：写 M1 实施计划。** 逐项指定 `crates/core/`、`crates/host/`、桌面适配器、工作区、CLI/MCP 与新类型生成的准确文件和签名。旧库 `device/transport/domain/capture` 只按许可选择性复用合理职责与算法，按新合同实现和测试；`serial_desktop` 的旧视图/API/格式兼容不迁入。每项列失败测试、红灯命令、最小实现、绿灯命令、提交点及依赖；独立后端、录制和客户端任务再安排并行。
- [x] **Step 3：运行本阶段检查。** `node --test scripts/check-feature-status.test.mjs`、`pnpm planning:check`、修改文件的 Prettier 检查、本地文件/标题链接检查及事实核对。脚本注册变化补 `pnpm test:scripts`。不因纯文档变动重跑未受影响的整套 Rust/GUI 检查。
- [x] **Step 4：提交并合并。** [M0 PR #32](https://github.com/YanChao001/serial-workbench/pull/32) 以 `docs(planning): 完成M0集成并细化M1纵向闭环` squash 合入，主线提交 `c983b0b12ef8aecefe33e023b6abacbf18d1faa2`；已核对全部可达分支无 merge commit。
- [x] **Step 5：进入 M1。** 用户已批准按 [M1a/M1b 计划](./2026-11-07-m1-host-and-workspace.md) 实施，`feature/host` 从更新后的 main 开始。外部平台、硬件与长稳结果仍分别验收；M0 不代表产品或最终验收通过。

## 计划自审

- M0 出口：Task 1 覆盖 Git/环境；Task 2 覆盖全部需求追踪；Task 3/4 覆盖服务/流/状态/插件及旧栈；Task 5 覆盖 runtime/平台；Task 6 覆盖集成与接续。
- 任务边界：各任务交付可独立审阅；共享信封、入口、锁文件和索引集中维护，没有让多个实现者并行改同一契约。
- 验证边界：文档例在 M1/M2 迁为可执行合同测试；M0 只核对定义和账本，不提前宣布软件、硬件或发行验收通过。
