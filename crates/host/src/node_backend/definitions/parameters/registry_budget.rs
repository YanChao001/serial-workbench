//! 已知资源表的临时复制先计工作量，再取得全进程加权名额；不表示整个validator的RSS。
use super::{MAX_BYTES, Work, error};
use jsonschema::Draft;
use referencing::{Uri, meta};
use serial_workbench_core::HostResult;
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const ENTRY_WEIGHT: usize =
    std::mem::size_of::<Uri<String>>() + std::mem::size_of::<[usize; 4]>();
const GLOBAL_COPY_WEIGHT: usize = 128 * MAX_BYTES;
const BUNDLED_META_COUNT: usize = 19;

pub(super) fn bundled_meta_schemas() -> [&'static serde_json::Value; BUNDLED_META_COUNT] {
    // pinned referencing 0.61.2可注入的最大集合，名称与索引投影共用公开meta数据。
    [
        &meta::DRAFT4,
        &meta::DRAFT6,
        &meta::DRAFT7,
        &meta::DRAFT201909,
        &meta::DRAFT201909_APPLICATOR,
        &meta::DRAFT201909_CONTENT,
        &meta::DRAFT201909_CORE,
        &meta::DRAFT201909_FORMAT,
        &meta::DRAFT201909_META_DATA,
        &meta::DRAFT201909_VALIDATION,
        &meta::DRAFT202012,
        &meta::DRAFT202012_CORE,
        &meta::DRAFT202012_APPLICATOR,
        &meta::DRAFT202012_UNEVALUATED,
        &meta::DRAFT202012_VALIDATION,
        &meta::DRAFT202012_META_DATA,
        &meta::DRAFT202012_FORMAT_ANNOTATION,
        &meta::DRAFT202012_FORMAT_ASSERTION,
        &meta::DRAFT202012_CONTENT,
    ]
}
pub(super) fn bundled_meta_ids() -> &'static [String; BUNDLED_META_COUNT] {
    static IDS: OnceLock<[String; BUNDLED_META_COUNT]> = OnceLock::new();
    IDS.get_or_init(|| {
        bundled_meta_schemas().map(|schema| {
            Draft::default()
                .detect(schema)
                .create_resource_ref(schema)
                .id()
                .expect("Pinned meta-schema must have an identifier")
                .to_owned()
        })
    })
}

#[derive(Clone, Copy, Default)]
pub(super) struct CopyCost {
    bytes: usize,
    known_metas: u32,
}
fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendSchemaRegistryCopiesBudget")
}
impl CopyCost {
    pub(super) fn add_resource(&mut self, uri: &str) -> HostResult<()> {
        let bit = if uri.starts_with("https://json-schema.org/draft/")
            || uri.starts_with("http://json-schema.org/draft-")
        {
            bundled_meta_ids()
                .iter()
                .position(|id| id == uri)
                .map_or(0, |index| 1 << index)
        } else {
            0
        };
        if bit != 0 && self.known_metas & bit != 0 {
            return Ok(());
        }
        self.bytes = self
            .bytes
            .checked_add(uri.len())
            .and_then(|bytes| bytes.checked_add(ENTRY_WEIGHT))
            .ok_or_else(limit)?;
        self.known_metas |= bit;
        Ok(())
    }
    pub(super) fn reserve(&self, work: &mut Work) -> HostResult<OwnedSemaphorePermit> {
        // prepare/build都可能注入固定meta，预留整套最大集合；源中同名键不重复收费。
        let bytes =
            bundled_meta_ids()
                .iter()
                .enumerate()
                .try_fold(self.bytes, |bytes, (index, id)| {
                    if self.known_metas & (1 << index) != 0 {
                        return Ok(bytes);
                    }
                    bytes
                        .checked_add(id.len())
                        .and_then(|bytes| bytes.checked_add(ENTRY_WEIGHT))
                        .ok_or_else(limit)
                })?;
        work.step(0, bytes).map_err(|_| limit())?;
        let weight = u32::try_from(bytes).map_err(|_| limit())?;
        static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
        CAPACITY
            .get_or_init(|| Arc::new(Semaphore::new(GLOBAL_COPY_WEIGHT)))
            .clone()
            .try_acquire_many_owned(weight)
            .map_err(|_| {
                let mut busy = error("HOST_BUSY", "backendSchemaRegistryCopyCapacity");
                busy.retryable = true;
                busy
            })
    }
}
