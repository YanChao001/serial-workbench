# M1 软件场景验证

本入口验证 T01、T03、T04、T05、T06、T08 的软件场景。它需要已构建的 Rust 场景 harness；harness 使用正式 Rust 客户端、CLI 和官方 MCP SDK，创建并回收自己的进程。[harness](../crates/host/examples/software_scenarios.rs)、Host 指标与录制 / 回放已接入实现；本轮正式六场景及 T06 实际 600 秒验证待执行，结果以包装器校验后的证据为准。

## 运行与证据

先从仓库根目录依次构建同一目标的 Host、CLI、MCP 与独立 harness：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo build --locked -p serial-workbench-host --example software_scenarios
```

默认 harness 位于 `src-tauri/target/debug/examples/software_scenarios`，Windows 加 `.exe`；三个入口位于同级 `debug/`。自定义 target 或 profile 时使用对应输出。harness 默认从自身目录上一层查找三程序，也可用 `SWB_TEST_HOST_BIN`、`SWB_TEST_CLI_BIN`、`SWB_TEST_MCP_BIN` 显式指定同次构建的程序绝对路径。

在独立测试环境从仓库根目录运行，`--output` 指向尚不存在的目录：

```sh
node scripts/test-host-scenarios.mjs --harness <已构建harness路径> --output <尚不存在的证据目录>
```

默认并且只接受 600 秒的 T06 运行时长；`--duration-seconds 600` 可显式指定。目录由入口创建，保存 `harness.log`、`result.json`、逐场景证据及采样文件，成功验证后还写入核算吞吐的 `summary.json`。入口为 harness 创建独立临时 profile；只有 harness 正常退出、提供其自有进程均已退出的记录且所有证据验证通过后才删除该 profile。失败时保留 profile 和证据，输出其路径。POSIX 入口以独立进程组启动 harness：中断、超时或主进程退出后组仍存在时，仅向该持有组请求停止，等待 5 秒后升级强制停止，再等待最多 5 秒确认主进程退出和进程组消失。Windows 对直接持有的 harness 发信号，由 harness 的 kill-on-close Job 收容其子进程。无法确认停止时如实报错并保留现场，harness 仍负责等待并记录其自身子进程。

入口拒绝缺失 harness、非零退出、未满 600 秒的实际单调时长、缺少进程清理记录、场景断言或指标，以及内容不一致的证据。在 PR 或里程碑记录实际提交、目标、平台、命令、证据目录和结果。三客户端中的桌面侧由 Rust 客户端模拟，真实窗口关闭和系统安装由独立桌面验证覆盖。

## Harness 输出契约

Harness 接收 `--profile <临时目录> --duration-seconds 600 --result <result.json> --log-dir <证据目录>`。它须自行等待并记录拥有的 Host 和客户端进程退出，并在 JSON 中提供：

- `version`、`target`、`platform`、`protocol`（当前 `0.1`）、`startedAt` 和 `endedAt`（可解析时间）。
- `cases`：恰好各一个 T01、T03、T04、T05、T06、T08。每项包含 `status: "passed"`、非空 `source`、相对证据文件路径数组 `evidence`，以及 `assertions` 数组。每个断言包含 `name`、`passed: true` 和观察值 `actual`；每个场景的断言名如下，缺失或失败即拒绝：
  - T01：`three_clients_same_session`、`rx_tx_hash`、`partial_unknown_no_replay`。
  - T03：`client_detach_continues`、`shutdown_settled`、`restart_epoch_no_replay`。
  - T04：`capabilities`、`partial_configuration`、`break_cleanup_isolation`。
  - T05：`disk_failure_evidence`、`rotation_recovery`、`crash_prefix`。
  - T06：`slow_reader_isolated`、`control_responsive`、`loss_accounted`。
  - T08：`capture_after_detach`、`finalize_verified`、`replay_readonly_seek`。
- `cleanup`：`complete: true` 与非空 `ownedProcesses` 数组；每项为有效 `pid` 和 `exited: true`。此记录由 harness 在等待它拥有的进程后产生。
- `telemetry`：`durationSeconds`、单调计时的 `elapsedSeconds`、`sampleCount`、证据目录内的 `samples` JSON 文件、`sources`（非空 `rss`、`queues`、`controlLatency` 来源描述）、`processTreeRssBytesPeak`、`sourceQueueBytesPeak`、`readerQueueBytesPeak`、`captureQueueBytesPeak`、`bytesProduced`、`bytesObserved`、以及 `controlLatencyMs` 的 `p50`、`p95`、`p99`。

采样文件是 JSON 数组，建议每秒一条；每条含 `elapsedSeconds`、`processTreeRssBytes`、`sourceQueueBytes`、`readerQueueBytes`、`captureQueueBytes`、`controlLatencyMs` 和累计 `bytesObserved`。采样须覆盖 600 秒、时间严格递增、字节数不回退、相邻间隔不大于 3 秒；测量时长与末次采样时间的差值不得超过 1 秒，测量时长不得超过包装器的实际单调运行时长加 1 秒调度余量。吞吐使用末次累计字节和该采样时间计算。入口按样本最大值核对 RSS，以 nearest-rank 计算并核对延迟分位数，队列峰值不得小于观测样本，末次观测字节数须与汇总一致。RSS 来源须是实际被测进程树，队列来源须是 Host 指标，控制延迟使用客户端单调时钟；不得用 Node 包装器的 RSS 代替。证据路径必须指向证据目录内的现有普通文件。

T01/T03/T04/T05/T08 的断言应记录原始字节或哈希、状态和操作回执；T05 使用受控注入来验证满盘类写入错误，只有独立满文件系统测试才能报告真实 OS 满盘。T06 以单会话 11,520 B/s 作为软件参考负载，报告计数、吞吐、队列、RSS 和延迟分位数。

## 本轮待验收范围

正式六场景 600 秒及四目标 CI 结果待本轮执行后写入 PR。Unix 平台提供器和 PTY 的目标 OS 运行尚待验证；Windows 上被 cfg 排除的 PTY 用例不计为通过。物理适配器的 CTS / XOFF 阻塞、线电平、BREAK 接收、3/6/12 Mbps 实际速率、实际 Codex 客户端交互及 72 小时长稳继续按各阶段验收。真实 GUI、Native 系统效果执行器和桌面发行接线属于后续集成。平台软件用例和硬件检查入口见 [系统串口与 PTY 能力](./serial-platform-capabilities.md#验证分层)。
