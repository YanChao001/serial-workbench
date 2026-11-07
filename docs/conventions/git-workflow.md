# Git 协作规范

本文维护分支、提交与 PR 流程；本地验证按 [改动范围](../testing.md#日常验证范围) 选择，分发操作见 [构建与发布](../build-release.md)。

## 分支模型

采用 GitHub Flow：`main` 是唯一长期分支和默认分支。所有改动从 `main` 创建短期分支，经 PR squash merge 合回，每个 PR 对应一个完整里程碑提交。全部分支都保持线性历史，不创建 merge commit；同步使用 rebase 或 fast-forward。合并后删除本地和远端短期分支。功能、修复、文档、依赖和版本更新共用此流程，取舍见 [ADR 0025](../adr/0025-github-flow.md)。

分支名全小写，单词用连字符；按用途使用 `feature/`、`fix/`、`docs/` 或 `chore/`，使用能表达任务的短名，如 `chore/ci`、`docs/m0`、`feature/host`。有 issue 时可带简短编号，如 `fix/42-port`。

## 日常开发流程

```bash
git switch main
git pull --ff-only
git switch -c feature/host

# 开发、提交并完成适用检查后，首次推送
git push -u origin feature/host
```

开发分支按可交付里程碑集中提交：同一里程碑的实现、测试、审阅修正和配套文档合为一个提交。RED/GREEN、单项测试或一两行修改都是工作步骤，不作为提交边界；不要逐步骤、逐修正制造零碎提交。审阅修正回填对应里程碑提交，推送后的改写遵循下文独占分支与精确 lease 规则。

出现冲突或验证基线变化时同步 `main`，见 [冲突处理](#冲突处理)。完成适用检查、核对里程碑差异与中文提交说明后进入 PR 自审；当前 Actions 状态见 [自动化工作流](#自动化工作流)。

同一工作区并行编辑时约定文件范围，共享入口、清单、生成文件和锁文件串行维护；需要独立分支时使用 worktree，核对实际 HEAD。集成后检查最终差异并验证受影响行为；共享 Cargo target 的任务顺序执行。

## 提交信息规范

所有开发分支与最终 squash 提交都采用 Conventional Commits；类型和模块标识保留英文，主题与正文使用中文。API、路径、命令和外部产品名称保留原标识。PR 标题与正文同样使用中文；外部自动生成的英文提交不能直接作为交付记录。

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

一次提交交付一个完整里程碑，相关格式整理、验证、审阅修正和文档同步随对应实现一起提交。正文按需说明原因与影响；破坏性变更在 footer 写 `BREAKING CHANGE: 说明`，PR 标题加 `!`，如 `feat(ipc)!: 重命名 invoke 封装`。生成文件和外部依赖元数据保留其标准格式，这不豁免提交主题与正文的中文要求。

提交源文件与需要版本管理的生成结果，依赖目录和构建输出由忽略规则管理；凭据及 `.env` 的处理见 [密钥与证书](../security.md#密钥与证书)。

## PR 规范

标题遵循提交信息规范；描述使用 [PR 模板](../../.github/pull_request_template.md)，说明最终行为、原因、实际验证结果和相关未验证范围。达到 [设计评审门槛](../engineering-at-scale.md#设计评审与-adr-门槛) 时补充影响、取舍和验收，长期取舍再记录 ADR。

单人开发保留 PR 自审，审批人数为零。自审关注最终差异是否完成需求、检查是否覆盖受影响行为，以及分支冲突和评审意见是否处理；新增改动或验证基线变化后补充相应检查。视觉变化按需附截图、步骤或录屏，涉及主题配色时提供明暗结果。

`capabilities/default.json`、`tauri.conf.json`、`Cargo.toml` 的变化在描述中单独说明。合并前确认全部分支历史没有 merge commit、本里程碑只有集中提交、中文说明完整且适用检查通过，再 squash merge。核对更新后的 `main` 已包含全部改动并删除远端及本地短期分支；独立 worktree 先退出或移除相应工作区，再删除关联本地分支。清理完成后从更新的 `main` 开始下一项工作。

## 仓库设置（一次性）

GitHub 服务端按以下目标配置：

| 设置     | 值                                                       |
| -------- | -------------------------------------------------------- |
| 默认分支 | `main`                                                   |
| 保护分支 | `main`，通过 PR 合并，禁止强推与删除                     |
| 历史要求 | `main` 启用 Require linear history；全部开发分支保持线性 |
| 审批要求 | 单人维护审批人数为零，保留 PR 自审                       |
| 分支同步 | 按冲突和验证基线同步，不强制每次最新                     |
| 合并方式 | 仅启用 squash merge，关闭 merge commit 与 rebase merge   |
| 合并后   | 删除已合并远端短期分支，并完成本地分支 / worktree 清理   |

日常 PR 记录适用本机检查；里程碑 CI 由维护者手动运行，不设置为每个 PR 的必需自动检查。默认分支、保护规则与合并方式由服务端维护，本地配置同步的范围见 [仓库托管配置](../repository-hosting.md)。

## 自动化工作流

日常 PR 记录实际执行的本地检查，积累到大节点里程碑时手动运行 GitHub Actions；CI 和依赖审计均无 push、PR 或定时触发。CI 与手动依赖审计配置位于 [`.github/`](../../.github/)，检查范围见 [测试规范](../testing.md#持续集成检查)。停止自动创建依赖升级 PR，依赖审计与需要的升级由维护者按里程碑集中处理，沿用中文提交和 PR 规则。Pages 与发布工作流保留为 [未启用模板](../../.github/workflows-disabled/README.md)，启用步骤见 [构建与发布](../build-release.md)。

## 冲突处理

需要同步时，先保留未提交修改并保持工作树清洁。未推送的开发分支在最新 `main` 上变基；本地 `main` 仅使用 fast-forward 更新：

```bash
git fetch origin
git rebase origin/main
```

发生冲突时修正文件，用 `git add <file>` 标记已解决，再执行 `git rebase --continue`；放弃本次变基用 `git rebase --abort`，回到变基前状态。同步不使用 merge commit，也不为处理冲突额外创建碎提交。

已推送分支仅在确认由自己独占、无人基于其继续工作时允许变基或回填里程碑提交。开始改写前 fetch、核对并记录远端分支完整 SHA，并确认本地已包含该远端提交；发现遗漏或未知提交就先停止。推送时精确指定该 ref 和预期 SHA，远端不匹配就停止并重新核对。以下为 Bash 示例，`expectedRemoteCommit` 在改写前固定，不能在推送前为绕过拒绝而刷新：

```bash
git switch feature/host
git fetch origin
expectedRemoteCommit=$(git rev-parse refs/remotes/origin/feature/host)
git log --oneline "origin/main..$expectedRemoteCommit"
git rebase origin/main
# 按上文解决冲突，完成里程碑检查后再推送
git push "--force-with-lease=refs/heads/feature/host:$expectedRemoteCommit" origin HEAD:refs/heads/feature/host
```

共享分支不改写历史，先与协作者安排同步；不使用裸 `--force` 或不带预期 SHA 的 lease。`main` 禁止任何强推。精确 lease 的语义见 [Git 官方 push 文档](https://git-scm.com/docs/git-push)，冲突继续与放弃见 [rebase 文档](https://git-scm.com/docs/git-rebase)。

核对最终差异，对受冲突处理影响的行为验证。锁文件先合并清单，再基于已有锁文件重新解析并审查差异，见 [锁文件冲突处理](../troubleshooting.md#pnpm-锁文件冲突)。

## 发布流程

版本更新同样从 `main` 创建短期分支，例如 `chore/v1.2.0`，执行 `pnpm version:set 1.2.0`，审查版本差异、发布范围和说明，经 PR 合入 `main`。完成 [发布检查清单](../build-release.md#发布检查清单) 后，在确认的 `main` 提交打对应 `v` 标签：

```bash
git switch main
git pull --ff-only
git tag -a v1.2.0 -m "v1.2.0"
```

标签确定发布基线，构建、签名、验收与公开按 [构建与发布](../build-release.md) 执行。当前发布工作流仍是停用模板，推送标签不会触发发布。紧急修复沿用 `fix/` 分支和同一 PR、版本、标签流程。
