use std::{env, fs, io::Read, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=SWB_NODE_RUNTIME_BUILD_IMAGE");
    println!("cargo:rerun-if-changed=build.rs");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let bytes = if let Some(path) = env::var_os("SWB_NODE_RUNTIME_BUILD_IMAGE") {
        let path = PathBuf::from(path);
        assert!(path.is_absolute(), "Runtime build image must be absolute");
        println!("cargo:rerun-if-changed={}", path.display());
        let info = fs::symlink_metadata(&path).expect("Runtime build image metadata");
        assert!(
            info.is_file() && info.len() <= 16 * 1024,
            "Invalid runtime build image"
        );
        let mut bytes = Vec::new();
        fs::File::open(path)
            .expect("Open runtime build image")
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .expect("Read runtime build image");
        assert!(
            bytes.len() <= 16 * 1024,
            "Runtime build image exceeds its budget"
        );
        bytes
    } else {
        b"null".to_vec()
    };
    // 身份来自可信构建输入并编入 Host；安装目录内可替换的收据不能自行建立信任。
    fs::write(output.join("node-runtime-build-image.json"), bytes)
        .expect("Write runtime build image");
}
