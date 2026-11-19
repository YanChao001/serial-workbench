//! UI 分段来自已验证文件字节。索引固定在一次实际后台登记的内容证明上。
use super::{
    VerifiedNodePackage,
    installed::{integrity, link_count, open_directory, path_key},
};
use crate::files::references::PathGuard;
use serial_workbench_core::{
    Digest, HostError, HostResult, NODE_VIEW_ASSET_CHUNK_BYTES, NodePackagePath, U64,
};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom},
    sync::Arc,
};

pub(super) struct UiAssetIndex {
    entry: NodePackagePath,
    files: BTreeMap<String, UiAsset>,
}

struct UiAsset {
    path: NodePackagePath,
    size: U64,
    sha256: Digest,
    chunks: Vec<[u8; 32]>,
}

pub(crate) struct VerifiedUiAssets {
    index: UiAssetIndex,
    root: Arc<PathGuard>,
}

pub(crate) struct UiAssetChunk {
    pub(crate) path: NodePackagePath,
    pub(crate) total_bytes: U64,
    pub(crate) sha256: Digest,
    pub(crate) bytes: Vec<u8>,
}

impl UiAssetIndex {
    pub(super) fn from_archive(package: &VerifiedNodePackage) -> Option<Self> {
        let entry = package.manifest().web_ui.as_ref()?.entry.clone();
        let files = package
            .integrity()
            .files
            .iter()
            .map(|file| {
                (
                    path_key(file.path.as_str()),
                    UiAsset {
                        path: file.path.clone(),
                        size: file.size,
                        sha256: file.sha256.clone(),
                        chunks: Vec::new(),
                    },
                )
            })
            .collect();
        Some(Self { entry, files })
    }

    pub(super) fn chunks(&mut self, path: &str) -> Option<&mut Vec<[u8; 32]>> {
        self.files.get_mut(path).map(|asset| &mut asset.chunks)
    }

    pub(super) fn seal(self, root: Arc<PathGuard>) -> VerifiedUiAssets {
        VerifiedUiAssets { index: self, root }
    }
}

impl VerifiedUiAssets {
    pub(crate) fn entry(&self) -> &NodePackagePath {
        &self.index.entry
    }

    fn locate(&self, path: &NodePackagePath, offset: U64) -> HostResult<&UiAsset> {
        let asset = self
            .index
            .files
            .get(&path_key(path.as_str()))
            .filter(|asset| &asset.path == path)
            .ok_or_else(|| HostError::new("NOT_FOUND", "Asset is not in the verified package"))?;
        let start = offset.get();
        let page_size = NODE_VIEW_ASSET_CHUNK_BYTES as u64;
        if start > asset.size.get()
            || (start != asset.size.get() && !start.is_multiple_of(page_size))
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid plugin asset offset",
            ));
        }
        Ok(asset)
    }

    pub(crate) fn check_range(&self, path: &NodePackagePath, offset: U64) -> HostResult<()> {
        self.locate(path, offset).map(|_| ())
    }

    pub(crate) fn read(&self, path: &NodePackagePath, offset: U64) -> HostResult<UiAssetChunk> {
        let asset = self.locate(path, offset)?;
        let start = offset.get();
        let page_size = NODE_VIEW_ASSET_CHUNK_BYTES as u64;
        let mut names = asset.path.as_str().split('/').peekable();
        let mut directory = None;
        let mut file = loop {
            let name = names.next().ok_or_else(|| integrity("uiAssetPath"))?;
            let parent = directory.as_ref().unwrap_or(self.root.as_ref());
            if names.peek().is_none() {
                break parent
                    .child(name)
                    .and_then(|path| path.open_pinned_file())
                    .map_err(|_| integrity("uiAssetFile"))?;
            }
            directory = Some(open_directory(parent, name)?);
        };
        let metadata = file.metadata().map_err(|_| integrity("uiAssetFile"))?;
        if metadata.len() != asset.size.get() || link_count(&file, &metadata)? != 1 {
            return Err(integrity("uiAssetFileChanged"));
        }
        let length = (asset.size.get() - start).min(page_size) as usize;
        let mut bytes = vec![0; length];
        if !bytes.is_empty() {
            file.seek(SeekFrom::Start(start))
                .and_then(|_| file.read_exact(&mut bytes))
                .map_err(|_| integrity("uiAssetRead"))?;
            let digest: [u8; 32] = Sha256::digest(&bytes).into();
            if asset.chunks.get((start / page_size) as usize) != Some(&digest) {
                return Err(integrity("uiAssetChunkDigest"));
            }
        }
        Ok(UiAssetChunk {
            path: asset.path.clone(),
            total_bytes: asset.size,
            sha256: asset.sha256.clone(),
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn pages_retain_the_verified_digest_and_reject_same_length_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let page = NODE_VIEW_ASSET_CHUNK_BYTES;
        let mut html = vec![b'a'; page + 3];
        html[page..].copy_from_slice(b"end");
        let file = directory.path().join("index.html");
        fs::write(&file, &html).unwrap();
        let path = NodePackagePath::try_from("index.html").unwrap();
        let sha256 = Digest::try_from(format!("{:x}", Sha256::digest(&html)).as_str()).unwrap();
        let index = UiAssetIndex {
            entry: path.clone(),
            files: BTreeMap::from([(
                path.as_str().into(),
                UiAsset {
                    path: path.clone(),
                    size: (html.len() as u64).into(),
                    sha256: sha256.clone(),
                    chunks: html
                        .chunks(page)
                        .map(|page| Sha256::digest(page).into())
                        .collect(),
                },
            )]),
        };
        let proof = index.seal(Arc::new(PathGuard::new(directory.path()).unwrap()));
        let first = proof.read(&path, 0.into()).unwrap();
        let second = proof.read(&path, (page as u64).into()).unwrap();
        assert_eq!(first.bytes, html[..page]);
        assert_eq!(second.bytes, b"end");
        assert_eq!(first.sha256, sha256);
        assert_eq!(second.sha256, sha256);
        assert_eq!(first.total_bytes.get(), html.len() as u64);
        html[page] = b'!';
        fs::write(file, html).unwrap();
        assert!(
            matches!(proof.read(&path, (page as u64).into()), Err(error) if error.code == "INTEGRITY_FAILED")
        );
    }
}
