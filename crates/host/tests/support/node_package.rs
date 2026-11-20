use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use serial_workbench_core::NODE_PACKAGE_SIGNATURE_PREFIX;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub(crate) fn manifest() -> Value {
    json!({
        "schemaVersion":"0.1","id":"example.terminal","version":"1.0.0",
        "displayName":"离线终端","description":"参考包","license":"MIT",
        "notices":["许可证/LICENSE.txt"],"hostProtocolVersion":"0.1",
        "runtimeRef":"node-26.13.0","main":"dist/main.mjs","webUi":{"entry":"界面/index.html"},
        "dependencies":[],"platformResources":[],"activation":["startup"],
        "permissions":{"hostApi":[],"executionPurposes":["terminal"],"externalTools":[]},
        "contributes":{"actions":[],"queries":[],"transports":[],"parsers":[],"views":[],"themes":[],"configuration":[]},
        "dataSchemaVersion":"1"
    })
}

pub(crate) fn payloads() -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        (
            "manifest.json".into(),
            serde_json::to_vec(&manifest()).unwrap(),
        ),
        (
            "dist/main.mjs".into(),
            b"throw new Error('installation must not execute this');".to_vec(),
        ),
        (
            "界面/index.html".into(),
            b"<!doctype html><title>Terminal</title>".to_vec(),
        ),
        ("许可证/LICENSE.txt".into(), b"MIT".to_vec()),
    ])
}

pub(crate) fn with_metadata(
    mut files: BTreeMap<String, Vec<u8>>,
    signed: bool,
) -> BTreeMap<String, Vec<u8>> {
    let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    let integrity = json!({
        "schemaVersion":"0.1","id":manifest["id"],"version":manifest["version"],
        "source":if signed {"test-source"} else {"local"},
        "keyId":if signed {"test-key"} else {"local-unverified"},
        "files": files.iter().map(|(path, bytes)| json!({
            "path":path,"size":bytes.len().to_string(),"sha256":format!("{:x}", Sha256::digest(bytes))
        })).collect::<Vec<_>>()
    });
    let raw = serde_json::to_vec_pretty(&integrity).unwrap();
    if signed {
        // 固定测试种子只用于临时 fixture，不是发布密钥。
        let key = SigningKey::from_bytes(&[7; 32]);
        let message = [NODE_PACKAGE_SIGNATURE_PREFIX, &raw].concat();
        let signature = json!({
            "algorithm":"Ed25519","keyId":"test-key",
            "signatureBase64":STANDARD.encode(key.sign(&message).to_bytes())
        });
        files.insert(
            "signature.json".into(),
            serde_json::to_vec(&signature).unwrap(),
        );
    }
    files.insert("integrity.json".into(), raw);
    files
}

pub(crate) fn archive(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    archive_with_compression(files, CompressionMethod::Deflated)
}

pub(crate) fn archive_with_compression(
    files: &BTreeMap<String, Vec<u8>>,
    compression: CompressionMethod,
) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(compression),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
