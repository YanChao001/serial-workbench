# Node 插件 SDK

工作区私有包，采用 Apache-2.0。`@serial-workbench/plugin-sdk/node` 提供当前 Node 后台的纯类型入口；使用 `import type`，构建后的正式包不需要加载 SDK 运行时代码。公共参数、结果和任务意图复用 [Rust 生成契约](../contracts/src/generated/types.ts)。

后台模块必须导出 `register(context)`，返回可异步执行的清理函数。处理器 ID、目标和权限先在正式 manifest 中声明，worker 文件随签名包提交；安装不会运行代码。下面假定 manifest 声明了相应动作、查询，包内含有 `dist/worker.mjs`。

```ts
import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";

export const register: NodeRegister = (context) => {
  let completedJobs = 0;

  context.queries.register("example.terminal.status", (query) => ({
    targetId: query.target.id,
    completedJobs,
  }));

  context.actions.register("example.terminal.compute", async (call, task) => {
    task.signal.throwIfAborted();
    task.progress.report({ completed: "0", total: "1", unit: "jobs" });
    const worker = context.workers.start("dist/worker.mjs");
    const { exitCode } = await worker.finished;
    if (exitCode !== 0) throw new Error("Worker did not finish the job");
    completedJobs += 1;
    task.progress.report({ completed: "1", total: "1", unit: "jobs" });
    return { targetId: call.target.id, completedJobs };
  });

  return async () => {
    // 等待插件自有资源的实际清理完成。
  };
};
```

worker 入口是包内普通 Node 模块。`finished` 等待实际退出，`terminate()` 无参数并返回同样的 `{ exitCode }`；动作内启动的 worker 随所属任务取消，注册和查询中的 worker 按包管理。`context.onDispose(cleanup)` 可追加清理函数，执行时按登记逆序等待。`actions.register`、`queries.register` 与 `parsers.register` 会同步选择其处理器 ID。`contributions.register` 接收完整生成的 `NodeContributionSelection`，其余贡献可在对应数组中选择。

协议解析器在签名清单的 `contributes.parsers` 中声明为会话动作，并通过 `context.parsers.register(id, handler)` 注册。处理器沿用 `NodeActionHandler` 与 `task.streams`，客户端从常规目录选择它，并按 Operation 和来源会话读取派生页。 [协议解析器契约](../../docs/contracts/node-extension-v0.md#协议解析器)

动作可通过当前任务提交子动作，SDK 持有递增子键并处理接纳回执；不要自行构造根请求或更换未知结果的身份。例如，已声明并获授权的处理器可调用另一个包的动作：

```ts
context.actions.register("example.terminal.forward", async (call, task) => {
  const child = await task.actions.invokeChild({
    actionId: "example.graph.compute",
    target: call.target,
    params: call.params,
  });
  const current = await task.operations.get({ operationId: child.operationId });
  return { childOperationId: child.operationId, state: current.state };
});
```

`invokeChild` 返回接纳状态，`operations.get` 返回当前 Operation，结果保留生成契约的 `kind/value` 结构。处理器返回后关闭新接纳，Host 等待已接纳子项结算。进度报告计数为十进制字符串，按实际完成工作递增；报告合并为最新快照。查询处理器只接收 `Query`，没有任务第二参数。

签名动作可以在 `outputSchema` 声明 `type: "string"`、`contentEncoding: "base64"` 和 `x-swb-file-result`。支持的媒体类型为 `image/svg+xml`、`image/png`、`text/csv` 及 `application/x-asam-mdf`。PNG 和 MDF4 需带对应格式的文件标识，CSV 采用 UTF-8，这三种格式解码后最多 64 KiB。处理器返回 Base64，Host 验证并将解码后的字节保存为结果文件。客户端通过终态的 `resultRef` 和 `file.read` 获取同一份内容，读取仍需要来源权限。图表参考包的 `swb.reference.chart.exportSvg`、`swb.reference.chart.exportPng` 和 `swb.reference.chart.exportCsv` 均可在无窗口环境运行。

动作处理器通过 `task.streams.read(params)` 分页读取 Host 留存的原始事件。参数和返回值分别沿用生成的 `StreamReadParams` 与 `StreamReadResult`。插件需声明会话上的 `content.read`，Host 同时校验当前调用者授权以及父任务的会话和代次范围。

```ts
const { sessionId, sessionEpoch } = call.target;
if (sessionId === undefined || sessionEpoch === undefined)
  throw new Error("This action requires a session");
const page = await task.streams.read({
  sessionId,
  sessionEpoch,
  startEventSeq: "1",
  maxEvents: "32",
  maxBytes: "262144",
});
```

后续页从 `page.nextEventSeq` 开始。`CURSOR_EXPIRED` 返回最早可读游标，解析状态须在缺口处重置。最多同时等待四个 Raw 请求，额度用完返回 `HOST_BUSY`。任务取消后停止等待，实际读取工作和页内存随 Host 结算释放。

后台动作也可以等待 `task.streams.followSession(params, hooks)`。参数沿用 `StreamReadParams`，同一任务一次只能跟随一个精确会话代次，占用四个 Raw 名额中的一个。SDK 按事件序号逐一等待回调。`onConnect` 只在所读历史中遇到实际打开边界时调用。`onReceive` 接收 RX 事件，`onSend` 接收带已接纳及不确定范围的 TX 结算。来源终态会在最后一批事件之后送达 `onDisconnect`。`onError` 接收来源缺口、留存游标过期、已丢失的 TX 结算证据或后端断连错误。解析器须在缺口时重置，留存过期则在回调完成后从 Host 安全游标接续。任务取消、权限失效或回调异常会停止跟随和释放读取器。跟随只观察事件。

从原始数据生成的值可用 `task.streams.publishDerived({ sources, quality, unit, value })` 发布。`sources` 记录同一会话代次的实际事件区间，可附方向和字节区间。Host 核对区间并填入本次执行的处理器版本和配置摘要。发布最多四个在途请求，独立于 Raw 读取。回执的 `operationId` 和 `position` 可用于定位已留存样本。客户端通过 `stream.derivedRead` 按自己的游标接续，仍需来源会话的 `content.read`。

包内 Web UI 可以从 `@serial-workbench/plugin-sdk/web` 调用 `connectReadOnlyView({ onSession, onBatch, onLocale, onError })`。壳交付本次打开操作所绑定的会话快照，以及带生成类型的 `RawBatch`。SDK 在 `onBatch` 完成后确认批次。页面卸载时释放消息端口，也可用返回值的 `close()` 主动释放。返回值提供当前 `locale` 和打开时的 `dark`。可选的 `onLocale` 接收 `en` 或 `zh-CN`，用于重绘已打开视图的标签。旧壳或省略回调时，`locale` 使用打开时的值。语言变化与批次确认独立，设备数据应使用文本节点或相应的安全绘制接口。

声明 `feed: "derived"` 的视图使用 `connectDerivedView({ onSession, onPage, onLocale, onError })`。`onPage` 收到打开动作所发布的留存样本，第二个参数在游标跨越缺口时提供 `previousPosition` 和 `skippedThrough`。SDK 在回调完成后确认读页，订阅语言的方式与 Raw 视图相同。生命周期、授权和预算见 [Node 扩展合同](../../docs/contracts/node-extension-v0.md)。

连接扩展在 manifest 的 `contributes.transports` 声明设备目标及权限。后台使用 `context.transports.register(actionId, open)` 登记，`open({ params, signal })` 返回实际连接。Host 为连接管理会话代次、收发及 Raw 游标。处理器按 `maxBytes` 与 `waitMs` 拉取输入，空数组表示本次等待没有数据，`null` 表示输入结束。写入返回已确认接纳的连续前缀字节数。关闭函数应可重复调用，并等待底层资源实际关闭。[TCP 参考包](./examples/reference-transport/)通过调用方提供的端口连接本机 IPv4 回环对端。

连接可通过可选的 `lineControls` 声明确实支持的 DTR 和 RTS。 `lineControls.set({ line, value, waitMs, signal })` 在对端应答后返回确认的实际布尔值。能证明命令尚未提交时返回 `not_applied`。提交后失去应答时抛出错误，由插件确保旧连接的控制应答无法归给下一条命令。Host 继续管理控制权限、会话代次、读写与关闭。 [RFC 2217 参考包](./examples/reference-rfc2217/)

消息提供方实现 `TransportMessageConnection.readMessage`。新版 Host 按完整消息接收 `{ bytes, messageType }`，类型可取 `binary`、`text` 或 `datagram`。`maxBytes` 是单消息硬上限，文本使用有效 UTF-8。返回 `undefined` 表示等待内没有消息，`null` 表示输入结束。零字节消息仍返回对象。消息超过上限时抛出错误。

消息连接的 Raw 事件保留 Host 分配的消息标识、总长度、偏移和类型。写入一次提交一个完整消息。返回输入长度表示全部接纳，返回零表示未接纳，入口无法确认时抛出错误。取消与关闭沿用同一资源清理约定。

[首方 UDP 传输](./examples/reference-udp/)用同一消息接口实现 IPv4、IPv6 单播和组播以及 IPv4 广播。示例展示按地址族绑定、限制接收队列、交付空数据报和等待套接字释放。 [UDP 专项验收](../../docs/acceptance.md#udpnet-02)

[首方 WebSocket 传输](./examples/reference-websocket/)实现设备客户端与单对端侦听，交付独立文本和二进制消息。示例使用固定消息预算与有界握手，等待套接字实际关闭。 [WebSocket 设备验收](../../docs/acceptance.md#websocket-设备net-03conn-12)

[串口监听参考包](./examples/reference-terminal/) 提供带精确会话代次的只读视图，显示已连接串口的收发数据。编译、签名与原生管理验证见[终端参考包验收](../../docs/acceptance.md#终端参考包验收)。

[图表参考包](./examples/reference-chart/) 的签名解析器从调用方选定的事件游标读取 LF 或 CRLF 结尾的 ASCII 电压值，要求游标从完整样本边界开始。默认从事件 1 采集 3 个样本。每条记录最多 64 字节，每个任务最多 128 个样本。发布使用实际 RX 事件区间和半开字节范围，带单位 `V`。遇到缺口、超长帧或无效值时停止任务，已发表的样本仍可按生产 Operation 读取。桌面视图绘制成功任务的留存样本。签名与验收见[图表参考包后台采样](../../docs/acceptance.md#图表参考包后台采样)。

[自动化参考包](./examples/reference-automation/) 在精确的会话代次依次发送最多八步。每步等待实际发送回执，再对照相应发送意图之后的 RX 字节。成功结果保留发送子动作和匹配的来源区间。应答不符、超时、来源变化、发送未确认或取消都会停止后续步骤。

可用 `rounds` 将同一序列执行一至八轮，默认一轮。两轮之间由当前任务的 worker 等待三秒，端口事务租约已释放。进度按全程完成的步骤计数。以 `executionMode: "independent"` 接纳后，发起客户端可以离开并重新附着查结果。显式取消会停止当前 worker 及剩余步骤。签名与验收见[自动化参考包后台应答](../../docs/acceptance.md#自动化参考包后台应答)。

[签名主题示例](./examples/reference-theme/)通过 `context.configuration.registerQuery` 登记 manifest 声明的配置查询，再选择主题 ID。资源 JSON 只提供 `accent` 的六位十六进制颜色。选择、保存、深浅配色和缺失时回退由工作台处理。验证签名、真实查询及撤权见[专项验收](../../docs/acceptance.md#签名主题)。

从仓库根运行 `pnpm plugin-sdk:fixture`，检查作者类型和误用约束，编译[验收示例](./examples/native-parity.ts)。它不是可直接安装的包：[原生夹具](../../crates/host/tests/client_parity/node_plugins.rs)将占位 ID 替换为 manifest 中的 ID，选取动作或查询入口导出为 `register`，再签名、安装并经 CLI/MCP 调用。只通过编译不证明权限、重放或结果读取正确；实际运行见[测试指南](../../docs/testing.md#rust-与生成)。
