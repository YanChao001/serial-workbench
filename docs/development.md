# 开发指南

命令从仓库根运行。改动约束见[开发规范](./conventions.md)，证据与未验项见[路线与进度](./plan.md)。

## 环境与启动

工具版本读取 [package.json](../package.json) 的 engines/packageManager、[.nvmrc](../.nvmrc) 和 [rust-toolchain.toml](../rust-toolchain.toml)。Windows 需要 C++ Build Tools、Windows SDK 和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要编译工具与 WebKitGTK 开发库，具体安装见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

首次安装和启动命令见[项目首页](../README.md#从源码运行)。使用 `pnpm run doctor`，不要误调 pnpm 自带的 doctor；未装依赖时可用 `node scripts/doctor.mjs`。缓存由 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 管理；保留编译缓存，不为格式检查放开测试 profile 的权限。

浏览器生产预览使用 `pnpm build:web` 后运行 `pnpm exec vite preview --outDir dist-web`。TSX/CSS 由 Vite 热更新；Rust、capability 和平台配置变化后重新构建并重启原生进程。

React Provider 的组件模块只导出组件，Context、工厂和 Hook 放在相邻模块，避免实现编辑时触发 Fast Refresh 不兼容并使整个页面重载。草稿 Provider 的回归使用当前安装的 Vite React runtime 检查实际导出兼容性，见 [react-refresh.test.mjs](../scripts/react-refresh.test.mjs)。

`pnpm app:dev` 构建同源 Host/CLI 并从 `.cache/dev-runtime/` 的不可变副本启动，避免 Windows 锁住 Cargo 输出。关闭窗口不会退出 Host。`DEV_RUNTIME_MISMATCH` 表示旧实例与当前副本不符，使用相同 profile 运行 `pnpm host:stop` 后再启动；它会断开会话，不强杀进程、不启动缺席的 Host，未能核验实例锁仍报错。Vite 热更新不更新后台程序。

准备阶段和桌面均使用 `src-tauri` 工作目录，相对 `SWB_PROFILE` 从此解析。target、release、target-dir、profile 和 config 参数同步给准备构建；命令行自定义 runner 被拒绝。Cargo env 注入、配置内 runner 或自定义 cwd 组合尚未验证。IDE 的 Windows Job 禁止独立启动时，可在允许独立运行的终端启动 Host，再连接同一绝对 profile。

## Host、CLI 与 MCP

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
```

默认程序在 `src-tauri/target/debug/`，Windows 带 `.exe`；Host、CLI 和 MCP 放在同一输出目录。CLI/MCP 首次连接可启动相邻 Host，普通客户端默认只有元数据权限。

以下示例在正式程序目录已加入 PATH 后执行，参数文件采用当前 [Core 类型](../crates/core/src/)：

```sh
serial-workbench-cli --profile <绝对目录> catalog --json
serial-workbench-cli --profile <绝对目录> context --out request-context.json --json
serial-workbench-cli --profile <绝对目录> invoke <actionId> --target-json target.json --params-json params.json --request-id <uuid> --request-context-json request-context.json --json
```

`context --out` 新建 UTF-8 AttachResult，不覆盖原文件。重试保持相同上下文、requestId 和参数，异参返回 `REQUEST_CONFLICT`；Host 重启后不重发旧 invoke，按原上下文查询持久结果：

```sh
serial-workbench-cli --profile <绝对目录> operation get --request-id <原uuid> --request-context-json request-context.json --json
```

正常调用返回接纳 Operation，使用 `operation get <operationId>` 查询终态；`operation cancel` 请求合作取消，退出客户端保留任务。`host stop` 的接纳和实际停止分别确认。目录定义 query/invoke、目标和参数 schema，CAS 写入通过 `--expected-revision`；完整参数与退出码以 [args.rs](../crates/cli/src/args.rs) 和 `--help` 为准。

CLI 的 `query`、`invoke` 和 MCP 的 `tools/list` 使用当前身份可见的实际目录。目录变化后重新发现入口，已接纳的业务按原回执查询。 [插件 SDK](../packages/plugin-sdk/README.md)

`authorize`/`revoke` 是明确的本地用户控制入口。文件业务先经 `file.register` 登记再使用 ObjectRef，普通请求不自动读取用户控制凭据。MCP 使用 `serial-workbench-mcp --profile <绝对目录>`，stdout 仅承载官方 SDK 协议，工具来自同一目录和权限；取消工具等待不代替 `operation.cancel`。

需要在同一 Host 上区分多个 MCP 客户端时，为各自的 MCP 配置追加 `--client-id <名称>`。名称用字母、数字及 `._:-`，作为该客户端的授权身份和工作台「活动」中的选择项。已有未命名的配置沿用 `serial-workbench-mcp`。新增名称首次连接按新身份注册，由本地用户按实际目标授权。

Host/CLI/MCP 按 `--profile`、`SWB_PROFILE`、平台默认目录选择配置。相对路径绑定启动 cwd，变量和 `~` 保持原样。Windows 盘符相对或根相对路径会被拒绝。日志写 stderr，CLI JSON 和 MCP 协议写 stdout。`SWB_LOG_LEVEL` 的可用级别及默认值由[启动配置](../crates/ipc/src/startup_config.rs)维护，`startup.config.get` 可查看脱敏来源。

### 局域网共享

在两台桌面的「局域网共享」设置交换并核对配对信息。持口端 B 连接串口，选择对端的查看或操作权限，并在对端可达的地址开启监听。使用端 A 从工作台打开「局域网连接」，粘贴 B 开启监听后复制的信息，再选择共享串口。设置和工作区仍保存在 A。停止监听保留配对，解除配对收回对端身份。

CLI 管理用同一 profile 的本机用户控制身份。`lan status` 查看身份与共享，`lan --params-json <文件>` 提交 `setShares` 或 `unpair`。`lan enable <ip:port>` 启用监听，IPv6 地址加方括号。`lan disable` 停止监听，Host 重启后须显式启用。 [LAN DTO](../crates/core/src/lan.rs)

在 A 用 `authorize` 为已注册的 CLI 或命名 MCP 客户端授予 `lan.connect`。授权目标的 `hostId` 用 A 的 Host ID，`kind` 为 `swb:lan-peer`，`id` 用 B 的 Host ID。CLI 的查询、操作与回执命令和 MCP 启动参数都可加 `--lan-peer <B Host ID> --lan-address <B IP:端口>`，`--profile` 继续使用 A 的本机配置。业务目标使用 B 命名空间，CLI 调用需用同一路由保存的上下文。配对、授权与停止 Host 仍在所属机器执行。可复现流程见 [LAN 进程验收](../e2e/lan-route.mjs)。

### 浏览器访问

桌面在「设置」中打开「浏览器访问」，选择仅查看或查看与操作，生成配对码，再用「在浏览器打开」进入本机工作台。停用浏览器访问会收回配对权限，桌面串口会话继续运行。浏览器依赖与桌面同一次构建的工作台资源，安装版与 Windows 便携版放在 `browser-workbench/`。开发模式连接真实 Host 前可用 `pnpm build` 准备 `dist/`。

### 本机 HTTP 控制

本机调用方启动受信任的 Host 程序时可显式开启 HTTP。下面的 Node 示例使用独立 profile，`hostExe` 和 `profile` 均使用绝对路径。启动器读取管道后直接将本轮凭据放入请求头。

```js
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const host = spawn(hostExe, ["--profile", profile, "--http-control-stdio"], {
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true,
});
async function readEntry(pipe) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of pipe) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) continue;
    const length = bytes.readUInt32BE();
    if (length < 1 || length > 2048) throw new Error("Invalid Host handoff");
    if (bytes.length >= 4 + length) {
      return JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
    }
  }
  throw new Error("Host exited before HTTP handoff");
}
const { url, clientId, credential } = await readEntry(host.stdout);
const response = await fetch(url, {
  method: "POST",
  redirect: "error",
  headers: {
    authorization: `Bearer ${credential}`,
    connection: "close",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    requestId: randomUUID(),
    request: {
      method: "host.attach",
      params: {
        supportedProtocolVersions: ["0.1"],
        clientKind: "cli",
        clientId,
      },
    },
  }),
});
const attach = await response.json();
if (!attach.ok) throw new Error(attach.error.code);
```

使用附着回执构建 `catalog.list` 的 Query，并按该身份的目录选择后续动作。授权参数文件用交付中的 `clientId`、所需权限和实际目标，撤权参数文件用附着结果的 `actorId`、对应权限和目标。 [RPC 信封](./contracts/host-v0.md#附着版本与目录) · [授权 DTO](../crates/core/src/auth.rs) · [本机 HTTP 控制验收](./acceptance.md#本机-http-控制)

```sh
serial-workbench-cli --profile <绝对目录> authorize --params-json grants.json
serial-workbench-cli --profile <绝对目录> revoke --params-json revocations.json
serial-workbench-cli --profile <绝对目录> host stop
```

## 工作区操作

编辑器可以从当前布局或空白工作区开始；选择视图只切换配置表单。保存提交视图、设备绑定与连接预设；另存为不复制发送草稿或运行连接。删除保留原件，默认工作区不可删除。加载配置不打开端口，关闭标签也不等于断开设备。

标签的设备框跟随运行来源或保存的绑定。Host 重启后仅在同一 Host、同类传输下唯一匹配时恢复预选；歧义或未匹配需要手动选择。草稿按 Host、工作区和视图隔离，断连、切换和重命名不能串用正文。

## 接收与发送

- 接收显示的条数和字节数预算按窗口偏好应用于各串口，调小会裁剪实时缓存和暂停快照。上滚只停止自动跟随，暂停才固定快照；要保留完整历史请使用录制。
- 收发编码独立，HEX 不改变原字节。自动识别只使用连续 RX 前缀，证据不足可手选编码。发送以所选编码计算正文与行尾的最终字节，不可表示时报错并保留草稿。超过生成的 `TX_MAX_BYTES` 使用文件发送，不将单次手动发送拆成可穿插的动作。
- 发送栏的混合输入接受两位 HEX、双引号文本及字节转义，例如 `41 42 "AB" \r\n`。引号内的普通字符按发送编码转换。编辑器实时预览正文并定位无效片段。确认后正文写入当前视图的 HEX 草稿，行尾和校验沿用发送栏预览，使用发送操作时才提交 Host。
- 接收编码菜单显示样本字节数、建议编码及其依据。统计候选附字节分布得分。选择候选会以同一批原始字节重绘，之后可恢复自动识别或保存到当前工作区视图。
- 切换到 HEX 视图后，在显示选项调整每行字节数、1/2/4/8 字节分组和大小写。地址栏和 ASCII 栏使用固定行宽，首次启用时默认每行 16 字节。ASCII 不可打印字节显示为点号。关闭显示选项时按来源和字节位置恢复原选区。
- 打开「搜索字节」可选择 RX、TX 或收发双向。文字可以按正则搜索，HEX 按原字节查找。选择「仅显示匹配」或「隐藏匹配」筛选当前快照中的完整记录。达到搜索上限或解码不完整时，界面提示且保留匹配筛选前的记录。关闭搜索返回全部方向，恢复跟随后获取持续接收的数据。
- 在 HEX 或并排视图选择同一流的连续字节，再打开「复制字节选区」。支持文本、HEX、带时间戳文本、C 数组、Python bytes 和 Base64。文本可选择解码，带时间戳的格式还可切换来源或接收时间。每行输出时间、RX/TX、原始字节偏移及 JSON 字符串正文。每次最多复制 64 KiB。
- 在 HEX 或 ASCII 栏选中同一流中的连续 1 至 8 字节，再打开工具栏的「解释数值」。面板显示源偏移、当前位宽使用的原字节、字节序、有符号和无符号十进制，以及 HEX、BIN、OCT。32 位和 64 位也显示对应浮点值。
- 在终端的显示选项打开 ANSI 终端查看光标、颜色和屏幕序列。可选择收到 LF 时回到首列。选择文本、HEX 或搜索可回到原始记录。视图从最近连续 RX 段重建，缺口和来源变化会重置终端状态。
- 无回显设备可在启用键盘发送后开启「本地键入回显」。在独立区域查看最近的本机输入，通过「活动」确认发送结果。关闭回显或键盘发送会清除该处文本。
- 开启「发送键盘输入」后，在 ANSI 终端粘贴文本并确认字节数即可发送。剪贴板换行按终端惯例转为 CR，正文使用当前发送编码。设备启用括号粘贴时，可在本次确认中关闭。Host 按线路速率与分片间隔发送，编码后的上限为 128 KiB。操作终态和分片回执可在「活动」查看。
- 设备启用 xterm 鼠标追踪后，可在 ANSI 终端单独开启「发送鼠标报告」。终端已聚焦时报告才会发送。按 Shift（macOS 按 Option）可使用本地选区。鼠标追踪期间可从「终端链接」打开 OSC 8 链接。链接列表支持键盘和中键，浏览器在新标签页打开。
- 展开「ANSI 历史」查看当前视口行号、保留行数和早期行淘汰状态，可跳到首行、最新行或指定的保留行。回滚上限为 0 到 50,000 行，默认 3,000，按窗口偏好保存。调整后从当前保留的连续 RX 重建。冻结只固定显示，接收和录制继续运行。盘上录制从录制列表打开。
- 展开「搜索 ANSI 屏幕」检索当前活动屏幕和可用回滚历史，可按正则和大小写查找，前后跳转并高亮当前匹配。屏幕改写、模式切换或折行变化会撤销旧结果。频繁收到数据时可冻结显示后搜索。「搜索字节」检索原始数据，仍能查到已被屏幕覆盖的文本或控制序列。
- 「导出 ANSI 彩色屏幕」保存当前可见行的文本和显示颜色。文件为带 SGR 样式的 UTF-8 文本，可用支持真彩色的终端查看。录制及原始字节导出仍用于核对设备发来的控制序列。
- 「终端字体」的等宽字体、字号、行高和编程连字同时用于 ANSI、文本及 HEX 视图。ANSI 连字由所选字体塑形，鼠标仍可单独选择其中的字符。
- 对端约定接收 CSI 行列时，在可写会话中开启「发送键盘输入」和「发送 CSI 窗口尺寸」。开启后先发送当前行列，后续在本地窗口尺寸稳定时上报。快速缩放只保留最新待发尺寸。冻结或重新连接后需重新启用。 [xterm 控制序列](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
- 对端提供 POSIX shell 时，在可写 ANSI 会话中开启键盘输入并展开「POSIX shell 终端设置」。选择颜色兼容级别，按需调整 TERM 和行列。尺寸留空时读取当前屏幕，真彩色将 `COLORTERM` 设为 `truecolor`，其他级别由 `TERM` 告知对端。把设置命令插入空提示符，核对后在终端按 Enter，使随后启动的程序继承变量。 [terminfo 能力](https://invisible-island.net/ncurses/man/terminfo.5.html)
- 启用「发送键盘输入」后，焦点内的方向键、功能键和控制键按终端模式发送。已启用的应用快捷键优先处理，按 Shift+Tab 移出终端焦点。需要发送粘贴文本或输入法组合文本时，可使用发送编辑区预览。活动页保留实际发送回执。
- 终端的显示选项可以关闭接收文本自动折行或隐藏发送回显的正文。发送回显标为 TX，隐藏正文时仍可打开发送回执。设备发回相同字节时，仍显示对应的 RX 记录。选项作用于当前打开的终端视图，记录边界、搜索位置和录制字节保持原样。
- 控制线与回执针对选中的设备；配置回执、写入接受范围、drain 和物理线状态不能互相替代，见[系统串口与 PTY 能力](./architecture.md#系统串口与-pty-能力)。

## 契约与功能接线

Rust 包、共享 profile 和默认成员读取根 [Cargo.toml](../Cargo.toml)，共用 Cargo.lock 与 [.cargo/config.toml](../.cargo/config.toml) 的 target。仅无头包检查不需要前端，桌面检查先准备 `dist/`。

1. 对照[需求](./requirements.md)确定目标行为、失败和验收；页面放 `src/pages/`，有独立业务规则时建立 `src/features/<domain>/`。
2. `src/routes.tsx` 注册路由、布局、懒加载与导航；共用操作进入 `src/commands/`，同步深链和窗口路由白名单。
3. 局部草稿由组件拥有，偏好复用 Provider/同步器；未保存工作登记 `useUnsavedWork`，文案补齐中英词典。
4. 业务能力进入 Host 服务与目录，系统交互进入 Native 服务；命令处理边界适配，手写前端经 `src/lib/tauri.ts`。
5. Host wire DTO 改变后依次运行 `pnpm contracts:generate`、`pnpm contracts:check`，提交 `packages/contracts/src/generated/`。Rust 同源导出类型、draft-07 schema、目录、默认值及正负 fixture，客户端校验未知输入。生成器在单一 Ajv root 中复用完全相同的定义以缩减浏览器代码，冲突及依赖保留原命名空间；出现独立 URI/anchor 时回退原编译方式。此优化不改变导出的 Rust schema 或校验规则。
6. Native 命令/DTO 在 `src-tauri/src/bindings.rs` 注册，依次运行 `pnpm bindings:generate`、`pnpm bindings:check`，提交 `src/lib/generated/`。生成任务和共用 target 的 Cargo 检查顺序执行。
7. 按[测试范围](./testing.md#日常验证范围)验证规则及真实入口接线；删除功能同步清理所属源码、依赖、权限、专属测试和文档。

## 身份、资源与依赖

[app.config.json](../app.config.json) 管理名称、标识符、深链、浏览器存储空间和更新信任，`pnpm config:sync --config <配置补丁.json> --dry-run` 预览，去掉 dry-run 同步，再 `pnpm config:check`。身份变化可能改变数据位置，脚本保留原用户数据，已分发身份迁移另行设计。

同步器在 identifier 或 repositoryUrl 改变时清空原更新端点和公钥，只改变更新端点时也会清空公钥；同一产品迁移需要保留信任时，在补丁中显式提供匹配的端点和公钥，见 [init-lib.mjs](../scripts/init-lib.mjs)。配置同步不迁移磁盘数据。

[repository.config.json](../repository.config.json) 管理仓库、分支、市场和链接模板，修改后运行 `pnpm repository:sync` / `pnpm repository:check`，提交生成同步结果。同步更新受管链接与模板，不配置远端权限、Secrets、签名门户或域名；平台 API 在 `scripts/hosting/` 适配。

`repository.generated.json` 保存上次同步的公开配置，用于识别旧链接，和配置一起提交。修改链接优先改模板；更换托管平台须实现发布适配器，再设置 provider，子模块 gitUrl 不承担插件下载或信任配置。

品牌源在 `resources/branding/`，修改 SVG 后执行 `pnpm branding:generate` / `pnpm branding:check`，提交 icons 和安装器生成结果。安装器保留原生文字区、高 DPI 缩放和本地修复；升级 Tauri 时审查 NSIS/WiX 模板差异。皮肤和内置图片分别按 [skins](../resources/skins/README.md)、[wallpapers](../resources/wallpapers/README.md) 维护。

新增共享外观字段从 `crates/core` 的设置 DTO/默认值和生成结果开始，再接前端归一化、`applySettings`、语义 token 及设置控件；客户端窗口偏好走 ClientState。设置搜索控件 ID 与索引同步维护。

新依赖评估用途、替代方案、许可、平台、包体与安装脚本，提交最小清单/锁差异。锁冲突先合并清单，再用规定工具链基于已有锁重新解析；避免删除锁文件整体升级。

ReactDOM 的[本地补丁](../patches/react-dom@19.3.1.patch)仅跳过 textarea 未变默认值的重复写入。升级时用 `pnpm patch` / `patch-commit` 维护精确版本与锁摘要；核对输入、表单 reset、受控值更新、[输入性能](./testing.md#前端与脚本)及冻结安装，不改 `node_modules`。

## 构建与发布

当前发布/Pages 模板停用，签名和更新配置待启用。手动 CI 见[测试指南](./testing.md#持续集成)，安装包和实机验证见[安装与发行验收](./acceptance.md#安装与发行验收)。

```sh
pnpm version:check
pnpm app:build
```

普通本机构建不改版本号。Windows 如只需 NSIS 安装包，改用 `pnpm app:build --bundles nsis`；需要便携包时用 `pnpm app:portable`。
macOS 的 DMG 验收构建用 `pnpm app:build --bundles app,dmg`，保留 `.app` 供安装组件收据核对。

仅在准备新版本时运行 `pnpm version:set <新版本号>` 并复核差异。版本脚本同步 npm/workspace、Tauri、Cargo 共享版本与锁文件。MSI/NSIS 的版本范围及预发布限制由 [version.mjs](../scripts/version.mjs) 校验，不能仅靠选择其他 bundle 绕过配置约束；已发布版本号不复用。

构建收集同源桌面、Host、CLI、MCP 和组件清单；`--optimize size|speed` 均为 release，默认 size。固定 Node 由构建机验签并准备，需 `gpgv` 和系统 `tar`，Linux 另需 `dpkg-deb`。离线缓存、许可和跨目标准备见 [runtime 输入](../resources/runtime/README.md)。

交付从 `artifacts/<version>/<target-triple>/installers/` 或 `portable/` 取文件，manifest 记录版本、target 和文件 SHA-256。同一版本/target 的该类产物整体替换，保留其他版本和另一类，失败恢复旧 bundle。Windows 产出 NSIS/MSI，macOS app/DMG，Linux 格式由 Tauri bundle.targets 决定。

Windows portable 包含程序、组件和许可证，需要 WebView2，数据写当前用户目录；应用内更新会转为安装版。`--skip-build` 核对构建收据、配置和组件哈希，源码变化需重新构建，复用 speed 时同时指定策略。macOS 和 Linux 分别使用 app/DMG 与 AppImage/系统包。

### 签名与更新

代码签名验证系统发布者，更新签名验证包和版本。**先确定最终交付字节，再生成更新签名与清单。**

- Windows 可选 SignPath 配置当前只覆盖 x64 NSIS 外层，安装后 exe、MSI 和第三方组件须另行处理。启用前确认服务资格、证书主体、审批人和最小 Secret 权限；后签改变字节，现模板拒绝与更新签名同时使用。
- SignPath 的提供方和公开签名策略入口、账号 MFA、人工审批及 `.signpath/artifact-configuration.xml` 随启用一起核对；token 仅限提交签名请求。PFX 和 SignPath 二选一，硬件或其他托管签名尚未接线，需实现工具与 signCommand。
- PFX 使用 `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`；macOS 的证书、身份与公证 Secrets 读取 [release 模板](../.github/workflows-disabled/release.yml)。正式 macOS 分发完成 Developer ID 签名、公证与 stapling；Linux 当前提供哈希，未配置独立包签名。凭据通过受控渠道提供。
- 更新在 app.config 配置匹配端点、公钥，发布端配置 `TAURI_SIGNING_PRIVATE_KEY`，加密私钥另设 password Secret。公钥固定在安装包内，deployment 仅可覆盖 HTTPS 镜像或以空端点禁用，不能替换公钥。
- 启用后发布模板核验四目标、最终资产、签名版本和唯一 latest.json。无公钥的旧客户端需手动安装可信版本，换钥使用过渡版本或手动安装。
- Windows 当前用户版 NSIS 在隔离目录测量最终安装包的输出，用发布密钥绑定套件摘要和版本，再重新暂存核对。草稿的 Windows 更新签名资产与 `latest.json` 使用这次复验的同一份签名。
- 发布准备保留正式源、tag、构建环境、许可、组件收据、签名及最终哈希；验收升级时采用两个不同版本，覆盖发现、下载、验签、未保存协商、安装和重启。

### 交付检查

1. 确认可交付候选、需求范围和有效里程碑 CI，在 PR 准备用户可见摘要及升级限制。
2. 在确认的 main 提交打 `v<version>` 标签，同源构建四目标；恢复模板前核对 Actions SHA、参数、平台和 Secrets。
3. 验证最终哈希、发布者、许可、安装/卸载、协议关联、自启动、更新及失败恢复。Windows MSI 按机器卸载不保证清除原账户 HKCU，自启动应先在原账户关闭。
4. 核对 draft 资产与更新清单后再执行公开发布；观察安装/更新失败及错误报告。撤回错误清单或资产时保留证据，用更高修复版本恢复；不覆盖旧版本号或假定较旧程序可读取较新数据。

恢复 release 模板后，v* tag 或手动触发会构建并在必要 job 全部成功后自动公开同一 Release，发布授权与适用验收须在触发前完成。失败、取消或意外跳过保留 draft；需要源码修正时使用新版本/tag，已公开资产不靠重跑替换。

发布说明从 tag 源提交对应的已合入 PR 读取“变更内容”和“影响范围”，也支持显式的“变更摘要”和“升级与限制”；这些标题是工具契约。版本 PR 覆盖上一公开正式版以来的全部变化，可用 `pnpm release:notes` 只读预览（需完整 Git 历史及 gh 认证）。更新清单生成后再编辑 Release 正文不会自动同步其中的说明。

## 排障与清理

先记录应用/源码版本、系统、稳定错误 code 和触发步骤，再检查实际进程及日志。诊断区可复制脱敏报告；文件日志由 Tauri 路径 API 定位，见 [diagnostics.rs](../src-tauri/src/diagnostics.rs)，反馈前复核私有内容。

| 现象                                                | 检查                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 窗口不出现/白屏                                     | 已有实例、托盘/显示器、WebView、终端和原生日志、资源路径/CSP；真实窗口按[桌面边界](./testing.md#桌面边界)安排                                                                                       |
| `HOST_START_FAILED`                                 | 正式相邻 Host、相同 profile、程序源身份及 Windows Job 限制                                                                                                                                          |
| Host 失效后重试失败                                 | 检查是否已显式重新附着到新 epoch，保留本地草稿，不重复发送旧动作                                                                                                                                    |
| command not found / permission denied               | 当前二进制、命令注册、生成绑定、capability、窗口身份及目标授权                                                                                                                                      |
| 串口无法连接                                        | 使用工作台平台引导，核对实际设备、驱动、权限和原始错误；拒绝访问不能据此猜测占用进程                                                                                                                |
| 1420 端口冲突                                       | 确认进程归属；改端口同步 Vite、Tauri devUrl 和编辑器调试配置                                                                                                                                        |
| Rust 长时间无输出                                   | CPU/磁盘、实际编译/链接进程与日志；保留缓存，顺序执行共享 target 的任务                                                                                                                             |
| `Blocking waiting for file lock on build directory` | 另一 Cargo 正在使用同一 target；先核对任务归属并等待或停止自己的检查。显式 `--target` 仍共享根构建目录锁；无头检查可用独立 `--target-dir .cache/local-acceptance-target`，真实桌面验收优先放独立 CI |
| Windows 无法覆盖 `serial-workbench-host.exe`        | 后台 Host 仍在运行；先核对该 profile 的在途工作，再用已构建 CLI 的 `--profile <实际绝对目录> host stop --json` 正常停止并等待 `stopped: true`，随后重试构建                                         |
| EPERM / 归档失败                                    | 确认占用来自本轮程序或扫描，停止自己的相关进程再重试；保留失败证据                                                                                                                                  |
| 图标或安装器仍旧                                    | 核对源 SVG、生成资源、实际 exe/快捷方式和系统图标缓存，重新构建                                                                                                                                     |
| 保存/恢复失败                                       | 区分 Host CAS 与 ClientState，重读冲突，损坏/未来格式保留原件，不编辑版本号强行覆盖                                                                                                                 |

清理先预览 `pnpm clean:temporary --dry-run`。temporary 清理临时报告、前端输出、默认 Rust 缓存和旧便携备份，保留正式版本归档与依赖；outputs 清理生成内容并保留识别出的 Cargo 缓存；artifacts 清整个分发目录；clean 默认还清默认 Rust 输出；all 再删除根依赖。精确路径见 [clean-lib.mjs](../scripts/clean-lib.mjs)，自定义 target 自行管理，重装依赖使用冻结锁文件。

带 `-Force` 的检查与删除、修改、服务启停分开调用。遇到 blocked by policy，检查是否混用操作并核验实际结果，记录仍失败的命令和错误。
