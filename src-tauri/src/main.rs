// 正式构建使用 Windows GUI 子系统，避免启动时额外显示控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--extension-worker") {
        if std::env::args_os().len() != 2 {
            std::process::exit(2);
        }
        std::process::exit(serial_workbench_lib::extension_runtime::worker_main());
    }
    serial_workbench_lib::run();
}
