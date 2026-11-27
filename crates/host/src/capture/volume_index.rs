//! Append-only position index for one raw 0.4 volume.
use super::format::{IndexEntry, corrupt, io_error, open_read};
use crate::files::references::PathGuard;
use serial_workbench_core::HostResult;
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

const MAGIC: &[u8; 7] = b"SWBI01\n";
pub(super) const HEADER_BYTES: u64 = MAGIC.len() as u64;
pub(super) const ENTRY_BYTES: u64 = 12;

pub(super) fn name(ordinal: u64) -> String {
    format!("index-{ordinal:06}.swbi")
}

pub(super) struct VolumeIndexWriter {
    file: File,
    synced_length: u64,
}

impl VolumeIndexWriter {
    pub(super) fn create(directory: &PathGuard, ordinal: u64) -> HostResult<Self> {
        let mut file = directory.child(&name(ordinal))?.create_file()?;
        file.write_all(MAGIC).map_err(io_error)?;
        Ok(Self {
            file,
            synced_length: HEADER_BYTES,
        })
    }

    pub(super) fn checkpoint(&mut self, entries: &[IndexEntry]) -> HostResult<()> {
        let new_length = self.synced_length + entries.len() as u64 * ENTRY_BYTES;
        self.file
            .seek(SeekFrom::Start(self.synced_length))
            .map_err(io_error)?;
        {
            let mut output = BufWriter::new(&mut self.file);
            for entry in entries {
                let length = u32::try_from(entry.length.get()).map_err(|_| corrupt())?;
                output
                    .write_all(&entry.offset.get().to_le_bytes())
                    .map_err(io_error)?;
                output.write_all(&length.to_le_bytes()).map_err(io_error)?;
            }
            output.flush().map_err(io_error)?;
        }
        self.file.set_len(new_length).map_err(io_error)?;
        self.file.sync_all().map_err(io_error)?;
        // A retry after partial I/O starts at the last successful sync.
        self.synced_length = new_length;
        Ok(())
    }
}

pub(super) struct VolumeIndexReader(BufReader<File>);

impl VolumeIndexReader {
    pub(super) fn open(directory: &Path, ordinal: u64) -> HostResult<Self> {
        let mut file = BufReader::new(open_read(&directory.join(name(ordinal)))?);
        let mut magic = [0; MAGIC.len()];
        file.read_exact(&mut magic).map_err(io_error)?;
        if &magic != MAGIC {
            return Err(corrupt());
        }
        Ok(Self(file))
    }

    pub(super) fn check(&mut self, expected: &IndexEntry) -> HostResult<()> {
        let mut offset = [0; 8];
        let mut length = [0; 4];
        self.0.read_exact(&mut offset).map_err(io_error)?;
        self.0.read_exact(&mut length).map_err(io_error)?;
        if u64::from_le_bytes(offset) != expected.offset.get()
            || u64::from(u32::from_le_bytes(length)) != expected.length.get()
        {
            return Err(corrupt());
        }
        Ok(())
    }

    pub(super) fn at_end(&mut self) -> HostResult<bool> {
        let mut extra = [0];
        Ok(self.0.read(&mut extra).map_err(io_error)? == 0)
    }
}
