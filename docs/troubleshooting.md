# 排障手册

先确定运行环境、应用版本和可复现场景，再核对日志与配置。可用能力见 [产品范围](./product-scope.md)，环境检查使用 `node scripts/doctor.mjs`。

## 先看日志

设置中的诊断区可复制脱敏报告。日志由 Tauri 路径 API 定位，当前应用标识符对应的常见位置：

| 系统    | 日志位置                                                           |
| ------- | ------------------------------------------------------------------ |
| Windows | `%LOCALAPPDATA%\io.github.yanchao001.serialworkbench\logs\app.log` |
| macOS   | `~/Library/Logs/io.github.yanchao001.serialworkbench/app.log`      |
| Linux   | `~/.local/share/io.github.yanchao001.serialworkbench/logs/app.log` |

文件日志初始化失败时退到 stderr，开发模式同时查看启动终端。反馈前按 [日志规范](./security.md#日志) 复核敏感字段，保留错误 code 与触发步骤。

## 窗口不出现 / 白屏

先检查已有实例、托盘、其他显示器、快捷方式目标和系统安全提示，再区分进程启动、Rust 初始化、前端加载和首帧显示阶段。开发模式核对 1420 端口及终端错误；生产构建检查资源路径、CSP 拦截、平台 WebView 版本与原生日志。

真实窗口排查遵守 [桌面边界](./testing.md#避免干扰本机桌面)。

## 启动慢或重复启动后卡死

比较同一构建配置下的首次与后续启动，记录各阶段耗时，核对缓存与存档。开发模式先确认是否仍在 Rust 编译；原生任务或系统调用需等到实际退出后再重试。

## 启动时反复打印 libpng / iCCP 警告

定位具体图片，核对资源原件与生成流程。品牌图标修改 SVG 后运行 `pnpm branding:generate`，重新构建检查警告是否消失。

## 保存工作区时出现 Unsupported workspace route

核对 `save_workspace_route` 入参与 [allowed_route](../src-tauri/src/system_commands.rs) 白名单，以及前后端版本。[use-workspace.ts](../src/hooks/use-workspace.ts) 只保存非隐藏主路由。新增页面时核对工作区保存与深链各自的允许范围。

## 安装后仍显示旧图标

核对实际启动 exe、快捷方式目标和系统图标缓存。源 SVG 更新后按 [安装器外观](./build-release.md#安装器外观) 生成资源，再重新构建并安装。

## MSI 没有弹出管理员权限确认

检查安装范围、系统策略、安装日志和卸载登记。UAC 提示取决于安装范围与策略，安装和升级结果按 [正式安装版验收](./testing.md#安装版与启动验收) 确认。

## WebView2 缺失

安装符合目标系统的 WebView2 Runtime；便携包提供下载说明，正式安装包按 [安装版验收](./testing.md#安装版与启动验收) 检查运行时安装和首次启动。

## Rust 构建长时间没有进展

检查 CPU、磁盘、编译日志与实际子进程，确定正在编译或链接的依赖。原生依赖和平台链接首次编译可能耗时，后续复用固定工具链与 target 缓存。

## 打包时卡在下载 NSIS

区分下载、解压、编译和签名阶段，检查 Tauri 工具缓存、当前终端代理和下载来源。缓存项确已损坏时只处理该项，再执行对应构建并保留错误日志。

## cargo 报 linker not found

检查 MSVC / Xcode / Linux 链接工具与目标工具链是否匹配，按 [环境要求](./development.md#环境要求) 准备。工具安装后重新启动终端和 IDE，使其读取新的 PATH。

## 端口 1420 被占用

确认占用进程归属后停止自己的开发服务。更换端口时同步 [vite.config.ts](../vite.config.ts)、[Tauri build.devUrl](../src-tauri/tauri.conf.json) 及 [编辑器调试配置](../.vscode/launch.json) 和 [任务](../.vscode/tasks.json)。

## 串口无法连接

工作台的“故障定位 → 无法连接”提供 Windows、macOS、Linux 的离线分步引导，标题可用 Tab 聚焦并用 Enter 或空格展开。先记录返回的错误码，再选择对应系统手动检查；访问被拒绝本身无法确定端口占用者。

| 系统    | 操作索引                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows | 从开始菜单打开设备管理器，检查端口或 USB 设备属性中的状态、错误码、厂商与驱动；确认自己的应用使用同一端口时，关闭该终端或串口应用后重试。设备报告驱动错误时，按识别出的硬件通过 Windows Update 或厂商正式驱动处理。                                                      |
| macOS   | 在系统信息的 USB 中确认硬件识别，选择当前 `/dev/cu.*` 设备。Apple Silicon 笔记本出现系统配件批准提示时，先解锁并允许当前配件。确认自己的其他串口应用已释放设备；驱动需求按厂商要求和实际系统错误判断。                                                                   |
| Linux   | 只读运行 `ls -l <设备路径>` 查看所选真实 `/dev/tty*` 节点的权限与所属组，运行 `id -nG` 查看用户组。Ubuntu、Debian 常见 `dialout`，其他发行版按实际设备组处理。需要调整时由用户或管理员按发行版方法加入正确组，并重新登录；节点不存在时检查连接、内核日志与厂商驱动要求。 |

完成系统操作后，使用引导下方的“刷新”重新列出设备，选择当前设备并重试打开。应用保留原始错误，不代为执行系统命令或修改权限。

系统操作依据：[Microsoft 设备管理器](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/using-device-manager)、[Apple 配件连接许可](https://support.apple.com/en-us/102282)（Apple Silicon 笔记本）、[Debian 安全手册](https://www.debian.org/doc/manuals/securing-debian-manual/securing-debian-manual.en.pdf)（`dialout` 串口访问）。

## invoke 报 command not found

核对命令注册、生成绑定及实际运行二进制的版本，重新构建并重启原生进程。新增命令按 [页面到 IPC 流程](./development.md#新增页面到-ipc-与测试) 接入。

## invoke 报 not allowed / permission denied

根据稳定 code 区分 capability、窗口身份和文件资源 ID 错误。按 [能力最小化](./security.md#能力最小化) 为实际调用者授予所需权限，保留窗口和路径约束。

## 窗口位置或尺寸异常

核对显示器工作区、缩放、远程桌面切换和窗口几何恢复。使用设置恢复默认尺寸，再在对应平台复测多显示器与全屏行为。

## 中文输入法候选框位置错乱

记录系统、WebView、缩放和窗口模式，检查输入区几何与 CSS 变换。修复时保留 IME 组合输入，等待组合完成后再处理 Enter 提交。

## 高分屏字体发虚

核对系统缩放、WebView 版本和 CSS 变换，比较同环境下的字体与图片资源，使用设置中的字号选项调整文字大小。

## 杀毒软件误报

保留文件哈希、下载来源、检测报告和实际签名结果，按服务商渠道提交样本。签名核验见 [代码签名](./build-release.md#代码签名)。

## Windows 归档目录出现 EPERM

核对报错路径及占用进程，关闭自己创建的预览、测试或资源管理器占用后重试。自定义监听沿用 Vite 对生成目录的排除规则，保留正在使用的归档。

## pnpm 锁文件冲突

先合并 package 清单，再基于已有锁文件重新解析，审查并保留本次定向变化。Git 处理见 [冲突处理](./conventions/git-workflow.md#冲突处理)。

## 编译内存不足

定位耗内存的编译阶段，减少并发；共享 target 的 Cargo 和绑定任务顺序执行。配置见 [编译策略](./build-release.md#编译策略)。

## 更新功能不可用

当前 [app.config.json](../app.config.json) 的更新端点和公钥为空，更新框架停用。需要发布更新时按 [自动更新](./build-release.md#自动更新) 配置信任、签名和服务端，并在目标安装版验证完整升级。

## 设置保存失败或版本不兼容

记录错误 code 并保留原件。revision 冲突先重读合并，读取或备份失败先处理对应错误。未来 schema 可使用兼容版本读取；如决定放弃原设置，可在设置中确认重置，替换为当前默认值。

故障隔离界面的“恢复默认设置”使用暂存流程：确认后点击“重启应用”才安装候选并归档原件，且会拒绝覆盖未来格式。该操作与普通设置重置不同，流程见 [恢复架构](./architecture.md#恢复诊断与更新)。

## 系统能力不可用

在桌面环境核对平台权限和实际窗口身份，分别检查通知、自启动或剪贴板。浏览器预览中的原生调用会返回环境限制。

## E2E 无法连接或窗口操作超时

核对 [E2E runner](../e2e/run.mjs) 日志、测试构建记录、端口、临时目录和驱动。WebDriver 来自测试 feature，使用 `pnpm e2e:build` 构建；窗口排查按 [真实桌面 E2E](./testing.md#真实桌面-e2e) 安排。

## 问题升级与反馈

提供应用版本、系统 / WebView、触发步骤、稳定错误 code、脱敏日志及实际检查结果。安全问题使用 [私密报告](../SECURITY.md)。
