//! 明确登记的文件引用；不向业务调用开放任意路径。
pub mod references;
pub use references::{FileService, FixedFile};
