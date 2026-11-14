use serial_workbench_core::{HostError, HostResult, WireFrame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 1_048_576;

/// 只计数、不分配正文，用于在序列化或排队前取得字节预算。
pub fn encoded_length(value: &impl serde::Serialize, max_bytes: usize) -> HostResult<usize> {
    struct Counter {
        length: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.length) {
                return Err(std::io::Error::other("frame limit"));
            }
            self.length += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        length: 0,
        limit: max_bytes,
    };
    serde_json::to_writer(&mut counter, value).map_err(|_| too_large())?;
    Ok(counter.length)
}

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> HostResult<Option<WireFrame>> {
    let mut header = [0_u8; 4];
    if reader
        .read(&mut header[..1])
        .await
        .map_err(|_| disconnected())?
        == 0
    {
        return Ok(None);
    }
    reader
        .read_exact(&mut header[1..])
        .await
        .map_err(|_| disconnected())?;
    let length = u32::from_be_bytes(header) as usize;
    if length > max_bytes {
        return Err(too_large());
    }
    if length == 0 {
        return Err(invalid());
    }
    // 长度校验先于分配与读取正文，半帧从不交给业务层。
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| disconnected())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| invalid())
}
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &WireFrame,
    max_bytes: usize,
) -> HostResult<()> {
    // 限额写入器避免先把超大结果完整序列化进内存。
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl std::io::Write for Bounded {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if data.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("frame limit"));
            }
            self.bytes.extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut body = Bounded {
        bytes: Vec::new(),
        limit: max_bytes.min(u32::MAX as usize),
    };
    serde_json::to_writer(&mut body, frame).map_err(|_| too_large())?;
    writer
        .write_all(&(body.bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|_| disconnected())?;
    writer
        .write_all(&body.bytes)
        .await
        .map_err(|_| disconnected())?;
    writer.flush().await.map_err(|_| disconnected())
}
fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid IPC frame")
}
fn too_large() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "IPC frame exceeds the byte limit")
}
fn disconnected() -> HostError {
    HostError::new(
        "UNAUTHENTICATED",
        "Local connection ended before a complete frame",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::*;
    use tokio::io::{AsyncWriteExt, duplex};
    fn frame() -> WireFrame {
        WireFrame {
            request_id: RequestId::try_from("11111111-1111-4111-8111-111111111111").unwrap(),
            channel: IpcChannel::Control,
            body: IpcMessage::RawAttached {},
        }
    }
    #[test]
    fn encoded_budget_counts_escaping_and_stops_serializing_at_the_limit() {
        let value = serde_json::json!({"text":"\"\\\n"});
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(encoded_length(&value, bytes.len()).unwrap(), bytes.len());
        assert!(encoded_length(&value, bytes.len() - 1).is_err());
        struct Sequence(std::cell::Cell<usize>);
        impl serde::Serialize for Sequence {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeSeq;
                let mut sequence = serializer.serialize_seq(Some(10_000))?;
                for _ in 0..10_000 {
                    self.0.set(self.0.get() + 1);
                    sequence.serialize_element("data")?;
                }
                sequence.end()
            }
        }
        let sequence = Sequence(std::cell::Cell::new(0));
        assert_eq!(
            encoded_length(&sequence, 32).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        assert!(sequence.0.get() < 10_000);
    }
    #[tokio::test]
    async fn bounded_frame_roundtrip_and_clean_eof() {
        let (mut writer, mut reader) = duplex(2048);
        let value = frame();
        write_frame(&mut writer, &value, 1024).await.unwrap();
        writer.shutdown().await.unwrap();
        assert_eq!(read_frame(&mut reader, 1024).await.unwrap(), Some(value));
        assert_eq!(read_frame(&mut reader, 1024).await.unwrap(), None);
    }
    #[tokio::test]
    async fn oversized_header_is_rejected_without_waiting_for_payload() {
        let (mut writer, mut reader) = duplex(16);
        writer
            .write_all(&1_048_577_u32.to_be_bytes())
            .await
            .unwrap();
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_frame(&mut reader, 1_048_576),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error.code, "LIMIT_EXCEEDED");
    }
    #[tokio::test]
    async fn partial_header_and_body_never_produce_a_frame() {
        for bytes in [vec![0, 0], vec![0, 0, 0, 4, b'{']] {
            let (mut writer, mut reader) = duplex(64);
            writer.write_all(&bytes).await.unwrap();
            writer.shutdown().await.unwrap();
            assert!(read_frame(&mut reader, 1024).await.is_err());
        }
    }
    #[tokio::test]
    async fn malformed_json_utf8_and_empty_frame_are_rejected() {
        for bytes in [vec![0xff], b"{}".to_vec(), Vec::new()] {
            let (mut writer, mut reader) = duplex(64);
            writer
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .unwrap();
            writer.write_all(&bytes).await.unwrap();
            writer.shutdown().await.unwrap();
            assert_eq!(
                read_frame(&mut reader, 1024).await.unwrap_err().code,
                "INVALID_ARGUMENT"
            );
        }
    }
}
