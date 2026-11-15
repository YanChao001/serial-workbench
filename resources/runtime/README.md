# 固定 Node runtime 输入

[`node-release.json`](./node-release.json) 是四目标构建输入；字段由 [`NodeRuntimeRelease`](../../crates/core/src/node_runtime.rs) 定义，Core 同时验证版本、目标、官方 URL 与固定资源路径，并导出 schema/SDK 类型。归档摘要与归档内可执行文件、完整 LICENSE 的摘要分别锁定，保留平台原始字节。

[`node-release-key.gpg`](./node-release-key.gpg) 是从 Node 官方 [release-keys](https://github.com/nodejs/release-keys/tree/481637f813e912c4aa3622d7964ab426c97b8e8d) 的固定 keyring 导出的最小公开验证密钥，指纹为 `C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C`，文件 SHA-256 为 `226f5400928425e9094e3d994ef17247816df382e19369f4dd32401d729e1370`。发布清单使用该已认可公钥验签，再与机器清单逐项核对归档摘要；仅凭下载文件自带的密钥不能建立信任。

modules ABI 147 / Node-API 10 已由 Windows 官方二进制的固定路径探测核对，并与其余三个官方归档的 `node_version.h` 比较。后者仍须在本架构实际启动自检，签名/重签导致的字节变化另保留两阶段收据。

[`node-runtime-source.mjs`](../../scripts/node-runtime-source.mjs) 使用生成校验器、固定公钥与 [`SHASUMS256.txt.asc`](./SHASUMS256.txt.asc) 核对真实上游签名及四归档摘要，GPG 工作目录独立，失败保留证据。构建机需有 `gpgv`；Windows 可使用 Git 附带版本。密码学输入按 `.gitattributes` 保留原始字节。

当前处于 Task14.2：下载、准备、构建与 Host 资源校验/固定自检已接线，Windows 实际基础 API、安装布局夹具和失败边界已有本机证据；其他目标原生运行、真实安装布局、Linux 私有加载及插件监督继续验收。`requiredPrivateLibraries` 记录 Linux 的必需资源，实际随包和加载结果分别验收。版本来源、最低系统、许可及验收要求见 [分发基线](../../docs/contracts/runtime-distribution.md)，实际结果见[开发进度](../../docs/progress.md)。

[`libatomic-jammy.json`](./libatomic-jammy.json) 由 [`NodeRuntimeLibraryRelease`](../../crates/core/src/node_runtime_library.rs) 约束，锁定 Ubuntu Jammy 的 libatomic1/gcc-12-base、实际库/SONAME、copyright 和三份完整对应源码。Ubuntu 公钥、InRelease 及两个原始压缩索引作为约 5.5 MiB 的固定构建证据保留；[`node-runtime-library-source.mjs`](../../scripts/node-runtime-library-source.mjs) 断网验证签名、索引及每个二进制/源码条目的身份与摘要，避免依赖已更新的滚动索引。快照来源为 Ubuntu 官方仓库，archive 签名者指纹参照 [Ubuntu 官方说明](https://wiki.ubuntu.com/SecurityTeam/FAQ)。

[`libatomic.COPYRIGHT`](./libatomic.COPYRIGHT) 保留选中包的原始许可全文；libatomic 对应 `GPL-3.0-or-later WITH GCC-exception-3.1`，完整源码和 Debian 补丁/描述文件在准备缓存中按 SHA-256 锁定。后续 Linux 分发收集这些对应材料及来源收据，实际动态依赖、私有加载与安装验收继续独立记录。

[`libatomic.GPL-3.0`](./libatomic.GPL-3.0) 从已验证对应源码的 `gcc-12.3.0/COPYING3` 原样取出。它与 copyright 中包含的 Runtime Exception 3.1 一起进入 Linux 许可目录，不依赖用户另找系统许可文件。

从仓库根获取当前目标的固定来源，再独立运行准备器：

```sh
pnpm runtime:fetch --target x86_64-pc-windows-msvc
pnpm runtime:prepare --target x86_64-pc-windows-msvc --archives .cache/node-runtime/sources/node-26.13.0
```

下载器先离线验证固定签名链，仅请求机器清单中的官方 HTTPS 地址，不跟随重定向。完整大小与摘要匹配后排他发布缓存；缺失缓存可下载，坏缓存与失败的部分文件保留并停止。`runtime:fetch --offline` 仅核对已有缓存；单文件默认下载预算 120 秒，超时/取消关闭响应和文件后返回。

Linux 另提供 `--artifacts .cache/node-runtime/sources/libatomic1-jammy-12.3.0-22.04.3`，必须含两个 deb 和三份对应源码。准备器在唯一目录下生成 `resources/`，来源材料位于其 `runtime/materials/node-26.13.0/`；核对文件/架构并运行 ABI 自检，Linux 检查私有 libatomic 实际加载。`--no-self-test` 仅用于跨目标静态准备，收据明确记录未执行，不能计为运行验收。

`app:build` 与 `app:portable` 自动执行同一下载/准备链，将 `resources/` 映射为应用资源根；原有 Tauri 资源保留。设置 `SWB_RUNTIME_OFFLINE=1` 可禁止构建时补下载，此设置不等于操作系统断网验收。便携版 `--skip-build` 同时核对运行时、许可与来源材料摘要，不能复用遗漏运行时的旧收据。构建机需要 GPG 和归档工具，最终用户不依赖这些开发工具。

Linux runtime 通过整目录打包映射收集；未打包输出另行保留 SONAME 链接、模式和摘要，失败保留候选及必要的旧输出。资源检查的预算只覆盖 `runtime/` 目录。此接线在本机做了目录/链接边界验证，真正的 Unix SONAME 复制和加载仍须相应目标运行。

Host 无界面验收使用正式资源定位、文件校验和固定自检 API：

macOS 本机准备会保留原件并对副本使用仓库固定的 entitlements 收紧 ad hoc 签名，来源和准备后的身份分别留存。构建时将同套 `runtime/node-image.json` 的绝对路径通过 `SWB_NODE_RUNTIME_BUILD_IMAGE` 编入 Host；显式构建 probe 和运行原生测试也必须传入同一绑定，CI 已接线。原始 Cargo 构建没有该绑定时不会执行未绑定的 macOS Node。签名命令和原始输出随准备目录保留，正式 Developer ID/公证及最终发行继续单独验收，见 [内容绑定](../../docs/contracts/runtime-distribution.md#host-校验与自检基础)。

```sh
cargo build --locked -p serial-workbench-host --example node_runtime_probe --target <triple>
pnpm test:runtime --target <triple> --resources <应用实际输出目录> --probe <实际构建的node_runtime_probe路径>
```

验收器从实际资源复制独立的中文/空格安装布局夹具，验证受控环境、缺失、篡改、错架构、取消、预算及进程真实退出；原始源码/产物不修改，失败和原始输出保留。收据明确注明这不是实际安装器或系统断网验收。普通 `cargo test` 显式忽略需要真实原生资源的测试；设置绝对 `SWB_NODE_RUNTIME_TEST_ROOT` 并使用 `--include-ignored --test-threads=1` 才能执行这些用例。Windows 当前为 4 个普通边界和 2 个实际原生用例通过，十场景结果见进度；其他目标待运行。
