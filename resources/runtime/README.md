# 固定 Node runtime 输入

[`node-release.json`](./node-release.json) 是四目标构建输入；字段由 [`NodeRuntimeRelease`](../../crates/core/src/node_runtime.rs) 定义，Core 同时验证版本、目标、官方 URL 与固定资源路径，并导出 schema/SDK 类型。归档摘要与归档内可执行文件、完整 LICENSE 的摘要分别锁定，保留平台原始字节。

[固定发布公钥](./node-release-key.gpg)、[上游签名清单](./SHASUMS256.txt.asc)和机器清单共同绑定发布者与归档；不得信任下载文件附带的密钥。验签入口为 [node-runtime-source.mjs](../../scripts/node-runtime-source.mjs)。构建机需 `gpgv` 和系统 `tar`，Linux 另需 `dpkg-deb`；密码学输入保留原始字节。

[`libatomic-jammy.json`](./libatomic-jammy.json) 由 [`NodeRuntimeLibraryRelease`](../../crates/core/src/node_runtime_library.rs) 约束，锁定 Ubuntu Jammy 的 libatomic1/gcc-12-base、实际库/SONAME、copyright 和三份完整对应源码。Ubuntu 公钥、InRelease 及两个原始压缩索引作为约 5.5 MiB 的固定构建证据保留；[`node-runtime-library-source.mjs`](../../scripts/node-runtime-library-source.mjs) 断网验证签名、索引及每个二进制/源码条目的身份与摘要，避免依赖已更新的滚动索引。快照来源为 Ubuntu 官方仓库，archive 签名者指纹参照 [Ubuntu 官方说明](https://wiki.ubuntu.com/SecurityTeam/FAQ)。

[`libatomic.COPYRIGHT`](./libatomic.COPYRIGHT) 保留选中包的原始许可全文；libatomic 对应 `GPL-3.0-or-later WITH GCC-exception-3.1`，完整源码和 Debian 补丁/描述文件在准备缓存中按 SHA-256 锁定。后续 Linux 分发收集这些对应材料及来源收据，实际动态依赖、私有加载与安装验收继续独立记录。

[`libatomic.GPL-3.0`](./libatomic.GPL-3.0) 从已验证对应源码的 `gcc-12.3.0/COPYING3` 原样取出。它与 copyright 中包含的 Runtime Exception 3.1 一起进入 Linux 许可目录，不依赖用户另找系统许可文件。

## 准备目标资源

以下是 Windows x64 的例子，从仓库根运行。其他平台须用[清单](./node-release.json)中的本机 target；Linux 还需传入下述 libatomic 材料。

```sh
pnpm runtime:fetch --target x86_64-pc-windows-msvc
pnpm runtime:prepare --target x86_64-pc-windows-msvc --archives .cache/node-runtime/sources/node-26.13.0
```

下载器先离线验证固定签名链，仅请求机器清单中的官方 HTTPS 地址，不跟随重定向。完整大小与摘要匹配后排他发布缓存，坏缓存与失败的部分文件均保留。暂时性连接故障在收到响应前允许重试一次，两次尝试分别存证。`runtime:fetch --offline` 仅核对已有缓存。单次默认下载预算 120 秒，固定的 GCC 完整源码归档为 300 秒。超时或取消关闭响应和文件后返回。

Linux 另提供 `--artifacts .cache/node-runtime/sources/libatomic1-jammy-12.3.0-22.04.3`，必须含两个 deb 和三份对应源码。准备器在唯一目录下生成 `resources/`，来源材料位于其 `runtime/materials/node-26.13.0/`；核对文件/架构并运行 ABI 自检，Linux 检查私有 libatomic 实际加载。`--no-self-test` 仅用于跨目标静态准备，收据明确记录未执行，不能计为运行验收。

`app:build` 与 `app:portable` 自动执行同一下载/准备链，将 `resources/` 映射为应用资源根；原有 Tauri 资源保留。设置 `SWB_RUNTIME_OFFLINE=1` 可禁止构建时补下载，此设置不等于操作系统断网验收。便携版 `--skip-build` 同时核对运行时、许可与来源材料摘要，不能复用遗漏运行时的旧收据。构建机需要 GPG 和归档工具，最终用户不依赖这些开发工具。

Linux 打包保留 SONAME 链接、模式和摘要。Tauri 的 Debian 数据归档会解引用符号链接，构建脚本匹配已验证的库摘要后在 `.deb` 中复原相对链接，再归档和记录最终摘要。Debian 专项使用实际安装目录核对私有库加载。macOS 在副本上使用固定 entitlements 做 ad hoc 签名，原件和准备后身份分别留存。构建 Host、probe 或原生测试前，将 `SWB_NODE_RUNTIME_BUILD_IMAGE` 设为同一资源内 `runtime/node-image.json` 的绝对路径；这不是 Developer ID 签名或公证。

## 验证实际输出

准备器成功后会输出 JSON。`resources` 是含 `runtime/` 的资源根，不是 Node 可执行文件所在目录。运行[原生包测试](../../docs/acceptance.md#签名运行时与-sdk)时将 `SWB_NODE_RUNTIME_TEST_ROOT` 指向该根的绝对路径；此变量供测试夹具使用，不是产品查找系统 Node 的开关。

以下占位符替换为本机 target、待检查的资源根和同一 target 的 probe 路径。使用默认 target-dir 和下列显式 `--target` 时，probe 在 `src-tauri/target/<triple>/debug/examples/`（Windows 带 `.exe`）。传准备器输出检查的是暂存布局，传最终构建资源根才检查该构建。

```sh
cargo build --locked -p serial-workbench-host --example node_runtime_probe --target <triple>
pnpm test:runtime --target <triple> --resources <资源根> --probe <实际构建的node_runtime_probe路径>
```

使用实际输出复制独立布局，检查缺失、篡改、错架构、超时/取消与进程退出。不修改来源；夹具不证明真实安装器或操作系统断网。相关 ignored 用例与环境变量见[测试指南](../../docs/acceptance.md#签名运行时与-sdk)，平台限制见[分发契约](../../docs/contracts/runtime-distribution.md)。
