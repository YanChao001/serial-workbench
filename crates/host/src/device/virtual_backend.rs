use serial_workbench_core::*;
use std::{collections::VecDeque, sync::Arc, time::Duration};

const RX_CAPACITY: usize = 64 * 1024;

/// 单 owner 的逻辑串流设备；写入完成即进入有界回显 RX 队列。
pub struct VirtualTransport {
    configuration: SerialConfiguration,
    rx: VecDeque<u8>,
    dtr: bool,
    rts: bool,
    break_asserted: bool,
    closed: bool,
}

impl VirtualTransport {
    pub fn new(configuration: SerialConfiguration) -> Self {
        Self {
            configuration,
            rx: VecDeque::with_capacity(RX_CAPACITY),
            dtr: false,
            rts: false,
            break_asserted: false,
            closed: false,
        }
    }

    fn ensure_open(&self) -> BackendResult<()> {
        if self.closed {
            return Err(HostError::new("BACKEND_DISCONNECTED", "Virtual device is closed").into());
        }
        Ok(())
    }
}

impl Transport for VirtualTransport {
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            semantics: TransportSemantics::Stream,
            configuration: true,
            dtr: true,
            rts: true,
            finite_break: true,
            queue_status: true,
            drain: true,
            purge_rx: true,
            purge_tx: true,
        }
    }

    fn read(&mut self, limit: usize, _wait: Duration) -> BackendResult<ReadBlock> {
        self.ensure_open()?;
        // 没有独立 producer；空读立即返回，owner 负责空闲等待与合作取消。
        let count = limit.min(self.rx.len());
        let bytes: Vec<u8> = self.rx.drain(..count).collect();
        Ok(ReadBlock {
            bytes: Arc::from(bytes),
            message: None,
        })
    }

    fn write(&mut self, bytes: &[u8], _wait: Duration) -> BackendResult<BackendWrite> {
        self.ensure_open()?;
        let accepted = bytes.len().min(RX_CAPACITY - self.rx.len());
        self.rx.extend(&bytes[..accepted]);
        Ok(BackendWrite {
            accepted_ranges: if accepted == 0 {
                vec![]
            } else {
                vec![ByteRange {
                    start: U64::from(0),
                    end: U64::from(accepted as u64),
                }]
            },
            unknown_ranges: vec![],
            error: (accepted < bytes.len())
                .then(|| HostError::new("LIMIT_EXCEEDED", "Virtual echo RX queue is full")),
        })
    }

    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.ensure_open()?;
        // 配置是 Virtual 的逻辑状态，不模拟物理串口时序或限制枚举组合。
        self.configuration = config.clone();
        let readback: JsonObject = serde_json::to_value(&self.configuration)
            .and_then(serde_json::from_value)
            .map_err(|error| {
                BackendError::from(HostError::new("INTERNAL_ERROR", error.to_string()))
            })?;
        let fields = readback
            .iter()
            .map(|(field, actual)| ConfigField {
                field: field.clone(),
                status: FieldStatus::Applied,
                actual: Some(actual.clone()),
            })
            .collect();
        Ok(ConfigApplication { fields, readback })
    }

    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.ensure_open()?;
        Ok(match command {
            ControlCommand::SetLine { line, value } => {
                if matches!(
                    (self.configuration.flow_control, line),
                    (FlowControl::RtsCts, ControlLine::Rts)
                        | (FlowControl::DsrDtr, ControlLine::Dtr)
                ) {
                    return Err(
                        HostError::new("CONTROL_CONFLICT", "Flow control owns this line").into(),
                    );
                }
                let actual = match line {
                    ControlLine::Dtr => &mut self.dtr,
                    ControlLine::Rts => &mut self.rts,
                };
                *actual = value;
                ControlResult::Line {
                    line,
                    value: *actual,
                }
            }
            ControlCommand::AssertBreak => {
                self.break_asserted = true;
                ControlResult::Break {
                    asserted: self.break_asserted,
                }
            }
            ControlCommand::ClearBreak => {
                self.break_asserted = false;
                ControlResult::Break {
                    asserted: self.break_asserted,
                }
            }
            // Virtual write 同步完成；待读 RX 不属于尚待发送的 TX 队列。
            ControlCommand::QueueStatus => ControlResult::Queue {
                pending_bytes: U64::from(0),
            },
            ControlCommand::Drain { .. } => ControlResult::Drained,
            ControlCommand::Purge { direction } => {
                let discard_rx = matches!(direction, PurgeDirection::Rx | PurgeDirection::Both);
                let discarded = discard_rx && !self.rx.is_empty();
                if discard_rx {
                    self.rx.clear();
                }
                // 尚未交付 owner 的 RX 没有源流偏移，不能伪造 DirectionalRange。
                ControlResult::Purged {
                    ranges: vec![],
                    unknown_extent: discarded,
                }
            }
        })
    }

    fn close(&mut self) -> BackendResult<()> {
        self.closed = true;
        self.rx = VecDeque::new();
        self.dtr = false;
        self.rts = false;
        self.break_asserted = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend() -> VirtualTransport {
        VirtualTransport::new(SerialConfiguration::default())
    }

    fn ranges(value: &BackendWrite) -> Vec<(u64, u64)> {
        value
            .accepted_ranges
            .iter()
            .map(|range| (range.start.get(), range.end.get()))
            .collect()
    }

    #[test]
    fn echoes_every_byte_without_message_metadata() {
        let mut transport = backend();
        let bytes: Vec<u8> = (0..=255).collect();
        let written = transport.write(&bytes, Duration::ZERO).unwrap();
        assert_eq!(ranges(&written), [(0, 256)]);
        assert!(written.unknown_ranges.is_empty());
        assert!(written.error.is_none());
        let read = transport.read(1024, Duration::ZERO).unwrap();
        assert_eq!(&*read.bytes, &bytes);
        assert!(read.message.is_none());
    }

    #[test]
    fn read_limit_preserves_tail_and_write_order() {
        let mut transport = backend();
        transport.write(&[0, 1, 2], Duration::ZERO).unwrap();
        transport.write(&[255, 4], Duration::ZERO).unwrap();
        assert!(transport.read(0, Duration::ZERO).unwrap().bytes.is_empty());
        assert_eq!(&*transport.read(2, Duration::ZERO).unwrap().bytes, &[0, 1]);
        assert_eq!(
            &*transport.read(2, Duration::ZERO).unwrap().bytes,
            &[2, 255]
        );
        assert_eq!(&*transport.read(2, Duration::ZERO).unwrap().bytes, &[4]);
        assert!(
            transport
                .read(1, Duration::from_millis(20))
                .unwrap()
                .bytes
                .is_empty()
        );
        transport.write(&[9], Duration::ZERO).unwrap();
        assert_eq!(&*transport.read(1, Duration::ZERO).unwrap().bytes, &[9]);
    }

    #[test]
    fn capacity_reports_partial_prefix_and_read_releases_space() {
        let mut transport = backend();
        transport.write(&vec![7; 65_534], Duration::ZERO).unwrap();
        let partial = transport.write(&[0, 255, 3, 4, 5], Duration::ZERO).unwrap();
        assert_eq!(ranges(&partial), [(0, 2)]);
        assert!(partial.unknown_ranges.is_empty());
        assert_eq!(partial.error.unwrap().code, "LIMIT_EXCEEDED");
        let full = transport.write(&[8], Duration::from_secs(10)).unwrap();
        assert!(full.accepted_ranges.is_empty());
        assert!(full.unknown_ranges.is_empty());
        assert_eq!(full.error.unwrap().code, "LIMIT_EXCEEDED");
        let empty = transport.write(&[], Duration::ZERO).unwrap();
        assert!(empty.accepted_ranges.is_empty());
        assert!(empty.error.is_none());
        let read = transport.read(65_536, Duration::ZERO).unwrap();
        assert_eq!(read.bytes.len(), 65_536);
        assert!(read.bytes[..65_534].iter().all(|byte| *byte == 7));
        assert_eq!(&read.bytes[65_534..], &[0, 255]);
        assert_eq!(
            ranges(&transport.write(&[3, 4, 5], Duration::ZERO).unwrap()),
            [(0, 3)]
        );
        assert_eq!(
            &*transport.read(10, Duration::ZERO).unwrap().bytes,
            &[3, 4, 5]
        );
    }

    #[test]
    fn configuration_readback_is_complete_logical_state() {
        let mut transport = backend();
        let configuration = SerialConfiguration {
            baud_rate: PositiveU64::try_from(U64::from(u64::MAX)).unwrap(),
            data_bits: DataBits::Eight,
            parity: Parity::Space,
            stop_bits: StopBits::OnePointFive,
            flow_control: FlowControl::XonXoff,
            read_wait_ms: DurationMs::try_from(U64::from(37)).unwrap(),
            write_wait_ms: DurationMs::try_from(U64::from(41)).unwrap(),
            reconnect_backoff_ms: DurationMs::try_from(U64::from(43)).unwrap(),
        };
        let result = transport.configure(&configuration).unwrap();
        assert_eq!(
            serde_json::to_value(&result.readback).unwrap(),
            serde_json::json!({
                "baudRate": "18446744073709551615", "dataBits": "8", "parity": "space",
                "stopBits": "onePointFive", "flowControl": "xonXoff", "readWaitMs": "37",
                "writeWaitMs": "41", "reconnectBackoffMs": "43"
            })
        );
        assert_eq!(result.fields.len(), 8);
        for field in result.fields {
            assert_eq!(field.status, FieldStatus::Applied);
            assert_eq!(field.actual.as_ref(), result.readback.get(&field.field));
        }
    }

    #[test]
    fn virtual_configuration_accepts_all_logical_enum_values() {
        let mut transport = backend();
        let mut configuration = SerialConfiguration::default();
        for bits in [
            DataBits::Five,
            DataBits::Six,
            DataBits::Seven,
            DataBits::Eight,
        ] {
            configuration.data_bits = bits;
            for parity in [
                Parity::None,
                Parity::Even,
                Parity::Odd,
                Parity::Mark,
                Parity::Space,
            ] {
                configuration.parity = parity;
                for stop in [StopBits::One, StopBits::OnePointFive, StopBits::Two] {
                    configuration.stop_bits = stop;
                    for flow in [
                        FlowControl::None,
                        FlowControl::RtsCts,
                        FlowControl::XonXoff,
                        FlowControl::DsrDtr,
                    ] {
                        configuration.flow_control = flow;
                        let result = transport.configure(&configuration).unwrap();
                        assert_eq!(result.fields.len(), 8);
                        assert!(
                            result
                                .fields
                                .iter()
                                .all(|field| field.status == FieldStatus::Applied)
                        );
                        let actual: SerialConfiguration =
                            serde_json::from_value(serde_json::to_value(&result.readback).unwrap())
                                .unwrap();
                        assert_eq!(actual, configuration);
                    }
                }
            }
        }
    }

    #[test]
    fn lines_and_break_report_confirmed_virtual_state() {
        let mut transport = backend();
        for line in [ControlLine::Dtr, ControlLine::Rts] {
            for value in [true, false] {
                assert!(
                    matches!(transport.control(ControlCommand::SetLine { line, value }).unwrap(), ControlResult::Line { line: actual_line, value: actual_value } if actual_line == line && actual_value == value)
                );
            }
        }
        assert!(matches!(
            transport.control(ControlCommand::AssertBreak).unwrap(),
            ControlResult::Break { asserted: true }
        ));
        assert!(matches!(
            transport.control(ControlCommand::ClearBreak).unwrap(),
            ControlResult::Break { asserted: false }
        ));
        assert!(matches!(
            transport.control(ControlCommand::ClearBreak).unwrap(),
            ControlResult::Break { asserted: false }
        ));
    }

    #[test]
    fn hardware_flow_control_reserves_only_its_line() {
        let mut transport = backend();
        let mut configuration = SerialConfiguration::default();
        for (flow, reserved, available) in [
            (FlowControl::RtsCts, ControlLine::Rts, ControlLine::Dtr),
            (FlowControl::DsrDtr, ControlLine::Dtr, ControlLine::Rts),
        ] {
            configuration.flow_control = flow;
            transport.configure(&configuration).unwrap();
            assert_eq!(
                transport
                    .control(ControlCommand::SetLine {
                        line: reserved,
                        value: true
                    })
                    .unwrap_err()
                    .error
                    .code,
                "CONTROL_CONFLICT"
            );
            assert!(
                transport
                    .control(ControlCommand::SetLine {
                        line: available,
                        value: true
                    })
                    .is_ok()
            );
        }
        configuration.flow_control = FlowControl::None;
        transport.configure(&configuration).unwrap();
        assert!(
            transport
                .control(ControlCommand::SetLine {
                    line: ControlLine::Rts,
                    value: false
                })
                .is_ok()
        );
        assert!(
            transport
                .control(ControlCommand::SetLine {
                    line: ControlLine::Dtr,
                    value: false
                })
                .is_ok()
        );
    }

    #[test]
    fn queue_and_drain_do_not_consume_pending_echo() {
        let mut transport = backend();
        transport.write(&[0, 255, 8], Duration::ZERO).unwrap();
        assert!(
            matches!(transport.control(ControlCommand::QueueStatus).unwrap(), ControlResult::Queue { pending_bytes } if pending_bytes.get() == 0)
        );
        assert!(matches!(
            transport
                .control(ControlCommand::Drain {
                    wait: Duration::ZERO
                })
                .unwrap(),
            ControlResult::Drained
        ));
        assert_eq!(
            &*transport.read(10, Duration::ZERO).unwrap().bytes,
            &[0, 255, 8]
        );
    }

    #[test]
    fn purge_tx_preserves_rx_and_rx_purge_discards_pending_echo() {
        let mut transport = backend();
        transport.write(&[0, 255], Duration::ZERO).unwrap();
        assert!(
            matches!(transport.control(ControlCommand::Purge { direction: PurgeDirection::Tx }).unwrap(), ControlResult::Purged { ranges, unknown_extent: false } if ranges.is_empty())
        );
        assert_eq!(&*transport.read(1, Duration::ZERO).unwrap().bytes, &[0]);
        assert!(
            matches!(transport.control(ControlCommand::Purge { direction: PurgeDirection::Rx }).unwrap(), ControlResult::Purged { ranges, unknown_extent: true } if ranges.is_empty())
        );
        assert!(transport.read(5, Duration::ZERO).unwrap().bytes.is_empty());
        assert!(
            matches!(transport.control(ControlCommand::Purge { direction: PurgeDirection::Both }).unwrap(), ControlResult::Purged { ranges, unknown_extent: false } if ranges.is_empty())
        );
        transport.write(&[5], Duration::ZERO).unwrap();
        assert_eq!(&*transport.read(5, Duration::ZERO).unwrap().bytes, &[5]);
    }

    #[test]
    fn close_is_idempotent_and_all_device_operations_disconnect() {
        let mut transport = backend();
        transport.write(&[1, 2], Duration::ZERO).unwrap();
        transport.close().unwrap();
        transport.close().unwrap();
        assert_eq!(
            transport.read(10, Duration::ZERO).unwrap_err().error.code,
            "BACKEND_DISCONNECTED"
        );
        let error = transport.write(&[3], Duration::ZERO).unwrap_err();
        assert_eq!(error.error.code, "BACKEND_DISCONNECTED");
        assert!(error.accepted_ranges.is_empty());
        assert!(error.unknown_ranges.is_empty());
        assert_eq!(
            transport
                .configure(&SerialConfiguration::default())
                .unwrap_err()
                .error
                .code,
            "BACKEND_DISCONNECTED"
        );
        assert_eq!(
            transport
                .control(ControlCommand::QueueStatus)
                .unwrap_err()
                .error
                .code,
            "BACKEND_DISCONNECTED"
        );
    }

    #[test]
    fn capabilities_describe_implemented_stream_controls() {
        let capabilities = backend().capabilities();
        assert_eq!(capabilities.semantics, TransportSemantics::Stream);
        assert!(
            capabilities.configuration
                && capabilities.dtr
                && capabilities.rts
                && capabilities.finite_break
                && capabilities.queue_status
                && capabilities.drain
                && capabilities.purge_rx
                && capabilities.purge_tx
        );
    }
}
