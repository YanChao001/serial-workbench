# M0 干净基座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 进入 M1 前删除旧插件架构与旧软件兼容分支，保留职责明确、可独立验证的公共桌面壳。

**Architecture:** Rust、前端、工具资源与独立市场按文件所有权并行清理；共享清单、锁文件、配置、生成绑定、索引和 Git 串行集成。Node 插件及 SDK 在 M2 按新合同从首版实现。

**Tech Stack:** 当前 Rust/Tauri、React/TypeScript、Node 工程脚本；工具版本读取仓库配置。

**Spec:** [总设计](../specs/2026-11-07-serial-workbench-design.md)、用户 2026-11-07 的清爽重构要求；本切片纳入 [M0 计划](./2026-11-07-m0-contracts-and-baseline.md)。

本切片已完成，交付与验证证据见 [主库基座 PR #1](https://github.com/YanChao001/serial-workbench/pull/1) 和 [市场基座 PR #1](https://github.com/YanChao001/serial-workbench-plugins/pull/1)。

## Global Constraints

- 旧软件 API、数据格式、插件、SDK、包和信任记录不提供兼容或迁入。合理职责选择性复用，不合理接口和状态模型直接重设计。
- 当前格式的原子写入、revision、未来格式拒写、原件保留和失败恢复继续维护；源码清理不删除用户磁盘数据。
- 删除旧 runtime、worker、桥接、注册、依赖、SDK、包、专属资源/测试/示例/fixture、构建发布链、失效指南及纯旧 ADR。Git 保存历史。
- 保留 HashRouter、原生门面、Rust DTO 来源、中英词典、语义 token、合理窗口/未保存工作/设置职责及上游资源约束。
- GitHub Flow、PR squash merge、编译缓存保留、共享 Cargo/绑定串行、日常 UI 无头验收。

## Review Focus

- 间接 worker、IPC、路由、命令和权限仍可触发旧功能：核对实际入口、生成契约和生产构建。
- 为凑类型保留空 API、Provider、别名和适配器：删除调用链，新 Node 使用新合同。
- 删除兼容代码后误覆盖存档：保留当前/未知/未来格式、显式重置与恢复的原件保护回归。
- 窗口、设置、壁纸和更新生命周期断裂：检查所属回归及无头入口，真实桌面留独立环境。
- 市场旧提交或资源进入主库：市场先独立 PR squash 合入，主库引用远端实际提交；最终依赖树与产物一致。

## Task 1：Rust 去耦合

**Files:** `src-tauri/src/` 手写 Rust、旧 `src-tauri/vendor/` 补丁和专属原生测试。

- [x] 删除 `extension*`、worker/bin、旧市场/协议/授权/数据归档及专属服务；公共组装、命令和生命周期解除旧状态占用。
- [x] `list_wallpapers` 改为无业务参数；删除旧壁纸导入、旧物理窗口尺寸迁入和旧软件专属恢复分支。
- [x] 保留当前格式、公共设置/窗口/更新/恢复/导出职责及回归；定向 rustfmt 和调用检查，统一验收时编译。

## Task 2：前端去耦合

**Files:** `src/` 手写 TS/TSX/CSS、`e2e/browser/`；生成文件由协调者维护。

- [x] 删除旧插件 Provider、视图/独立窗口、消息桥、路由/命令、词典/样式和专属测试，保留直接的路由/错误/未保存工作边界。
- [x] 删除旧设置 wrapper、品牌回退、字段转换、图库格式接受和自动导入；无参 `listWallpapers()` 与 Rust 对齐，不保留旧函数别名。
- [x] 当前扁平归一化与设置版本保持一致；用保留职责回归及真实 RED/GREEN 验证，运行测试/类型/lint。

## Task 3：工具资源与共享配置

**Files:** `scripts/`、旧 `sdk/`、`examples/extensions/`、`resources/extensions/`、非浏览器 E2E、`.github/`；协调者维护清单/配置/锁/生成。

- [x] 删除旧打包/SDK/fixture/worker/cache/样式对照链；通用构建、归档、进程、品牌和配置直接维护现行职责。
- [x] 绑定工具只生成 Rust 契约；app 删除旧市场信任/包后缀；repository 保留通用托管及市场仓库身份。
- [x] 移除旧 Cargo/npm 依赖、patch/bin、脚本、capability/CSP 和无剩余使用的许可资源；生成元数据从当前源配置重新建立。
- [x] 真实脚本行为变化先 RED 再实现；定向与最终检查记录准确失败，不以跳过断言掩盖环境问题。

## Task 4：独立市场与当前指南

**Files:** 市场隔离 worktree；主库 `docs/`、中英 README、贡献、安全和 AGENTS。

- [x] 市场删除旧插件、目录/包/签名协议、构建发布链、依赖和教程，保留实际许可、身份、GitHub Flow 与准确状态。
- [x] 主库指南按最终实现重写，删除纯旧 ADR 并修入链；Host/Node 仍准确记为规划，不编造未存在的命令或 SDK。
- [x] 用 `writing-for-agents` 写入重构约束，检查格式、本地路径/锚点及事实。
- [x] 独立审阅市场差异，经 PR squash merge 后主库更新 gitlink；来源提交保留。

## Task 5：最终验收与提交

- [x] 准备 `dist/`，更新最小锁差异，按新 Rust 注册生成/检查绑定，再完整构建前端。
- [x] `pnpm verify`、`pnpm test:ui`；串行 Cargo fmt/check/clippy/lib tests 与绑定检查。只因新改动、失败或疑点重跑。
- [x] 核对实际源码、有效指南、依赖图、入口和本轮生产产物无旧架构；历史编译缓存不作为发行物。
- [x] 独立规格/质量评审后提交 `refactor(app)!: 清除旧插件栈与历史兼容分支`，PR 记录实际检查、契约/依赖/权限/打包变化及相关未测范围。
- [x] squash merge 后继续 M0 账本、合同与 M1 接续计划。
