use super::{current_node_target, failure};
use serial_workbench_core::{HostResult, NodePackagePath, NodePackageTarget};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// 按同套打包器的安装布局定位；不读取当前目录、PATH、APPDIR 或用户工作区。
/// executable 是已知程序路径，product_name 是编译时配置，均不来自 RPC 参数。
pub fn resource_root_for_executable(
    executable: &Path,
    target: NodePackageTarget,
    product_name: &str,
) -> HostResult<PathBuf> {
    #[cfg(windows)]
    super::probe::initialize_headless_errors();
    if !executable.is_absolute() {
        return Err(failure("INVALID_ARGUMENT", "absoluteExecutableRequired"));
    }
    let name = NodePackagePath::try_from(product_name)
        .map_err(|_| failure("INVALID_ARGUMENT", "productDirectory"))?;
    if name.as_str().contains('/') || name.as_str().len() > 255 {
        return Err(failure("INVALID_ARGUMENT", "productDirectory"));
    }
    let executable = executable
        .canonicalize()
        .map_err(|_| failure("NODE_RUNTIME_MISSING", "installedExecutable"))?;
    if !fs::metadata(&executable).is_ok_and(|info| info.is_file()) {
        return Err(failure("NODE_RUNTIME_MISSING", "installedExecutable"));
    }
    let directory = executable
        .parent()
        .ok_or_else(|| failure("NODE_RUNTIME_MISSING", "installedLayout"))?;
    let root = if target == NodePackageTarget::WindowsX64 || directory.join(".cargo-lock").is_file()
    {
        // 未打包开发产物由 Tauri 将资源复制到实际 Cargo 输出目录。
        directory.to_path_buf()
    } else {
        match target {
            NodePackageTarget::MacosArm64 | NodePackageTarget::MacosX64 => {
                let contents = directory
                    .parent()
                    .filter(|parent| {
                        directory.file_name().is_some_and(|name| name == "MacOS")
                            && parent.file_name().is_some_and(|name| name == "Contents")
                    })
                    .ok_or_else(|| failure("NODE_RUNTIME_MISSING", "installedLayout"))?;
                contents.join("Resources")
            }
            NodePackageTarget::LinuxX64 => directory.join("..").join("lib").join(name.as_str()),
            NodePackageTarget::WindowsX64 => unreachable!("Windows uses its executable directory"),
        }
    };
    let root = root
        .canonicalize()
        .map_err(|_| failure("NODE_RUNTIME_MISSING", "resourceRoot"))?;
    if !fs::metadata(&root).is_ok_and(|info| info.is_dir()) {
        return Err(failure("NODE_RUNTIME_MISSING", "resourceRoot"));
    }
    Ok(root)
}

pub fn installed_node_resource_root() -> HostResult<PathBuf> {
    let executable = std::env::current_exe()
        .map_err(|_| failure("NODE_RUNTIME_MISSING", "installedExecutable"))?;
    // Cargo 跟踪 option_env! 的编译输入；自定义构建名称与 Linux 资源目录同步。
    let product_name = if let Some(name) = option_env!("SWB_RESOURCE_PRODUCT_NAME") {
        name.to_owned()
    } else {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../app.config.json"))
                .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "productConfiguration"))?;
        config
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| failure("NODE_RUNTIME_INCOMPATIBLE", "productConfiguration"))?
            .to_owned()
    };
    resource_root_for_executable(&executable, current_node_target()?, &product_name)
}
