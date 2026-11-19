# Node runtime 与四目标分发基线

本契约规定随包 Node 的来源、安装布局、自检和升级条件。[资源准备指南](../../resources/runtime/README.md)给出操作命令；[路线与进度](../plan.md#验证基线)区分已过的四目标自检与尚未完成的最低系统、最终安装器和发行验收。

## 版本与来源

[机器清单](../../resources/runtime/node-release.json)固定版本、ABI、四个 target、官方 URL、归档与解包内容摘要；开发工具版本另由项目配置决定。用固定公钥核对[签名清单](../../resources/runtime/SHASUMS256.txt.asc)后，再比较下载大小和 SHA-256。任何签名、来源或摘要不符均停止打包，不得改用镜像、浮动版本或系统 Node。终端用户不需要开发工具。

## 平台目标与静态核对

Node 条件取自 [v26.13.0 BUILDING.md](https://github.com/nodejs/node/blob/v26.13.0/BUILDING.md#platform-list)。产品验收目标由[需求](../requirements.md#平台目标)维护，发行组合的最低条件还受 Host、WebView、addon 和工具共同约束。

| target                     | 产品兼容验收目标 / 格式                                                                     | Node 上游条件                                                                               | 整套组件需核对                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `x86_64-pc-windows-msvc`   | Windows 10 22H2；Windows 11 24H2/25H2；26H2 加入新增测试。NSIS 主包、MSI、便携 ZIP 分别验收 | 表列 Windows 10 / Server 2016 及以上，x64 Tier 1；另受下述 EOL 条款约束                     | Rust MSVC、所需 CRT/DLL、WebView2 及插件工具；不能借 Node 表声明整包兼容                     |
| `aarch64-apple-darwin`     | macOS 14 最低测试边界；分架构 app/DMG                                                       | macOS ≥ 13.5，arm64 Tier 1                                                                  | Host/addon/工具的 deployment target 不高于 14；系统 WKWebView；最终包签名、公证              |
| `x86_64-apple-darwin`      | macOS 14 最低测试边界；分架构 app/DMG                                                       | macOS ≥ 13.5，x64 Tier 2                                                                    | 同上，必须在 Intel 机器运行；上游预告 2028 年初 Intel 测试支持变化，升级 runtime 时复核      |
| `x86_64-unknown-linux-gnu` | Ubuntu 22.04/24.04、Debian 12；deb / AppImage                                               | kernel ≥ 4.18，glibc ≥ 2.28，libstdc++ ≥ 6.0.25（`GLIBCXX_3.4.25`）；运行时还需 `libatomic` | Ubuntu 22.04 基线构建、WebKitGTK 4.1、图形栈、包依赖与 AppImage 执行环境；libatomic 方案见下 |

Rust 的静态交叉核对使用 [1.99.1 平台表](https://github.com/rust-lang/rust/blob/1.99.1/src/doc/rustc/src/platform-support.md)、[MSVC 要求](https://github.com/rust-lang/rust/blob/1.99.1/src/doc/rustc/src/platform-support/windows-msvc.md)和 [Darwin 要求](https://github.com/rust-lang/rust/blob/1.99.1/src/doc/rustc/src/platform-support/apple-darwin.md)：Windows 客户端最低 10，macOS x64/arm64 分别最低 10.12/11，Linux x64 标准库基线 kernel 3.2 / glibc 2.17。最终 Host 链接的依赖可提高二进制要求，须检查实际产物。

Tauri 使用 Windows WebView2、macOS WKWebView 和 Linux WebKitGTK，见[官方 WebView 说明](https://v2.tauri.app/reference/webview-versions/)。Linux 按 [Tauri AppImage 指南](https://v2.tauri.app/distribute/appimage/#limitations)在提供 WebKitGTK 4.1 的最低目标系统构建，并在另外两种基础目标运行；Node 的 glibc 2.28 条件不扩大产品 Linux 范围。当前模板还生成 RPM，RPM 若交付须另列目标环境并验收。

### Windows 10 的供应商支持冲突

Node 的平台策略明确排除供应商已结束支持的系统，即使平台表仍列该版本。[Windows 10 Home/Pro 22H2](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)常规支持已于 2025-10-14 结束。[ESU 不延长产品生命周期或恢复一般技术支持](https://learn.microsoft.com/en-us/lifecycle/faq/extended-security-updates)；不能自行推断 ESU 设备获得 Node 的平台支持。[WebView2 在 Windows 10 22H2 至少更新至 2028 年 10 月且不要求 ESU](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems)，这是独立组件的承诺。

因此保留 Windows 10 22H2 的产品验收目标，同时将普通 EOL 环境标为“产品兼容待验、Node 上游支持冲突”，不能写“Node 官方支持 Windows 10 22H2”。验收记录须注明系统 edition/build、补丁与 ESU 状态。若公开发行需要承诺支持该 EOL 目标，须由用户决定是否承担产品自身的兼容维护责任；若要改最低系统或 runtime 路线，也须另行确认范围变更。M0 不据此删除目标。

### 全新离线环境与 Linux libatomic

Windows 安装包的离线验收必须含 WebView2 缺失场景，采用 Tauri 的 [`offlineInstaller`](https://v2.tauri.app/distribute/windows-installer/#offline-installer)方式随安装器提供 Evergreen 完整安装程序，并锁定来源/hash/许可；在线 bootstrapper 不能满足这项验收。便携 ZIP 保持依赖系统 WebView2，并随包提供离线部署材料和检测说明；缺失时从原生启动入口给出安装指引。WebView2 的版本、签名、安装结果按 [Microsoft 离线部署流程](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#offline-deployment)记录。

Node 25 起的官方 Linux 二进制新增 `libatomic` 动态依赖，见 [BUILDING.md 官方二进制说明](https://github.com/nodejs/node/blob/v26.13.0/BUILDING.md#official-binary-platforms-and-toolchains)。M2 采用**私有随包 libatomic**，避免要求离线用户临时联网安装：

1. [机器清单](../../resources/runtime/libatomic-jammy.json)固定 Ubuntu Jammy 的包版本、签名索引、二进制与对应源码、库和许可的摘要。只从已核验的发行材料准备私有库，不从开发机任意复制 `.so`。
2. 将所需 `libatomic.so.1` 及其真实库文件放入下述 runtime 私有 `lib/`，保留 SONAME 链接、模式和许可；检查 ELF `NEEDED`、符号版本及传递依赖在 Ubuntu 22.04、24.04、Debian 12 均满足。该库许可通常是 GPL-3.0-or-later WITH GCC-exception-3.1，按选中包实际 copyright 核对，提供对应源码及必要补丁/构建信息；不能套用 Node 的 MIT 许可。许可依据见 [GCC libatomic 声明](https://github.com/gcc-mirror/gcc/blob/releases/gcc-11.5.0/libatomic/libatomic_i.h)及 [Runtime Library Exception](https://github.com/gcc-mirror/gcc/blob/releases/gcc-11.5.0/COPYING.RUNTIME)，此版本链接只说明许可结构，未选定库版本。
3. Host 仅对 Node 子进程指定已核验的私有 libatomic 来源，以封印 fd preload，清理继承的加载注入配置；原安装目录不作为其他系统依赖的通用搜索入口，不更改全局环境或系统库。M2 通过动态加载记录确认真正使用随包库；deb 与 AppImage 都检查，不能依赖打包器自动发现 Node 的依赖。其余系统库和 WebKitGTK 按包依赖/离线部署材料交付。
4. 启动前验证文件、架构和完整性，运行有超时的 runtime 自检取得版本、架构与 ABI，再启动插件宿主。缺 `libatomic`、glibc/GLIBCXX 版本不符、其他 DLL/库缺失均归入可诊断的依赖错误，报告缺少的组件与对应离线修复包。缺库时插件执行不可用，Rust 基础服务和已存在的原始录制继续；不循环重启、不改用 PATH Node。

M2 验收须移除系统 `libatomic1` 或使用确实缺库的干净镜像，断网验证私有库方案；再移除随包库验证诊断路径。未完成来源、许可和真实加载验证前，Linux 整包离线项保持待验。

## 安装布局与启动

定义 `R` 为当前发行版本的**绝对应用资源根**。桌面由平台资源定位器取得；独立 Host/CLI 由自身已安装位置与同套发行描述取得同一根。Windows 安装根/便携根、macOS `.app/Contents/Resources`、Linux deb 的包资源根及 AppImage 内资源根分别映射；不从当前工作目录、用户工作区或 PATH 寻找。M2 将各格式的最终映射固定到机器清单，并验证带空格、中文路径及 AppImage 挂载路径。

| 资源                   | 相对 `R` 的固定位置                                        |
| ---------------------- | ---------------------------------------------------------- |
| Windows Node           | `runtime/node/26.13.0/x86_64-pc-windows-msvc/bin/node.exe` |
| macOS arm64 Node       | `runtime/node/26.13.0/aarch64-apple-darwin/bin/node`       |
| macOS x64 Node         | `runtime/node/26.13.0/x86_64-apple-darwin/bin/node`        |
| Linux Node             | `runtime/node/26.13.0/x86_64-unknown-linux-gnu/bin/node`   |
| Linux 私有依赖         | `runtime/node/26.13.0/x86_64-unknown-linux-gnu/lib/`       |
| Node 全量许可          | `runtime/node/26.13.0/<target>/LICENSE`                    |
| addon / 工具许可与来源 | 发行清单指向各组件的版本化目录及对应 `licenses/`           |

M2 将 Windows 归档根下 `node.exe` 映射到上述 `bin/`；其他归档去掉上游顶层目录。归档 hash 与安装后文件 hash 分开记录，签名导致字节变化时保留两阶段收据。Host 只从 `R` 与固定路径取得该版本资源，再按下文的平台机制绑定实际启动身份；参数以数组传递，不经过 shell。仅接受同套发行声明的插件宿主入口，清理继承的 `NODE_OPTIONS`、`NODE_PATH` 等注入项。重启后仍使用同一发行的资源；运行文件不放用户插件缓存或数据目录。

runtime 缺失、架构不符、完整性失败、依赖缺失、启动超时、版本/ABI 不兼容须能分别诊断，使用 [Host 错误契约](./host-v0.md)的稳定 code 与结构化详情，M2 固定具体映射。错误通过 GUI、CLI/MCP 和诊断日志一致呈现，保留基础服务；修复通过校验过的整套安装/升级包完成。

### Host 校验与自检基础

实现位于 [`crates/host/src/node_runtime`](../../crates/host/src/node_runtime/mod.rs)，不依赖 Tauri。Windows 从程序所在目录取 `R`，macOS 从 `Contents/MacOS` 取相邻 `Contents/Resources`，Linux deb/AppImage 从程序目录取 `../lib/<productName>`；未打包 Cargo 产物以其 `.cargo-lock` 所在输出目录为根。产品目录名随组件构建配置编入 Host；运行时的 `APPDIR`、PATH、工作区和当前目录不提供替代根。

Host 将 `R/runtime/node-release.json` 与编译时固定来源矩阵逐项比较，验证 Node、完整 LICENSE、Linux 私有库及许可的大小、摘要、架构与路径边界。普通资源不允许目录链接或重解析点，唯一例外是清单固定的 Linux 相对 SONAME 链接。Windows 在验证对象存续期间持有拒绝写入/删除共享的文件句柄及祖先目录保护句柄；更新仍须等相关 owner 结算后切换。macOS 对准备后 Node 使用本次可信构建编入的身份，原始来源摘要继续独立保留；本机/CI 的 ad hoc 签名不计正式发行签名验收。

固定脚本自检使用绝对程序路径和参数数组，清除继承的 `NODE_`、`LD_`、`DYLD_`、`OPENSSL_` 及加载注入配置；仅 Linux Node 子进程得到封印私有库的加载参数，并通过加载记录核对实际 libatomic。默认文件验证预算 30 秒、自检预算 10 秒、stdout/stderr 合计 256 KiB。停止或超限后先结束进程、等待真实退出并归并读者，随后返回；阻塞 I/O 的取消在实际调用返回后结算。Windows 后台进程按 [Microsoft 错误模式约定](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode)配置加载错误诊断，保留既有模式并抑制系统错误对话框；真实缺 DLL 场景仍待独立环境核验。

Unix 的只读文件句柄不能阻止替换或原地改写，因此校验后不直接重新信任同名路径。Linux 将原始已打开 Node 和 libatomic 分块复制并再次核对固定摘要，使用 [memfd sealing](https://man7.org/linux/man-pages/man2/memfd_create.2.html) 禁止写入、增长、截短及变更封印；Node 通过封印 fd 执行，私有库通过仅该子进程持有的 fd preload，原目录仍按固定 SONAME/许可规则验证。证明对象持有这些内核资源直到实际进程退出；自检的 `execPath` 如实记录匿名映像标识，安装来源路径单独保留。后台与 SDK B 仍须验收该机制下的派生进程、worker 和 Node API 兼容性，不把当前固定自检提升为插件后台已完成。

macOS 的官方原件经静态核对含 `disable-executable-page-protection`，Intel 目标不能仅以原 CDHASH 保证执行页面，见 [Apple 的签名检查说明](https://developer.apple.com/documentation/technotes/tn3126-inside-code-signing-hashes)。准备器保留原件、原 hash 和完整许可，仅在独立副本上以固定 [entitlements](../../resources/runtime/node-entitlements.plist) 和 `runtime,hard,kill` 收紧 ad hoc 签名，移除关闭页面保护、调试附着及继承 dyld 环境的例外，保留 JIT 与原生模块所需例外；核对实际签名和 entitlements，记录命令、工具身份及签名前后摘要。`runtime/node-image.json` 的目标、来源 hash、准备后大小/hash、CDHASH 和策略摘要通过 `SWB_NODE_RUNTIME_BUILD_IMAGE` 编入同次 Host；磁盘收据本身不能自授权，普通 Cargo 构建未绑定该身份时 Node 保持不可用。

macOS子进程以原生 `SETEXEC|START_SUSPENDED` 在用户代码运行前暂停。可信Host派生的原生监护是Node的直接父进程，Node有独立进程组；Host通过独立管道取得真实Node PID，用内核 `csops` 的主映像 CDHASH 与本次构建身份核对，要求 VALID/HARD/KILL/RUNTIME，拒绝允许无效代码或调试状态，随后仅向监护发送恢复指令。fork后的原生分支不分配、不取锁或运行Rust清理器，重置信号处置及mask；控制EOF、停止或原Host实时父身份变化均结束Node组、wait Node后退出。Host同时wait监护并核对Node原始终态，不能把监护的退出码当Node结果；PID和exitCode继续报告实际Node。身份不符、未知、取消或预算结束时保留实际flags/CDHASH和退出证据；依据为[XNU启动](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)、[csops](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c)及[Rust pre_exec约束](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#method.pre_exec)。新增监护、两架构实际执行、篡改反例及签名策略的Node兼容性均须CI验证；正式Developer ID、公证、安装及最终整套重签顺序继续属于发行矩阵。

实现保留未reap的直接监护A的PID作为Node组锚。原生观察者B先在A原组内发布PID及内核唯一身份，再自行建立私有组；A确认该屏障后才fork Node，并迁入B组。Host组死亡时A/B仍负责清理；A单独死亡时B结束Node组，整个原生组死亡时由仍持有A锚的Host结束Node组。Host确认Node组清空、B唯一身份连同zombie已回收后，最后wait A；未发布身份的B仍在A原组，其退出由组枚举涵盖。Host的SIGCHLD忽略/SA_NOCLDWAIT策略在启动前拒绝，不修改Host全局策略。最多四条16字节原生记录传送身份、Node PID、原始终态和exec errno；真实启动错误在清理后按稳定code返回，errno仅留私有诊断和日志，不能误报成签名不符。两个原生进程纳入B的RSS验收范围。

| code                              | 含义                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `NODE_RUNTIME_MISSING`            | 必需资源根、描述或 Node 不存在                        |
| `NODE_RUNTIME_TARGET_UNSUPPORTED` | Host 不在四目标内，或二进制 OS/CPU 不匹配             |
| `NODE_RUNTIME_INTEGRITY_FAILED`   | 元数据、路径、类型、摘要、许可或 SONAME 关系损坏      |
| `NODE_RUNTIME_DEPENDENCY_MISSING` | 私有库/SONAME 缺失，或 loader 报告系统库/符号版本不足 |
| `NODE_RUNTIME_START_FAILED`       | 其他启动、进程或输出读取故障                          |
| `NODE_RUNTIME_START_TIMEOUT`      | 文件验证或启动自检预算到期                            |
| `NODE_RUNTIME_INCOMPATIBLE`       | 编译描述、实测版本/ABI 或实际程序身份不符             |

公共错误只含稳定 code、固定说明及 `{component:"nodeRuntime",reason}`，不返回真实路径或原始 loader 输出。原始 stdout/stderr、I/O 错误、PID 与退出证据保留在 Host 私有诊断报告；验收入口写入唯一证据目录。停止前取消使用 `CANCELLED`，输出超限使用 `LIMIT_EXCEEDED`，非法调用参数使用 `INVALID_ARGUMENT`。

Linux 构建通过打包器的目录映射收集 runtime，未打包输出使用保留链接的候选目录提交；避免普通资源逐文件复制解引用 SONAME。核对依据为锁定 [Tauri CLI 2.12.3 的复制实现](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/utils/fs_utils.rs)。阶段清单只统计 `runtime/` 命名空间，其他程序和 Cargo 缓存由各自边界验证，不占本组件预算。

## 组件兼容、许可与升级

发行描述同时锁定 GUI、Rust Host、CLI/MCP 适配器、Node runtime、随包插件的版本与内容 hash，并记录 Host 协议/API、插件 SDK/manifest、数据格式支持范围。客户端附着先按 Host 契约核对身份、代次和协议；主版本不相容时给出升级目标，不能混用磁盘上另一版本的 runtime 或插件入口。

native addon 按**精确 Node runtime / ABI / target**分包：记录 `process.versions.modules`，使用 Node-API 时另记 `process.versions.napi` 与要求的 Node-API 版本；也记录 libc、deployment target 及依赖库约束。版本字段和 ABI 边界见 [Node process 文档](https://github.com/nodejs/node/blob/v26.13.0/doc/api/process.md#processversions)与 [Node-API 稳定性说明](https://github.com/nodejs/node/blob/v26.13.0/doc/api/n-api.md#implications-of-abi-stability)。M2 从已校验 runtime 实测 ABI 值后写清单，不能从开发 Node 推断或在用户机器编译。即使采用稳定 Node-API，仍验证每个目标的安装包与依赖组合。正式插件携带预构建 JS、依赖和资源，离线安装不执行 `npm install`、install/postinstall。

| 组件                             | 需随包记录的来源与许可                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node 与内含第三方库              | 对应官方归档及 [v26.13.0 完整 LICENSE](https://github.com/nodejs/node/blob/v26.13.0/LICENSE)；保留完整原文和第三方声明，不压成单行 MIT |
| addon 与插件依赖                 | 精确版本、来源 URL、hash、构建/ABI/target、许可证及 NOTICE；独立于 Node 许可                                                           |
| 外部工具                         | 按工具逐项记录发布者、精确版本、官方 URL、hash、OS/架构、许可证/NOTICE、再分发或源码要求及签名状态；尚未选定的工具不能标为已包含       |
| Linux 私有库 / WebView2 部署材料 | 各自来源、版本、完整性证据、许可原文与对应源码/再分发条件，列入最终包清单                                                              |

M3 升级按[更新与分发](../architecture.md#更新与分发)：下载并验证新版本目录，附着当前 Host 停止接纳新任务，结算在途任务，相关进程真实退出后切换整套组件。用户可推迟以继续录制；失败保留切换前的安装、用户数据和诊断证据。较早版本的浏览器客户端重连握手后提示刷新，新体系较早版本程序遇到较新数据格式按未来格式保护处理。卸载/更新不得边运行边替换 Node、addon 或工具文件。

签名、公证和更新签名遵循[签名与更新](../development.md#签名与更新)。当前 SignPath 范围仅 NSIS 外层，不覆盖安装后的 Host、Node、addon、工具或 MSI；M2/M3 须按最终组件组合扩展或记录实际范围。macOS 包含 Node、addon、工具后重新验签/公证，并验证 Node JIT 所需 entitlement。先完成代码签名，再对最终交付字节生成更新签名和清单。

## 验收与 M2 实现入口

分别核验上游支持与签名材料、目标架构运行与实际加载、最低系统整套断网运行、最终安装/升级/签名。固定来源核验不等于成功启动，构造的安装布局不等于最终安装器。

每个目标均使用没有系统 Node/npm 的断网环境，实际从最终包启动 GUI、独立 Host、CLI/MCP 和至少一个正式随包插件；验证从其他当前目录启动仍使用固定 runtime。负例覆盖错架构、损坏/缺失 runtime、缺少系统依赖、addon ABI 不符，以及录制/插件任务在后台时推迟升级、停止接新任务、结算失败保留旧版和成功整套切换。原生图形界面与浏览器分别记录结果，架构模拟运行不替代本架构验收。

实际验收入口沿用[安装与发行验收](../testing.md#安装与发行验收)、[交付检查](../development.md#交付检查)和[桌面边界](../testing.md#桌面边界)，在独立机器/虚拟机或用户安排的前台时段运行。PR/Release 记录版本、commit、target、系统 edition/build、依赖版本、最终包 hash、签名身份/状态、执行步骤、结果和未通过项，据此声明实际可交付范围。
