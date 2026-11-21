//! 从公开 SDK 编译输出制作本机验收用的签名参考包。
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serial_workbench_core::{
    NODE_PACKAGE_SIGNATURE_PREFIX, NodePackageIntegrity, NodePackageManifest,
    NodeSourceApproveParams,
};
use serial_workbench_host::node_packages::{
    NodePackageLimits, NodePackageSource, verify_node_package,
};
use sha2::{Digest as _, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Cursor, Read, Write},
    path::PathBuf,
    sync::atomic::AtomicBool,
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub fn sign(
    example: &str,
    manifest_bytes: &[u8],
    view: Option<(&[u8], &[u8])>,
    assets: &[(&str, &[u8])],
) -> Result<(), Box<dyn std::error::Error>> {
    let [module, seed_file, output, source, key_id] = <[std::ffi::OsString; 5]>::try_from(
        std::env::args_os().skip(1).collect::<Vec<_>>(),
    ).map_err(|_| format!("Usage: {example} <compiled-main.js> <32-byte-seed> <new-output.zip> <source-id> <key-id>"))?;
    let source = source
        .to_str()
        .ok_or("Source ID must be UTF-8")?
        .try_into()?;
    let key_id = key_id.to_str().ok_or("Key ID must be UTF-8")?.try_into()?;
    let mut raw_seed = Vec::new();
    File::open(seed_file)?.take(33).read_to_end(&mut raw_seed)?;
    let seed: [u8; 32] = raw_seed
        .try_into()
        .map_err(|_| "Signing seed must be exactly 32 bytes")?;
    let key = SigningKey::from_bytes(&seed);
    let public_key = key.verifying_key().to_bytes();

    let mut backend = Vec::new();
    let module = PathBuf::from(module);
    File::open(&module)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut backend)?;
    if backend.is_empty() || backend.len() > 1024 * 1024 {
        return Err("Compiled module must be between 1 byte and 1 MiB".into());
    }
    let mut script = Vec::new();
    // 完整性清单按正式包路径顺序签名。
    let mut files: Vec<(&str, &[u8])> = vec![
        ("LICENSE", include_bytes!("../../../../LICENSE")),
        ("NOTICE", include_bytes!("../../../../NOTICE")),
        ("dist/main.mjs", &backend),
        ("manifest.json", manifest_bytes),
    ];
    if let Some((html, css)) = view {
        File::open(module.with_file_name("view.js"))?
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut script)?;
        if script.is_empty() || script.len() > 8 * 1024 * 1024 {
            return Err("Compiled view must be between 1 byte and 8 MiB".into());
        }
        files.extend([
            ("ui/index.html", html),
            ("ui/view.css", css),
            ("ui/view.js", script.as_slice()),
        ]);
    }
    files.extend_from_slice(assets);
    let manifest: NodePackageManifest = serde_json::from_slice(manifest_bytes)?;
    let integrity: NodePackageIntegrity = serde_json::from_value(serde_json::json!({
        "schemaVersion": "0.1",
        "id": manifest.id,
        "version": manifest.version,
        "source": source,
        "keyId": key_id,
        "files": files.iter().map(|(path, bytes)| serde_json::json!({
            "path": path,
            "size": bytes.len().to_string(),
            "sha256": format!("{:x}", Sha256::digest(bytes)),
        })).collect::<Vec<_>>(),
    }))?;
    let integrity = serde_json::to_vec(&integrity)?;
    let signature = key.sign(&[NODE_PACKAGE_SIGNATURE_PREFIX, &integrity].concat());
    let signature = serde_json::to_vec(&serde_json::json!({
        "algorithm": "Ed25519",
        "keyId": key_id,
        "signatureBase64": STANDARD.encode(signature.to_bytes()),
    }))?;

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in files.into_iter().chain([
        ("integrity.json", integrity.as_slice()),
        ("signature.json", signature.as_slice()),
    ]) {
        zip.start_file(
            path,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )?;
        zip.write_all(bytes)?;
    }
    let verified = verify_node_package(
        zip.finish()?.into_inner(),
        NodePackageSource::Trusted {
            source: &source,
            key_id: &key_id,
            public_key: &public_key,
        },
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )?;
    let approval = NodeSourceApproveParams {
        source,
        key_id,
        public_key,
        public_key_sha256: format!("{:x}", Sha256::digest(public_key))
            .as_str()
            .try_into()?,
    };
    let output = PathBuf::from(output);
    let mut archive = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    archive.write_all(verified.archive_bytes())?;
    archive.sync_all()?;
    println!(
        "{}",
        serde_json::json!({
            "archive": output,
            "archiveSha256": verified.archive_sha256(),
            "sourceApproval": approval,
        })
    );
    Ok(())
}
