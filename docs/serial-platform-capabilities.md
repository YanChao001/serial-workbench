# 系统串口与 PTY 能力

系统串口由独立 Host 的设备目录提供。目录返回不透明 `deviceId`；打开操作解析当前目录与绑定后，才把受信的系统定位符交给原生提供器。COM 编号、tty 路径和枚举顺序都不是稳定设备身份。目录刷新、stale 与重连规则由设备服务维护，平台提供器只读取 OS 事实。

## 配置与读回

产品保留 5/6/7/8 数据位、五种 parity、三种 stop width 和四种流控。平台不能表达的组合返回 `UNSUPPORTED_CAPABILITY`；驱动修改了请求值时，配置回执保留实际读回，TX 门控保持关闭。打开时只有全部字段确认一致才返回成功。

| 配置              | Windows                           | Linux                                   | macOS                                          |
| ----------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| 5/6/7/8 数据位    | DCB，随后 GetCommState            | termios2，随后 TCGETS2                  | termios，随后 tcgetattr                        |
| none/even/odd     | 支持编码与独立读回                | 支持编码与独立读回                      | 支持编码与独立读回                             |
| mark/space        | DCB MARKPARITY/SPACEPARITY        | CMSPAR，依驱动读回                      | 通用 termios 无对应表达，明确拒绝              |
| 1.5 stop          | 仅 5 数据位组合；6/7/8 明确拒绝   | 通用接口无法与 two 准确区分，明确拒绝   | 通用接口无对应表达，明确拒绝                   |
| 2 stop + 5 数据位 | 明确拒绝                          | 明确拒绝物理宽度歧义                    | 明确拒绝物理宽度歧义                           |
| RTS/CTS           | CTS 输出门控与 RTS handshake      | CRTSCTS                                 | CRTSCTS                                        |
| DSR/DTR           | DSR 输出门控与 DTR handshake      | 通用 termios 无双向 handshake，明确拒绝 | CDTR_IFLOW 与 CDSR_OFLOW，依驱动读回           |
| XON/XOFF          | 双向软件流控                      | IXON 与 IXOFF                           | IXON 与 IXOFF                                  |
| 任意 baud         | DCB 的 u32 范围，依驱动接受与读回 | termios2/BOTHER 的 u32 范围             | termios 或 IOSSIOSPEED；无法独立读回时拒绝确认 |

读写等待和重连间隔是 Host 策略字段，由 Host 保存；它们不伪装成硬件寄存器读回。数据通路关闭 echo、换行转换、strip、NUL 丢弃和字符替换。RTS/CTS 模式占用 RTS，DSR/DTR 模式占用 DTR；手动改变已被流控占用的线返回 `CONTROL_CONFLICT`。

## 原生资源与排空

每个端口只独占打开一次。专有原生读取线程与单个 TX 或 drain 任务共享同一份受控句柄引用；会话所有者在写入和 drain 待完成期间继续 RX，不允许新的 TX、配置或有副作用控制穿插。写回执分别记录已经确认的接纳前缀、当前在途未知区间和未提交的尾部；取消不会把已提交的字节改写为零副作用。

写入载荷同时保有字节与原分配的预算租约。业务已返回 unknown、源历史已被回收时，未完成的原生任务仍承担这笔预算；实际完成后才释放。Windows overlapped 写入借用这份载荷，不额外复制整块缓冲区。

Windows 使用 FlushFileBuffers，Unix 使用 tcdrain。只有原生调用成功结束才产生 confirmed；驱动队列计数为零、等待一段时间或请求取消都不能生成确认。Windows 通过 CancelSynchronousIo 请求中断 drain；Unix 尝试安装专用 SIGUSR2 空 handler 并定向中断，不覆盖进程已有的该信号处理器。不能安装 handler 或驱动不响应时，等待仍然有界，结果保留 unknown。

取消收尾预算为 100 ms。超过预算后原生线程继续持有句柄、缓冲区和清理责任；会话进入 `ControlUnknown`，同设备保留隔离，晚到成功不会自动恢复 TX 或允许重开。活跃与隔离串口合计最多 16 项。会话 close 使用独立关闭信号，等待 owner 最多 250 ms；业务邮箱满不会丢失关闭责任，Drop 不等待未完成线程。

领域 write/drain 期限使用 Host 的注入单调时钟；到期通过独立原生取消信号请求收尾，错误仍保留 `WRITE_TIMEOUT`，不会改成用户主动取消。owner 的备用收尾预算是实际时间 150 ms，不依赖领域时钟继续推进。

原生 close 也在持有资源的原生线程执行。实际进程或 OS 锁尚未消失时，停止流程仍需按真实状态报告；线程分离不产生“设备已停止”证明。

## 控制与诊断

- Windows 使用 SetupAPI 枚举 present Ports，读取受控 PortName、说明、厂商、硬件标识、拓扑及驱动信息；Linux 读取 sysfs tty 与 USB 祖先属性；macOS 使用 IOKit IOSerialBSDClient 与 USB 注册表属性。
- 序列号缺失不补默认值。Windows 不把任意实例 ID 的末段当序列号；目录还会检查候选唯一性和拓扑变化。
- DTR/RTS、BREAK、purge、队列采样与 CTS/DSR/RI/CD 输入采样通过平台 API。输出调用成功表示驱动接受了请求；物理电平与对端收到 BREAK 需要硬件验证。
- purge 无法对应逻辑流偏移时报告未知丢弃范围，不编造字节偏移。Windows 接收溢出会产生明确错误；Unix 的普通 tty 接口没有统一的溢出计数，持续无损能力需结合实际驱动验证。
- 原生错误保留稳定 code 与 `details.osCode`，不把任意路径或推测的占用进程写入错误文本。

## 验证分层

`cargo test --locked -p serial-workbench-host --lib device::serial` 验证参数编码、读回与可控原生调用的资源生命周期；`--lib device::sessions::mailbox_tests` 验证真实 owner 的 RX、邮箱和有限关闭。

`cargo test --locked -p serial-workbench-host --test serial_backend --test pty_roundtrip` 在目标 OS 运行提供器与 PTY 测试。PTY 对端是独立进程，验证任意分块、字节摘要、RX purge、实际 drain 调用和断连。Windows 上被 cfg 排除的 PTY 用例不计为通过。Linux PTY 的 tcdrain 可能立即返回，因此这一结果不证明成功中断过阻塞 drain。

M6 硬件检查保留 CTS/XOFF 阻塞、实际速率、最后停止位、USB FIFO、输入边沿、线电平与 BREAK 接收。记录 OS、内核、驱动、芯片、接线和时间基准；本机软件用例不替代这些证据。

实现依据：[Windows DCB](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb)、[Windows COMMTIMEOUTS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-commtimeouts)、[Windows CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex)、[Linux termios](https://man7.org/linux/man-pages/man3/termios.3.html)、[Linux termios2](https://man7.org/linux/man-pages/man2/TCGETS2.2const.html)、[Apple 串口访问](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/WorkingWSerial/WWSerial_SerialDevs/SerialDevices.html)、[Darwin termios 声明](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/termios.h)、[IOSSIOSPEED 声明](https://raw.githubusercontent.com/apple-oss-distributions/IOSerialFamily/main/IOSerialFamily.kmodproj/ioss.h)。
