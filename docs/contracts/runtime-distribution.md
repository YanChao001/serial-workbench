# Node runtime 与四目标分发基线

本文保留 2026-11-07 的 runtime 选型与 M2/M3 验收输入，配合 [Node 契约](./node-extension-v0.md)实施。平台目标见[需求](../requirements.md#平台目标)，当前实现和验证结果见[进度](../progress.md)；随包 Node 尚未交付，实施前重新核对来源、许可和目标系统支持。本文的升级仅指新体系版本之间。

## 版本与来源

随包 runtime 固定 **Node 26.13.0 LTS（Lithium）**，使用官方预编译归档。开发 Node 由 [`.nvmrc`](../../.nvmrc)指定，pnpm 由 [`package.json`](../../package.json)指定，Rust 由 [`rust-toolchain.toml`](../../rust-toolchain.toml)指定；开发工具的版本和检查成功不能代替随包 runtime 的目标环境验收。终端用户无需安装 Node、npm、pnpm、Rust 或编译器。

四个下载地址与 SHA-256 如下；SHA 来自[该版本官方清单](https://nodejs.org/download/release/v26.13.0/SHASUMS256.txt)，已与[发布说明](https://nodejs.org/en/blog/release/v26.13.0)逐项核对。

| target                     | 官方归档 URL                                                                     | SHA-256                                                            |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `x86_64-pc-windows-msvc`   | <https://nodejs.org/download/release/v26.13.0/node-v26.13.0-win-x64.zip>         | `dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a` |
| `aarch64-apple-darwin`     | <https://nodejs.org/download/release/v26.13.0/node-v26.13.0-darwin-arm64.tar.gz> | `d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6` |
| `x86_64-apple-darwin`      | <https://nodejs.org/download/release/v26.13.0/node-v26.13.0-darwin-x64.tar.gz>   | `525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e` |
| `x86_64-unknown-linux-gnu` | <https://nodejs.org/download/release/v26.13.0/node-v26.13.0-linux-x64.tar.xz>    | `d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997` |

M2 获取[签名清单](https://nodejs.org/download/release/v26.13.0/SHASUMS256.txt.asc)，按[上游验签流程](https://github.com/nodejs/node/blob/v26.13.0/README.md#verifying-binaries)使用受信任的 [Node 发布公钥](https://github.com/nodejs/release-keys)验证发布者，再计算所下载归档的 SHA-256，与已验签清单和本表同时比较。记录 keyring 固定版本、公钥指纹、归档 URL、计算值及验签结果。下载失败、签名失败或任一 hash 不同即停止打包；不得改用浮动版本、镜像中的另一文件或系统 Node。

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

1. 从 Ubuntu 22.04 官方仓库的 [amd64 libatomic1](https://packages.ubuntu.com/jammy/libatomic1)选定兼容包，在机器清单锁定完整包版本、仓库签名证据、下载 URL、包/库 SHA-256、源码和许可；具体版本/hash 在 M2 取包时固定，本次未验证该库二进制。不得从开发机任意复制 `.so`。
2. 将所需 `libatomic.so.1` 及其真实库文件放入下述 runtime 私有 `lib/`，保留 SONAME 链接、模式和许可；检查 ELF `NEEDED`、符号版本及传递依赖在 Ubuntu 22.04、24.04、Debian 12 均满足。该库许可通常是 GPL-3.0-or-later WITH GCC-exception-3.1，按选中包实际 copyright 核对，提供对应源码及必要补丁/构建信息；不能套用 Node 的 MIT 许可。许可依据见 [GCC libatomic 声明](https://github.com/gcc-mirror/gcc/blob/releases/gcc-11.5.0/libatomic/libatomic_i.h)及 [Runtime Library Exception](https://github.com/gcc-mirror/gcc/blob/releases/gcc-11.5.0/COPYING.RUNTIME)，此版本链接只说明许可结构，未选定库版本。
3. Host 仅对 Node 子进程设置到该私有绝对目录的库搜索路径，清理继承的加载注入配置，不更改全局环境或系统库。M2 通过动态加载记录确认真正使用随包库；deb 与 AppImage 都检查，不能依赖打包器自动发现 Node 的依赖。其余系统库和 WebKitGTK 按包依赖/离线部署材料交付。
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

M2 将 Windows 归档根下 `node.exe` 映射到上述 `bin/`；其他归档去掉上游顶层目录。归档 hash 与安装后文件 hash 分开记录，签名导致字节变化时保留两阶段收据。实际启动是 `R` 加固定路径的原生进程调用，参数以数组传递；不经过 shell。仅接受同套发行声明的插件宿主入口，清理继承的 `NODE_OPTIONS`、`NODE_PATH` 等注入项。重启后仍使用同一发行的资源；运行文件不放用户插件缓存或数据目录。

runtime 缺失、架构不符、完整性失败、依赖缺失、启动超时、版本/ABI 不兼容须能分别诊断，使用 [Host 错误契约](./host-v0.md)的稳定 code 与结构化详情，M2 固定具体映射。错误通过 GUI、CLI/MCP 和诊断日志一致呈现，保留基础服务；修复通过校验过的整套安装/升级包完成。

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

以下四级分别记录证据。2026-11-07 的 M0 记录仅覆盖上游文字与清单核对，未下载四个归档计算 hash、未做 GPG 验签，也未执行目标机器或安装器；这些步骤仍待实际验收。

| target                     | 上游信息与 SHA 文本核对               | 下载包 hash / GPG 验签 | 最低目标离线运行                   | 安装 / 升级 / 签名         |
| -------------------------- | ------------------------------------- | ---------------------- | ---------------------------------- | -------------------------- |
| `x86_64-pc-windows-msvc`   | 2026-11-07 已核对；Win10 EOL 冲突见上 | 待验                   | 待验                               | NSIS / MSI / ZIP 各待验    |
| `aarch64-apple-darwin`     | 2026-11-07 已核对                     | 待验                   | macOS 14 arm64 待验                | app / DMG、签名 / 公证待验 |
| `x86_64-apple-darwin`      | 2026-11-07 已核对                     | 待验                   | macOS 14 Intel 待验                | app / DMG、签名 / 公证待验 |
| `x86_64-unknown-linux-gnu` | 2026-11-07 已核对                     | 待验                   | Ubuntu 22.04/24.04、Debian 12 待验 | deb / AppImage 各待验      |

每个目标均使用没有系统 Node/npm 的断网环境，实际从最终包启动 GUI、独立 Host、CLI/MCP 和至少一个正式随包插件；验证从其他当前目录启动仍使用固定 runtime。负例覆盖错架构、损坏/缺失 runtime、缺少系统依赖、addon ABI 不符，以及录制/插件任务在后台时推迟升级、停止接新任务、结算失败保留旧版和成功整套切换。原生图形界面与浏览器分别记录结果，架构模拟运行不替代本架构验收。

M2 由[推进计划](../plan.md)的 runtime/包加载任务接入机器可读清单、下载验签器、资源映射、许可收集器和自检/故障用例；本表是精确输入，工具和命令尚未实现。清单至少容纳上述版本/target、来源/hash/签名证据、资源路径、系统依赖、ABI、许可、兼容范围和验收收据。M3 接入整套组件升级与签名验收。

实际验收入口沿用[安装与发行验收](../testing.md#安装与发行验收)、[交付检查](../development.md#交付检查)和[桌面边界](../testing.md#桌面边界)，在独立机器/虚拟机或用户安排的前台时段运行。PR/Release 记录版本、commit、target、系统 edition/build、依赖版本、最终包 hash、签名身份/状态、执行步骤、结果和未通过项，据此声明实际可交付范围。
