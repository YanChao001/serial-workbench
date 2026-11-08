# 开发指南

## 环境要求

工具版本以 [`.nvmrc`](../.nvmrc)、[`package.json`](../package.json) 的 `engines` / `packageManager` 和 [`rust-toolchain.toml`](../rust-toolchain.toml) 为准。

- Windows：Visual Studio Build Tools 的“使用 C++ 的桌面开发”工作负载、Windows SDK 和 WebView2 Runtime；MSI 构建还需启用相应系统组件。
- macOS：Xcode Command Line Tools。
- Linux：编译工具和 WebKitGTK 开发库。

安装步骤见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

## 首次启动

命令从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm doctor
pnpm app:dev
```

首次桌面启动编译 Rust 依赖，后续复用缓存；前端由 Vite 热更新。`pnpm dev` 在 `http://localhost:1420` 启动浏览器预览，系统服务使用桌面环境。当前能力见 [产品范围](./product-scope.md)。

## 开发流程

日常流程见 [贡献指南](../CONTRIBUTING.md)，模块职责见 [架构](./architecture.md)。跨模块、数据兼容、权限、窗口生命周期或发布恢复变化，先按 [设计门槛](./engineering-at-scale.md#设计评审与-adr-门槛) 说明影响。

### Rust workspace 与公共契约

根 [Cargo.toml](../Cargo.toml) 管理桌面与无头 crate，当前成员和默认检查范围以 `members` / `default-members` 为准；[Cargo.lock](../Cargo.lock) 是唯一 Rust 锁文件。版本在 `workspace.package.version` 维护，各成员使用 `version.workspace`；版本变更仍使用 `pnpm version:set`。桌面命令显式选择 `-p serial-workbench`。

[target 配置](../.cargo/config.toml) 保留 `src-tauri/target` 缓存。共享 target 的 Cargo 与绑定/契约生成命令依次执行。仅检查无头 crate 不需要构建前端；桌面检查先准备 `dist/`，见 [Rust 测试](./testing.md#rust-测试)。

Host 公共 DTO 在 `crates/core` 维护。修改 wire 类型后顺序运行 `pnpm contracts:generate`、`pnpm contracts:check`，提交 `packages/contracts/src/generated/` 的结果。生成器从 Rust 导出类型、draft-07 schema、目录和正负 fixture，再生成浏览器 ESM 校验器。手写 TypeScript 从 contracts 包使用类型与 `parseReply`，未知输入先校验；Tauri 本地命令继续使用原有 `bindings:*` 流程。

### 独立 Host、CLI 与 MCP

从仓库根目录构建三个入口：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp
```

程序位于 Cargo target 的 `debug/`，默认是 `src-tauri/target/debug/`；Windows 文件名带 `.exe`。CLI 和 MCP 先认证附着同 profile 的 Host，首次使用会启动同目录的 Host 程序。三个程序应放在一起。Windows 的工具或 IDE 若通过 Job 禁止子进程脱离，会返回 `HOST_START_FAILED`；此时先在独立终端运行 `serial-workbench-host --profile <绝对目录>`，再让客户端连接同一 profile。

CLI 的完整参数与退出码见 `serial-workbench-cli --help` 和[参数入口](../crates/cli/src/args.rs)。结果写成单个 JSON 到 stdout，诊断写 stderr。首次认证仅有元数据权限，`authorize` / `revoke` 是明确的本地用户控制入口；参数使用 [Core 授权类型](../crates/core/src/auth.rs)，普通查询和调用不自动读取用户控制凭据。

每个要重试的请求先保存 Host 签发的上下文：

```sh
serial-workbench-cli --profile <绝对目录> catalog --json
serial-workbench-cli --profile <绝对目录> context --out request-context.json --json
serial-workbench-cli --profile <绝对目录> invoke <actionId> --target-json target.json --params-json params.json --request-id <uuid> --request-context-json request-context.json --json
```

`context --out` 以新建方式写入 UTF-8 JSON，不覆盖已有文件。文件使用 Core `AttachResult`，绑定 Host、actor、客户端与实例。重试继续使用相同文件、requestId 和参数；异参由 Host 返回 `REQUEST_CONFLICT`。新任务可显式签发新文件，旧请求不会自动换上下文续期或重发。

正常调用返回真实接纳 Operation，使用 `operation get <operationId>` 查询结果。Host 重启后，旧实例的 invoke 被拒绝；按原请求身份查询持久结果：

```sh
serial-workbench-cli --profile <绝对目录> operation get --request-id <原uuid> --request-context-json request-context.json --json
```

退出 CLI 保留 Host 及已接纳任务；`operation cancel <operationId>` 才请求合作取消。`host stop` 等待原实例实际结束后返回确认，回执中的接纳成功与实例停止分开判断；另一客户端随后可以启动新实例。

MCP 入口为 `serial-workbench-mcp --profile <绝对目录>`，stdio 只承载官方 SDK 协议。工具来自同一 Host 目录及当前 actor 权限；普通 MCP 不自动取得用户控制权限。取消工具等待只结束适配器等待，业务取消仍通过明确的 `operation.cancel`。原始读取使用独立 raw 连接，语义见 [Host 契约](./contracts/host-v0.md) 与[流和操作契约](./contracts/stream-and-operations-v0.md)。

#### CLI / MCP 启动配置

CLI 与 MCP 按 `--profile`、`SWB_PROFILE`、平台默认目录的顺序选择 Host 配置。普通相对路径在启动时绑定当前目录，不展开变量或 `~`；Windows 的盘符相对路径（如 `C:profile`）和根相对路径（如 `\profile`）会被拒绝。解析配置不创建目录，首次连接仍由受保护的 Host 启动流程准备存储。

`SWB_LOG_LEVEL` 接受大小写不敏感的 `off`、`error`、`warn`、`info`、`debug`、`trace`，默认 `info`；空值、空白和日志过滤表达式会返回 `INVALID_ARGUMENT`。该级别控制当前 CLI / MCP 进程的应用日志，写入 stderr；stdout 继续只承载 CLI JSON 或 MCP 协议。`off` 保留致命错误输出。`debug` / `trace` 会记录配置来源和级别枚举，不输出实际目录、参数或凭据。

这两项环境覆盖当前作用于 CLI / MCP。客户端启动子 Host 时显式传递解析后的目录；直接运行 Host 和桌面入口的配置来源查询继续随 M1b 集成。

## 产品身份配置

名称、包名、标识符、深链 scheme、浏览器存储命名空间及更新信任集中在 [app.config.json](../app.config.json)。

修改身份使用产品配置同步入口，先检查差异：

```sh
pnpm config:sync --config ../serial-workbench-config.json --dry-run
pnpm config:sync --config ../serial-workbench-config.json
pnpm config:check
```

`--config` 文件是现有配置的字段补丁，字段与校验见 [init-lib.mjs](../scripts/init-lib.mjs)。同步器更新 npm / Cargo 身份、平台配置、测试身份和品牌链接。标识符与存储命名空间变化会改变数据位置，同步器保留原有用户数据；正式交付后的身份迁移须单独设计。

仓库链接、分支和市场子模块地址由 [repository.config.json](../repository.config.json) 维护，修改后运行 `pnpm repository:sync` 和 `pnpm repository:check`。生成同步状态与配置一起审查，具体范围见 [仓库托管配置](./repository-hosting.md)。

图标与安装器视觉源在 `resources/branding/`，修改后运行 `pnpm branding:generate` 并提交生成结果，见 [安装器外观](./build-release.md#安装器外观)。版本使用 `pnpm version:set x.y.z`；签名和发布配置见 [构建与发布](./build-release.md)。

## 新增页面到 IPC 与测试

1. 对照 [产品范围](./product-scope.md) 确定本次用户行为与失败路径。页面放在 `src/pages/`，业务形成独立规则后再建 `src/features/<domain>/`。
2. 在 `src/routes.tsx` 统一注册路由、懒加载、预载和导航。菜单、命令面板及快捷键复用 `src/commands/`；窗口与原生深链白名单同步核对。
3. 文案同步中英文词典，局部状态留在组件，跨页偏好进入现有设置模型和同步器。涉及未保存内容时登记 `useUnsavedWork`。
4. 原生能力由 Rust 服务实现，命令层负责边界适配；手写前端通过 `src/lib/tauri.ts` 门面调用。组件和 Hook 不直接导入 Tauri 插件或调用 `invoke`，Rust 在提交边界校验身份、路径、配额和权限。
5. 在 `src-tauri/src/bindings.rs` 注册命令 / DTO，按 [Rust 测试](./testing.md#rust-测试) 准备 `dist/`，依次运行 `pnpm bindings:generate`、`pnpm bindings:check`，提交 IPC 绑定。
6. 按 [日常验证范围](./testing.md#日常验证范围) 检查规则与入口接线；原生窗口和系统服务按 [桌面验收](./testing.md#真实桌面-e2e) 安排。删除能力时一并清理路由、命令、权限、专属依赖、资源、测试与文档。

## 环境诊断

```sh
node scripts/doctor.mjs
node scripts/doctor.mjs --json
```

诊断无需 npm 依赖，只读检查工具链、Git、依赖与平台组件。缺少必要组件时退出码为 1；纯浏览器开发按实际需要处理 Rust / 桌面组件提示。构建故障见 [排障手册](./troubleshooting.md)。

## 清理构建产物

清理命令支持 `--dry-run`，先核对实际删除范围：

```sh
pnpm clean:outputs --dry-run
```

| 命令                   | 删除范围                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `pnpm clean:outputs`   | 构建输出、报告，以及 `artifacts/` 和 `.cache/` 中的生成内容；保留识别出的 Cargo 缓存 |
| `pnpm clean:artifacts` | 整个 `artifacts/`                                                                    |
| `pnpm clean:temporary` | 临时报告、构建输出、默认 Rust 缓存和旧便携备份；保留正式版本归档                     |
| `pnpm clean`           | 默认构建输出、整个 `artifacts/` 和默认 Rust 缓存                                     |
| `pnpm clean:all`       | `clean` 的范围及 `node_modules/`                                                     |

`clean:outputs`、`clean:artifacts`、`clean` 和 `clean:all` 都会删除正式分发文件。各模式的精确路径与缓存识别规则见 [clean-lib.mjs](../scripts/clean-lib.mjs)，自定义 Cargo target 由设置者管理。先停止自己启动的开发或测试进程，再按预览结果清理；正常编译等待可保留缓存。

## 环境变量

`VITE_` 变量会进入前端 bundle，只存公开配置。新增变量在 `src/vite-env.d.ts` 声明并在使用处校验；本地 `.env.local` 保持在版本控制之外。凭据使用受控构建环境或系统存储，见 [安全规范](./security.md#密钥与证书)。

## 调试

前端使用 WebView 开发者工具；浏览器预览可使用 React DevTools。Rust 日志位置见 [先看日志](./troubleshooting.md#先看日志)，沿用日志插件并保持脱敏。

VS Code 的 [launch.json](../.vscode/launch.json) 和 [tasks.json](../.vscode/tasks.json) 提供 Rust / WebView 与浏览器调试入口。Rust 修改后重新构建并重启调试进程。

## 热更新边界

前端 TSX / CSS 由 Vite 更新；Rust、capability、平台配置变化后，重新构建并重启原生进程。依赖变更后重新安装并审查锁文件；生成文件通过对应脚本更新。

## 端口被占用

Vite 固定使用 1420 端口并启用 `strictPort`，处理方式见 [端口排障](./troubleshooting.md#端口-1420-被占用)。

## 依赖下载失败或缓慢

按报错区分 registry、源码托管和安装器下载，检查当前终端网络与代理。使用可信镜像并保留锁文件；安装器下载见 [NSIS 排障](./troubleshooting.md#打包时卡在下载-nsis)。

## 编译耗时优化

前端迭代使用 HMR，正式分发再打包；Rust 并发与缓存配置见 [编译策略](./build-release.md#编译策略)，检查任务安排见 [并行与耗时](./testing.md#并行与耗时)。

## 重置环境

先核对报错、工具链和锁文件差异。确需重装时预览 `pnpm clean:all --dry-run`，按 [清理范围](#清理构建产物) 确认后执行清理，再运行 `pnpm install --frozen-lockfile`。用户存档故障使用 [设置恢复](./troubleshooting.md#设置保存失败或版本不兼容)。

## 新增依赖的评审标准

PR 说明实际用途、维护与兼容状态、许可证和分发义务。显著影响 bundle 时比较加载边界和体积；Rust 依赖同时评估编译成本与目标平台。优先复用现有能力，锁文件只保留定向变化。

## IDE 配置

推荐扩展与格式规则见 [extensions.json](../.vscode/extensions.json) 和 [settings.json](../.vscode/settings.json)。编辑器搜索和 Vite 监听已排除构建输出、缓存与依赖。

## 浏览器预览构建与部署

```sh
pnpm build:web
pnpm exec vite preview --outDir dist-web
```

构建使用 `web-preview` 模式，输出 `dist-web/`；桌面前端输出 `dist/`。相对资源路径与 HashRouter 支持 `/serial-workbench/` 等静态子路径。

发布前执行 [浏览器构建冒烟](./testing.md#浏览器生产构建冒烟)。Pages 模板状态与启用步骤见 [停用目录说明](../.github/workflows-disabled/README.md)。
