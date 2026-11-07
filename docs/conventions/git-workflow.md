# Git 协作规范

本文维护分支、提交与 PR 流程；本地验证按 [改动范围](../testing.md#日常验证范围) 选择，分发操作见 [构建与发布](../build-release.md)。

## 分支模型

采用 GitHub Flow：`main` 是唯一长期分支和默认分支。所有改动从 `main` 创建短期分支，经 PR squash merge 合回，每个 PR 对应一个逻辑提交，保持主分支历史线性；合并后删除短期分支。功能、修复、文档、依赖和版本更新共用此流程，取舍见 [ADR 0025](../adr/0025-github-flow.md)。

分支名全小写，单词用连字符；按用途使用 `feature/`、`fix/`、`docs/` 或 `chore/`，有 issue 时可带编号，如 `feature/42-command-palette`、`fix/57-window-flash`、`chore/version-1.2.0`。

## 日常开发流程

```bash
git switch main
git pull --ff-only
git switch -c feature/42-command-palette

# 开发、提交并完成适用检查后，首次推送
git push -u origin feature/42-command-palette
```

开发分支可保留临时提交，由 squash merge 收敛。出现冲突或验证基线变化时同步 `main`，见 [冲突处理](#冲突处理)。完成适用检查后进入 PR 自审；当前 Actions 状态见 [自动化工作流](#自动化工作流)。

同一工作区并行编辑时约定文件范围，共享入口、清单、生成文件和锁文件串行维护；需要独立分支时使用 worktree，核对实际 HEAD。集成后检查最终差异并验证受影响行为；共享 Cargo target 的任务顺序执行。

## 提交信息规范

采用 Conventional Commits；类型和模块标识保留英文，主题与正文使用中文。API、路径、命令和外部产品名称保留原标识。

```text
<type>(<scope>): <subject>

<body 可选，说明动机与影响>

<footer 可选，BREAKING CHANGE / Refs #42>
```

| type       | 用途                     |
| ---------- | ------------------------ |
| `feat`     | 新功能                   |
| `fix`      | 缺陷修复                 |
| `refactor` | 重构，不改变外部行为     |
| `perf`     | 性能优化                 |
| `style`    | 格式调整，不影响逻辑     |
| `docs`     | 文档                     |
| `test`     | 测试                     |
| `build`    | 构建脚本、依赖、打包配置 |
| `ci`       | CI 配置                  |
| `chore`    | 杂项，如版本号、忽略文件 |
| `revert`   | 回滚某次提交             |

scope 使用模块名，如 `ui`、`tauri`、`ipc`、`window`、`docs`、`deps`。subject 简短说明动作，结尾不加句号，例如 `fix(tauri): 修复重复启动时窗口不聚焦`。

一次提交围绕一个明确问题，必要的格式整理和文档同步随对应改动提交。正文按需说明原因与影响；破坏性变更在 footer 写 `BREAKING CHANGE: 说明`，PR 标题加 `!`，如 `feat(ipc)!: 重命名 invoke 封装`。工具生成记录和外部依赖元数据保留标准格式。

提交源文件与需要版本管理的生成结果，依赖目录和构建输出由忽略规则管理；凭据及 `.env` 的处理见 [密钥与证书](../security.md#密钥与证书)。

## PR 规范

标题遵循提交信息规范；描述使用 [PR 模板](../../.github/pull_request_template.md)，说明最终行为、原因、实际验证结果和相关未验证范围。达到 [设计评审门槛](../engineering-at-scale.md#设计评审与-adr-门槛) 时补充影响、取舍和验收，长期取舍再记录 ADR。

单人开发保留 PR 自审，审批人数为零。自审关注最终差异是否完成需求、检查是否覆盖受影响行为，以及分支冲突和评审意见是否处理；新增改动或验证基线变化后补充相应检查。视觉变化按需附截图、步骤或录屏，涉及主题配色时提供明暗结果。

`capabilities/default.json`、`tauri.conf.json`、`Cargo.toml` 的变化在描述中单独说明。合并时核对 squash 提交的标题与正文，随后从更新的 `main` 开始下一项工作。

## 仓库设置（一次性）

GitHub 服务端按以下目标配置：

| 设置     | 值                                                     |
| -------- | ------------------------------------------------------ |
| 默认分支 | `main`                                                 |
| 保护分支 | `main`，通过 PR 合并，禁止强推与删除                   |
| 历史要求 | 启用 Require linear history                            |
| 审批要求 | 单人维护审批人数为零，保留 PR 自审                     |
| 分支同步 | 按冲突和验证基线同步，不强制每次最新                   |
| 合并方式 | 仅启用 squash merge，关闭 merge commit 与 rebase merge |
| 合并后   | 自动删除已合并短期分支                                 |

必需检查应对应当前可运行的 CI；Actions 恢复并验收后再启用。默认分支、保护规则与合并方式由服务端维护，本地配置同步的范围见 [仓库托管配置](../repository-hosting.md)。

## 自动化工作流

当前 GitHub Actions 停用，PR 记录实际执行的本地检查。CI、依赖审计和 Dependabot 配置位于 [`.github/`](../../.github/)，检查范围见 [测试规范](../testing.md#持续集成检查)。Pages 与发布工作流保留为 [未启用模板](../../.github/workflows-disabled/README.md)，启用步骤见 [构建与发布](../build-release.md)。

## 冲突处理

需要同步时，可将最新 `main` 合入自己的短期分支：

```bash
git fetch origin
git merge origin/main
```

解决冲突后用 `git add <file>` 和 `git commit` 完成合并；放弃本次合并用 `git merge --abort`。短期分支中的同步合并同样由 squash merge 收敛。

核对最终差异，对受冲突处理影响的行为验证。锁文件先合并清单，再基于已有锁文件重新解析并审查差异，见 [锁文件冲突处理](../troubleshooting.md#pnpm-锁文件冲突)。

## 发布流程

版本更新同样从 `main` 创建短期分支，例如 `chore/version-1.2.0`，执行 `pnpm version:set 1.2.0`，审查版本差异、发布范围和说明，经 PR 合入 `main`。完成 [发布检查清单](../build-release.md#发布检查清单) 后，在确认的 `main` 提交打对应 `v` 标签：

```bash
git switch main
git pull --ff-only
git tag -a v1.2.0 -m "v1.2.0"
```

标签确定发布基线，构建、签名、验收与公开按 [构建与发布](../build-release.md) 执行。当前发布工作流仍是停用模板，推送标签不会触发发布。紧急修复沿用 `fix/` 分支和同一 PR、版本、标签流程。
