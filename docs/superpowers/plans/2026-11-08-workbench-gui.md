# 串口工作台 GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的串口工作台样稿接入真实 Host，交付顶部连接、中央接收、底部常显发送及就近展开工具的桌面界面。

**Architecture:** 保留 starter 外壳、主题和材质，以现有工作台组件组织业务操作。Host 保持领域数据、授权与 Operation 的权威，Provider 负责连接生命周期、订阅与真实回执，组件维护视图和草稿。补齐目标授权检查与无写入导入预览后统一接线。

**Tech Stack:** 当前锁定的 React 19、TypeScript 6、Tauri 2、Rust、Tokio、Vitest、Playwright、pnpm。

**Spec:** [已确认界面设计](../specs/2026-11-08-serial-workbench-gui-design.md)、[M1 实施计划](./2026-11-07-m1-host-and-workspace.md)、[M1 覆盖表](./2026-11-07-m1-coverage.md)。

## Global Constraints

- “旧软件的 API、数据格式和插件体系不提供兼容或迁入”。现有样稿中的模拟设备、字节、计数和录制状态只供设计审阅。
- “布局元数据维护在 `src/routes.tsx`，外壳统一消费，不在多处匹配路径。”保留 HashRouter、懒加载和现有导航偏好。
- “业务页不另建颜色、透明度或 blur 系统。”一层 panel 组织工作台，接收 viewport 使用一层 reading，消费基座语义 token 和控件。
- “发送器始终可见，包括未连接时。”未连接和回放仍能编辑草稿，发送禁用原因就近显示。
- “选择路径本身完成本机目标授权，不增加权限管理页面或第二次授权步骤。”初始化、订阅与后台重试不自动补权限。
- “取消停止等待不能显示为已停止或已回滚，结束以真实 Operation 和回执为准。”保存须验证目标、终态与 revision，冲突保留草稿。
- 手写 TypeScript 使用 unknown 收窄，不使用 any/enum，系统能力统一经过 `src/lib/tauri.ts`，Rust DTO 为公共契约来源。
- 接收保留 Gap、重连和 seek 边界。发送保留非法 HEX、IME、行尾和 Partial/Unknown 的真实语义。
- 明暗、高透明背景、1120×744、880×600及导航展开/收起使用无头检查。真实窗口按用户安排时段或独立环境验收。
- 复用现有 WIP 分工，独立文件范围并行；路由、外壳、词典、Provider、清单、锁与生成物各有唯一写入者。共享 Cargo target 串行。
- 每个可验收里程碑将实现、测试、审阅修正和配套文档集中提交。中文 Conventional Commit 与 PR、短分支、线性历史、PR squash merge、及时清理分支沿用仓库规范。

## Review Focus

1. 会话 A 能发送但 B 被窄范围撤权时，命令和 B 的普通发送应失效，工作区首次显式保存仍有可达入口。Task 2/3/6 覆盖。
2. 保存等待中继续编辑、切换工作区或 Host 代次时，旧回执不能覆盖新草稿或确认新目标已保存。Task 3/5 覆盖。
3. 短窗口、长设备名称、高透明图片与键盘聚焦弹层时，发送器和关闭入口保持可达。Task 1/6/7 覆盖。
4. 接收冻结期间继续到数、跨 Gap 的 UTF-8 半字符和回放 seek 时，显示边界保持真实。Task 4 覆盖。
5. 导入合法但引用失效、未来版本或 CAS 冲突时，原文、预览与草稿保留，预览/取消不写入。Task 2/5 覆盖。

## 文件与并行边界

| 范围                                           | 职责与顺序                                                  |
| ---------------------------------------------- | ----------------------------------------------------------- |
| routes、AppShell、app-navigation.css           | Task 1 唯一外壳作者，与 Task 4 独立并行                     |
| Core/Host 新查询、公共生成物                   | Task 2 唯一契约作者；Root 串行注册和生成                    |
| Host Provider/controller/context               | Task 3 唯一作者，消费 Task 2 类型                           |
| StreamView、SendPanel、presentation            | Task 4 唯一作者；不改共享 CSS/词典                          |
| 工作区/设备/录制/传输子组件                    | Task 5 可按文件进一步分配，父组件和共享类型只由集成作者修改 |
| Overview、WorkspaceLayout、词典、workbench.css | Task 6 集成作者，消费前述稳定接口                           |
| 浏览器场景、证据与交付文档                     | Task 7 集成作者；单独占用构建产物和预览端口                 |

当前 M1b 尚有串口输入线、权威计数/速率、终端排版字段、录制容量/余量等已确认契约缺口，继续按原 M1 Task 9—12 补齐。Task 5/7 的完整出口依赖这些能力及生成绑定到位，不能把长期禁用的入口记作交付。GUI 设计不重新解释这些领域语义。

### Task 1: 工作台路由与基座外壳

**Files** 修改 `src/routes.tsx`、`src/layouts/app-shell.tsx`、`src/styles/app-navigation.css`，测试 `src/routes.test.ts`、`src/layouts/app-shell.test.tsx`。

**Interfaces** 为 `AppRoute` 增加 `contentLayout?: "document" | "workspace"`，首页声明 workspace，`AppShell` 通过现有 `matchRoute(pathname)` 消费。布局使用 data 属性，设置页维持 document 默认值。

- [ ] 为路由唯一元数据、设置页回落及工作台外壳数据属性补充行为断言；运行相关测试并确认预期失败。
- [ ] 实现工作台满高、`min-height: 0` 与内部滚动容器。导航折叠/调宽、错误恢复及焦点滚动沿用现有机制。
- [ ] 运行 `pnpm test src/routes.test.ts src/layouts/app-shell.test.tsx`，结果全部通过；按改动文件执行 lint/格式检查。
- [ ] 提交定向审阅包，在最终里程碑统一提交。

### Task 2: 当前目标授权检查与工作区导入预览

**Files** 修改 `crates/core/src/{auth.rs,catalog.rs,dispatch.rs,lib.rs,bin/export-contracts.rs}`、`crates/host/src/{dispatch.rs,documents.rs}`；按复用需要调整 `capture_api.rs`、`files/references.rs`、`operation_inspection.rs` 的授权接缝。创建 `crates/host/tests/action_check.rs`；扩展 `crates/host/tests/shared_documents_host.rs`。生成 `packages/contracts/src/generated/*`，按实际 DTO 影响生成 Native 绑定。

**Interfaces** Rust 新增 `ActionCheckParams { action_id: Id, params: JsonObject }`、`ActionCheckResult { action_id: Id, target: Target, allowed: bool }`。`action.check` 为 Query，完整 target 来自 Query 信封，结果 kind 为 `action_check`。Host 的 `check_action(&self, actor: &AuthenticatedActor, target: &Target, params: ActionCheckParams) -> HostResult<ActionCheckResult>` 负责该查询。`workspace.importPreview` 复用 `DocumentImportParams`，结果 kind 为 `workspace_import_preview`，value 为 `WorkspaceDocument`；领域入口为 `DocumentService::preview_workspace_import(&self, actor: &AuthenticatedActor, target: &Target, params: DocumentImportParams) -> HostResult<WorkspaceDocument>`。

- [ ] 先用真实 IPC 写 `checks_current_target_without_changing_grants`、`compound_checks_match_real_source_authorization`、`revocation_after_check_still_blocks_invoke`。同一 actor 对 A/B 的窄规则不同，check 与真实调用一致；复合文件/capture/transfer/operation 检查沿实际来源授权；check 后撤权时真实 invoke 拒绝。检查前后授权 revision 和 Operation 数量相等，没有外部效果。
- [ ] 在 shared_documents_host 中写 `workspace_import_preview_validates_without_writing_or_granting` 与 `workspace_import_preview_rejects_future_or_invalid_references`，覆盖合法文档、坏 JSON、未来格式、重复 ID、悬空 binding/favorite 引用及预览取消。读取前后文档/授权 revision 相等。
- [ ] 运行 `cargo test --locked -p serial-workbench-host --test action_check` 和 `cargo test --locked -p serial-workbench-host --test shared_documents_host workspace_import_preview`，确认真实断言失败。
- [ ] 实现当前认证 actor 的只读检查，复用业务授权解析，避免两套授权规则。拒绝把 `action.check` 本身作为被检查动作；仅把权限拒绝变为 allowed=false，其余稳定错误保留。检查前后复核 grants；正文、其他 actor 与授权规则不进入回执。
- [ ] 预览复用 `import_document::<WorkspaceDocument>` 和 `WorkspaceDocument::validate()`，返回前复核目标读取权；保存继续由原 CAS 服务执行。
- [ ] Root 串行生成并检查契约及受影响绑定。运行上述定向 Rust 用例、`pnpm contracts:check` 和对应合同测试，实际通过后交定向审阅。

### Task 3: Provider 真实目录、权限与文档回执

**Files** 修改 `src/providers/{host-context.ts,host-controller.ts,host.tsx,host.test.tsx}`、`src/lib/host-client.test.ts`；如需提取等待逻辑，置于 `src/lib/host-operation.ts` 及对应测试，避免复制 `host-settings.ts` 的检查。

**Interfaces** 保留现有 `trustedConnect`、`pickFile`、`invoke`、`watchSession`。新增 `HostState.catalog: readonly ActionSpec[]`、`devicesStale: boolean`。Provider 提供以下生成类型接口。

```ts
recentConnections(signal?: AbortSignal): Promise<RecentList>;
exportWorkspace(workspaceId: string, signal?: AbortSignal): Promise<DocumentJsonResult>;
previewWorkspaceImport(workspaceId: string, json: string, signal?: AbortSignal): Promise<WorkspaceDocument>;
saveWorkspace(base: WorkspaceDocumentResult, value: WorkspaceDocument, signal?: AbortSignal): Promise<WorkspaceDocumentResult>;
saveFavorites(base: WorkspaceDocumentResult, params: FavoritesSaveParams, signal?: AbortSignal): Promise<WorkspaceDocumentResult>;
rebindDevice(base: WorkspaceDocumentResult, params: RebindParams, signal?: AbortSignal): Promise<WorkspaceDocumentResult>;
waitForOperation(operation: Operation, signal?: AbortSignal): Promise<Operation>;
checkAction(input: { actionId: string; target: Target; params: Query["params"] }, signal?: AbortSignal): Promise<ActionCheckResult>;
```

- [ ] 先补当前目标窄拒绝、catalog 不变时撤权、旧代次晚结果、AbortSignal、首次明确保存、终态失败与在途新编辑的失败用例。真实 adapter/Provider 流程验证，不只测布尔标记。
- [ ] 运行 `pnpm test src/providers/host.test.tsx src/lib/host-client.test.ts`，确认新增断言失败。
- [ ] Native 显式文档动作复用 `hostApplyDocumentIntent`，将其加入可注入 `HostUserActions`。后台路径调用普通 Host；等待终态不重新 invoke。核对 action、Host、完整 target、结果 kind 和大于 expectedRevision 的真实文档 revision，返回本次 receipt，更新所有调用方与 empty fixture。
- [ ] 公开真实 catalog 与 recent，保留设备 stale。普通动作权限按当前 target 单独检查；资源状态、txGate、回放与权限分别判断。
- [ ] 当前可见 action/target 集合采用一次在途的有界刷新。观察硬到期为 1000ms，正常续检在期限中点发起，新一轮开始不延长旧结果的原截止；及时成功的真实续检不先清空健康观察，超时仍转为 unknown 并丢弃旧轮晚值，避免每秒销毁录制阅读和重复验证。隐藏/卸载停止，焦点恢复、目标/epoch 切换、明确 Native 动作完成、PERMISSION_DENIED 时立即失效并刷新；每次执行仍由 Host 授权。此调度是实现决定。
- [ ] 运行定向 Provider/等待逻辑测试及 `pnpm typecheck`，检查通过后交审阅。移除当前全局 catalog 中 session.tx 决定所有写动作的判断。

### Task 4: 接收与发送主体

**Files** 修改 `src/features/workbench/{stream-view.tsx,stream-view.test.tsx,send-panel.tsx,send-panel.test.tsx,stream-presentation.ts,stream-presentation.test.ts}`。共享 CSS 与词典需求交 Task 6，不并行写入。

**Interfaces** 保留 `StreamViewProps` 的 items/mode/onReceiveModeChange/terminalSettings 和 `SendPanelProps` 的 draft/onDraftChange/onSend/terminalSettings。显示动作通过有名回调接线；新增文案键列入集成清单。

- [ ] 先用行为测试覆盖冻结期间持续到数、Gap 前后 UTF-8、回放 seek 边界、Text/HEX 切换、非法 HEX/自定义行尾、IME 下快捷键不发送。保留既有 reader/编码测试。
- [ ] 运行 `pnpm test src/features/workbench/stream-view.test.tsx src/features/workbench/send-panel.test.tsx src/features/workbench/stream-presentation.test.ts`，确认新增预期失败。
- [ ] 将 Text/HEX、跟随、搜索、录制/日志入口置于接收工具条；搜索按需展开。接收行以透明背景、方向和时间组织。发送器常显模式、行尾、字节预览与具名发送键，未连接时仍保留草稿。
- [ ] 消费已生成的共享终端排版字段，不引入第二套设置或模拟计数。按真实 Operation 展示发送回执。
- [ ] 运行定向测试、lint/类型检查并交审阅。

### Task 5: 设备、工作区与录制工具的就近操作

**Files** 修改 `src/features/workbench/{device-library.tsx,session-controls.tsx,workspace-editor.tsx,capture-tools.tsx,transfer-options.tsx,file-actions.ts}` 与各自现有测试；工作区差异模型放 `workspace-import.ts` 及其测试。需要改共用类型时由集成作者串行维护。

**Interfaces** `DeviceLibrary` 收藏与重绑消费 Task 3 的 saveFavorites/rebindDevice 回调。`WorkspaceEditor` 现有 onSave/onReload/onAcknowledged/onExport 保持真实文档结果，新增 `onPreviewImport(json, signal?): Promise<WorkspaceDocument>`。复用 CaptureToolsProps 与 TransferOptionsProps 的生成参数、文件选择和 Operation 回调。

- [ ] 独立作者按文件范围先补失败用例。工作区预览覆盖字段差异、无写入取消、明确应用、CAS 冲突保留原文/候选/草稿及切换后的晚结果；设备历史不自动连接；收藏/重绑等待真实回执。
- [ ] 各作者运行对应现有 `*.test.tsx`，确认新增失败后实现。
- [ ] 工作区输入 JSON 先交 Host 预览校验，再比较当前草稿与候选的视图、绑定、收藏、布局和 capture 引用；仅明确应用后调用 Native workspaceSave。导出使用 Host 文档 envelope 和现有 saveTextExport，取消不显示成功。
- [ ] 参数保留请求值、有效值和回执。录制接真实容量/余量、文件元数据与 fingerprint 确认替换；传输接块大小/范围/限速/取消，验证/恢复/回放入口复用真实文件引用。原 M1 契约缺口闭合后再完成对应用例。
- [ ] 工具局部参数用现有离页协商提供放弃，不伪造持久化字段；所有已保存草稿保留原登记机制。
- [ ] 运行对应组件/模型测试及 lint/类型检查，各文件组交定向审阅。

### Task 6: 主工作区与统一材质集成

**Files** 修改 `src/pages/{overview.tsx,overview.test.tsx}`、`src/features/workbench/{workspace-layout.tsx,workspace-layout.test.tsx,session-tabs.tsx,labels.ts,workbench.css,workbench-commands.tsx,workbench-commands.test.ts}`、`src/i18n/{zh-CN.ts,en.ts}`。Task 1 的导航名称改动由同一集成作者统一维护。

**Interfaces** WorkspaceLayout 消费前述真实 HostContextValue 与回调；保留已保存工作区视图、ClientState 发送草稿和 reader 生命周期。命令绑定仍通过 `buildWorkbenchCommands(catalog, bindings)`，每个 binding.available 由实际目标检查及资源状态共同决定。

- [ ] 先为未连接常显发送、关闭视图与断开会话不同、切换工作区不连接、当前目标权限、菜单展开与焦点返回、草稿/reader 清理补入口失败用例。
- [ ] 运行 `pnpm test src/pages/overview.test.tsx src/features/workbench/workspace-layout.test.tsx src/features/workbench/workbench-commands.test.ts`，确认新增预期失败。
- [ ] 接入顶部设备选择/参数/连接/工作区菜单、会话标签、中央接收、底部发送；移除第二设备侧栏与默认展开任务/指标布局，保留按需详情及故障定位。
- [ ] 统一 panel/reading/control，CSS 只使用现有语义变量与基座刻度。任务/日志弹层有具名标题、关闭和焦点返回；Host 技术字段放详情。中英文案同步，首页名称使用串口工作台。
- [ ] 运行入口测试、应用类型、lint、格式和词典检查，完成定向审阅。

### Task 7: 无头验收与集中交付

**Files** 按现有 Playwright 配置新增 `e2e/browser/workbench.spec.ts` 及必要最小新契约 fixture；同步 `docs/product-scope.md`、M1 验收记录和真实证据。

- [ ] 用新契约 fixture 检查明暗、高透明图片、1120×744/880×600、导航展开/收起，断言发送器可见/可点击且无整页横向滚动，检查键盘、焦点与无障碍；这些是界面证据。
- [ ] 执行 `pnpm test:ui`，记录实际匹配场景、结果与截图。用实际 Virtual/Host/CLI/MCP 软件场景确认业务；模拟数据不进入生产。
- [ ] 执行受影响 Rust、契约/绑定与工程检查。原 M1b 六场景 600 秒、平台差异和真实硬件按原计划验收，未测范围逐项记录。
- [ ] 汇总定向审阅和最终整体审阅，包含此前记录的 Minor。当前后端可独立闭合的里程碑及时先交付，界面出口不替代 M1b 完整验收。
- [ ] 在最新 main 的短期分支集中提交 `feat(gui): 重组串口工作台并接入真实操作`，PR 使用中文并 squash merge，核对线性历史和最终树，清理已用分支/工作区。达到大节点后手动完整四目标 CI，跟进至终态。

## 计划自检

设计各节分别落到 Task 1 外壳、Task 4 收发、Task 5 业务工具、Task 6 主接线与 Task 7 体验验收。Task 2/3 闭合目前真实接口缺口。五类 Review Focus 均有具体行为测试；接口以已生成 DTO 为来源，saveWorkspace 的返回变化和所有 fixture 同步。实现中的小尺寸间距、图标和弹层宽度沿基座刻度，由实际渲染决定。
