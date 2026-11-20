//! 按调用者的JSON字节上限计数，不分配序列化缓冲。
use serde::Serialize;
use std::io::{self, Write};

struct Counter {
    bytes: usize,
    limit: usize,
}
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("schema bytes"))?;
        if self.bytes > self.limit {
            return Err(io::Error::other("schema bytes"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn measure<T: Serialize + ?Sized>(value: &T, limit: usize) -> serde_json::Result<usize> {
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.bytes)
}
