# M1 软件场景验证

本入口验证 T01、T03、T04、T05、T06、T08 的软件场景。它需要已构建的 Rust 场景 [harness](../crates/host/examples/software_scenarios.rs)；harness 使用正式 Rust 客户端、CLI 和官方 MCP SDK，创建并回收自己的进程。运行结果以实际提交、目标平台和 wrapper 校验后的证据为准。

## 运行与证据

在独立测试环境从仓库根目录依次构建同一目标的 Host、CLI、MCP 与 harness：

```sh
cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp --bins
cargo build --locked -p serial-workbench-host --example software_scenarios
```

默认 harness 位于 `src-tauri/target/debug/examples/software_scenarios`（Windows 加 `.exe`），从上一层 `debug/` 寻找三个正式程序；自定义 target/profile 时使用对应输出。随后运行：

```sh
node scripts/test-host-scenarios.mjs --harness <已构建harness路径> --output <尚不存在的证据目录>
```

默认并且只接受 600 秒的 T06 运行时长；`--duration-seconds 600` 可显式指定。目录由入口创建，保存 `harness.log`、`result.json`、逐场景证据及采样文件，成功验证后还写入核算吞吐的 `summary.json`。入口为 harness 创建独立临时 profile；只有 harness 正常退出、提供其自有进程均已退出的记录且所有证据验证通过后才删除该 profile。失败时保留 profile 和证据，输出其路径。POSIX 入口以独立进程组启动 harness：中断、超时或主进程退出后组仍存在时，仅向该持有组请求停止，等待 5 秒后升级强制停止，再等待最多 5 秒确认主进程退出和进程组消失。Windows 对直接持有的 harness 发信号，由 harness 的 kill-on-close Job 收容其子进程。无法确认停止时如实报错并保留现场，harness 仍负责等待并记录其自身子进程。

入口拒绝缺失 harness、非零退出、未满 600 秒的实际单调时长、缺少进程清理记录、场景断言或指标，以及内容不一致的证据。测试入口通过只是说明这些门槛满足；记录实际目标、平台和执行环境后才能评估场景结果。三客户端中的桌面侧由 Rust 客户端模拟，真实窗口关闭和系统安装由独立桌面验证覆盖。

## Ubuntu CI 显式离线验证

手动触发的[里程碑 CI](../.github/workflows/ci.yml)在 Ubuntu Rust job 中先完成联网安装与同源三程序/example 构建，再运行 [offline helper](../scripts/test-host-offline.mjs)：

```sh
node scripts/test-host-offline.mjs --harness src-tauri/target/debug/examples/software_scenarios --output artifacts/host-offline --duration-seconds 600
```

此入口只接受独立 Linux GitHub CI runner。它通过结构化 argv 执行 `sudo -n` → `unshare --net` → `setpriv` → 当前绝对路径 Node；不使用 `unshare --fork`、PAM 会话或 shell。仅场景子树进入匿名网络 namespace，随后恢复原 runner UID/GID/补充组，以最小环境运行原 wrapper 全六场景；600 秒、780 秒超时、进程组停止确认及全部预算/证据门槛保持不变。工具或隔离校验失败直接失败，不回退在线运行。

helper 保存父/子 `/proc/self/ns/net` 的目标与 device/inode、UID/GID/组/capabilities、`/proc/net` 原件，以及 `ip -j` 的 link/address 和 IPv4/IPv6 全路由表查询结果。场景前后都须确认子 namespace 与父不同且保持不变、只有未启用的 lo、无 IP 地址、双栈各表无路由；它不访问外网探测目标，也不更改 runner 父 namespace 的网卡、路由或防火墙。Node 的临时 profile 位于本轮 `tmp/`，原 wrapper 仍仅在验证通过后删除；失败现场保留。

`artifacts/host-offline` 包含 `network/`、原始 `scenarios/`、`launcher.log`、`child-result.json` 和记录提交 SHA、程序哈希、工具版本及准确退出状态的 `run.json`。父进程确认 namespace/UID 未变、证据属原 runner 且可读；独立 `always()` 上传步骤在 namespace 外保存 artifact。离线成功须同时有前后隔离证据、wrapper 成功及上传成功，不能仅凭环境变量或摘要计为通过。

同源 Ubuntu 离线全六场景这一轮同时作为 Linux 正式源验收，不再重复相同在线 600 秒。该结果覆盖 M1 Host/CLI/MCP 软件切片；Node 插件、其它平台离线运行、真实串口、发行包和 72 小时长稳按各阶段另行验收。真实 namespace 结果须由对应 CI 的 artifact 回填，入口接线与本地单元测试通过不记为离线运行通过。

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

T01/T03/T04/T05/T08 的断言应记录原始字节或哈希、状态和操作回执；T05 使用受控注入来验证满盘类写入错误，只有独立满文件系统测试才能报告真实 OS 满盘。T06 以单会话 11,520 B/s 作为软件参考负载，报告计数、吞吐、队列、RSS 和延迟分位数。物理适配器、3/6/12 Mbps 和 72 小时长稳不属于本次软件验证。
